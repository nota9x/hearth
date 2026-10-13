import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { expect, it } from 'vitest';

import { POST as actionHandler } from '../../apps/web/src/routes/api/actions/[action]/+server';
import {
  authenticateSession,
  createSession,
  createUser,
} from '../../packages/core/auth';
import { database } from '../../packages/core/db';
import { users } from '../../packages/core/schema';
import { migrateDatabase } from '../helpers/database';

it('atomically retains an active administrator and its session when two authorized disablements race', async () => {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    }),
  );
  try {
    const binding = await runtime.getD1Database('DB');
    await migrateDatabase(binding);
    await createUser(binding, 'First admin', 'admin', null);
    await createUser(binding, 'Second admin', 'admin', null);
    const administrators = await database(binding).select().from(users);
    const tokens = await Promise.all(
      administrators.map((user) => createSession(binding, user.id, 1)),
    );
    let arrived = 0;
    let release!: () => void;
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- The repository targets ES2022.
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const DB: D1Database = {
      prepare: binding.prepare.bind(binding),
      exec: binding.exec.bind(binding),
      dump: binding.dump.bind(binding),
      withSession: binding.withSession.bind(binding),
      async batch<T>(
        statements: D1PreparedStatement[],
      ): Promise<D1Result<T>[]> {
        if (++arrived === 2) release();
        await barrier;
        return binding.batch<T>(statements);
      },
    };
    const limit = { limit: () => Promise.resolve({ success: true }) };
    const env = { DB, MUTATION_LIMIT: limit, SENSITIVE_LIMIT: limit };
    const responses = await Promise.all(
      administrators.map(async (user) =>
        actionHandler({
          locals: { env, user },
          params: { action: 'user-update' },
          request: new Request(
            'https://app.example.com/api/actions/user-update',
            {
              method: 'POST',
              body: JSON.stringify({
                userId: user.id,
                displayName: user.displayName,
                status: 'disabled',
                quotaBytes: null,
              }),
            },
          ),
        } as unknown as Parameters<typeof actionHandler>[0]),
      ),
    );
    expect(arrived).toBe(2);
    expect(new Set(responses.map((response) => response.status))).toEqual(
      new Set([200, 409]),
    );
    const after = await database(binding).select().from(users);
    expect(after.filter((user) => user.status === 'active')).toHaveLength(1);
    expect(after.filter((user) => user.status === 'disabled')).toHaveLength(1);
    for (const [index, user] of administrators.entries()) {
      const current = after.find((row) => row.id === user.id)!;
      const session = await authenticateSession(binding, tokens[index]);
      expect(session?.id ?? null).toBe(
        current.status === 'active' ? user.id : null,
      );
    }
  } finally {
    await runtime.dispose();
  }
});
