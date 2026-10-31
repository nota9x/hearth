import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

import { execa } from 'execa';
import { z } from 'zod';

import { root } from '../production-config.ts';
import { dashboard } from './dashboard.ts';
import { setupDirectory } from './state.ts';

export type FailureKind =
  'authentication' | 'permission' | 'transient' | 'configuration' | 'quota';
export class SetupFailure extends Error {
  readonly kind: FailureKind;
  readonly dashboard?: string;
  readonly retryAfter?: number;
  constructor(
    message: string,
    kind: FailureKind = 'configuration',
    dashboard?: string,
    retryAfter?: number,
  ) {
    super(message);
    this.kind = kind;
    this.dashboard = dashboard;
    this.retryAfter = retryAfter;
    this.name = 'SetupFailure';
  }
}
export function redact(text: string, secrets: Iterable<string> = []) {
  let safe = text;
  for (const secret of secrets)
    if (secret) safe = safe.replaceAll(secret, '[redacted]');
  return safe
    .replaceAll(/img_live_[a-f0-9]{32}_[a-f0-9]{64}/g, '[Hearth key]')
    .replaceAll(/(Bearer\s+)[\w.-]+/gi, '$1[redacted]')
    .replaceAll(/([?&](?:token|signature|secret)=)[^\s&#]+/gi, '$1[redacted]')
    .replaceAll(
      /((?:secret|token|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      '$1[redacted]',
    );
}
export function classifyFailure(message: string): FailureKind {
  if (/exceeded|quota|limit reached|billing|not entitled/i.test(message))
    return 'quota';
  if (
    /unauthenticated|authentication|expired|invalid.*token|9106|10405/i.test(
      message,
    )
  )
    return 'authentication';
  if (/permission|forbidden|not authorized|10000|403/i.test(message))
    return 'permission';
  return /timeout|timed out|ECONN|ENOTFOUND|fetch failed|network|429|50[0234]|temporar/i.test(
    message,
  )
    ? 'transient'
    : 'configuration';
}
export const identitySchema = z.object({
  loggedIn: z.literal(true),
  authType: z.string(),
  accounts: z.array(z.object({ id: z.string(), name: z.string() })),
  tokenPermissions: z.array(z.string()).optional(),
});
export const databaseSchema = z.object({ uuid: z.string(), name: z.string() });
export const widgetSchema = z.object({
  sitekey: z.string(),
  name: z.string(),
  domains: z.array(z.string()),
  mode: z.string(),
  clearance_level: z.string().optional(),
  secret: z.string().optional(),
});
export type Widget = z.infer<typeof widgetSchema>;
export const settingsSchema = z.looseObject({
  bindings: z
    .array(
      z.looseObject({
        name: z.string(),
        type: z.string(),
        id: z.string().optional(),
        bucket_name: z.string().optional(),
        service: z.string().optional(),
        class_name: z.string().optional(),
        script_name: z.string().optional(),
        text: z.string().optional(),
        namespace_id: z.union([z.string(), z.number()]).optional(),
        simple: z.object({ limit: z.number(), period: z.number() }).optional(),
      }),
    )
    .default([]),
  compatibility_date: z.string().optional(),
  compatibility_flags: z.array(z.string()).optional(),
});
export type WorkerSettings = z.infer<typeof settingsSchema>;
export const workerDomainSchema = z.object({
  hostname: z.string(),
  service: z.string(),
  zone_id: z.string().optional(),
});
export class Cloudflare {
  private environmentReady = false;
  readonly executable: string;
  readonly secrets = new Set<string>();
  readonly controller = new AbortController();
  accountId?: string;
  token?: string;
  environment: Record<string, string | undefined>;
  readonly diagnostics = path.join(setupDirectory, 'diagnostics.log');
  readonly envFile = path.join(setupDirectory, 'empty.env');
  constructor(
    environment: Record<string, string | undefined> = process.env,
    executable = path.join(root, 'node_modules/wrangler/bin/wrangler.js'),
  ) {
    this.executable = executable;
    this.environment =
      process.platform === 'win32'
        ? Object.fromEntries(
            Object.entries(environment).map(([key, value]) => [
              key.toUpperCase(),
              value,
            ]),
          )
        : { ...environment };
    const manager = environment.npm_execpath ?? environment.NPM_EXECPATH;
    const userAgent =
      environment.npm_config_user_agent ?? environment.NPM_CONFIG_USER_AGENT;
    delete this.environment.NPM_EXECPATH;
    delete this.environment.NPM_CONFIG_USER_AGENT;
    this.environment.npm_execpath = manager;
    this.environment.npm_config_user_agent = userAgent;
    for (const key of [
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_API_KEY',
      'CF_API_TOKEN',
      'CF_API_KEY',
    ]) {
      const value = this.environment[key];
      if (value) this.secrets.add(value);
    }
  }
  get env(): Record<string, string | undefined> {
    return {
      ...this.environment,
      CLOUDFLARE_ACCOUNT_ID: this.accountId,
      CF_ACCOUNT_ID: undefined,
      CLOUDFLARE_ENV: undefined,
      WRANGLER_WRITE_LOGS: 'false',
      WRANGLER_LOG: 'log',
      WRANGLER_LOG_SANITIZE: 'true',
      WRANGLER_OUTPUT_FILE_PATH: undefined,
      WRANGLER_OUTPUT_FILE_DIRECTORY: undefined,
    };
  }
  async diagnostic(label: string, detail: string) {
    await mkdir(setupDirectory, { recursive: true });
    await appendFile(
      this.diagnostics,
      `${new Date().toISOString()} ${label}\n${redact(detail, this.secrets)}\n`,
      { mode: 0o600 },
    );
  }
  async run(
    arguments_: string[],
    options: {
      config?: string;
      sensitive?: boolean;
      input?: string;
      interactive?: boolean;
      outputFile?: string;
    } = {},
  ) {
    if (!this.environmentReady) {
      await mkdir(setupDirectory, { recursive: true });
      await writeFile(this.envFile, '', { mode: 0o600 });
      this.environmentReady = true;
    }
    const arguments__ = [
      ...arguments_,
      ...(options.config ? ['--config', options.config] : []),
      '--env-file',
      this.envFile,
    ];
    const environment = {
      ...this.env,
      ...(!['whoami', 'auth', 'login'].includes(arguments_[0]) &&
        this.token && { CLOUDFLARE_API_TOKEN: this.token }),
      WRANGLER_OUTPUT_FILE_PATH: options.outputFile,
    };
    const running = execa(process.execPath, [this.executable, ...arguments__], {
      cwd: root,
      env: environment,
      extendEnv: false,
      shell: false,
      reject: false,
      ...(options.interactive
        ? { stdio: 'inherit' as const }
        : {
            stdin:
              options.input === undefined
                ? ('ignore' as const)
                : ('pipe' as const),
            input: options.input,
          }),
      cancelSignal: this.controller.signal,
      killDescendants: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    let result: Awaited<typeof running>;
    try {
      result = await running;
    } catch {
      throw new SetupFailure(
        'The Cloudflare process could not complete. Check network/tooling and retry.',
        'transient',
      );
    }
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (!options.sensitive && !options.interactive)
      await this.diagnostic(arguments_.slice(0, 3).join(' '), output);
    if (result.exitCode !== 0) {
      const kind = classifyFailure(output);
      const message = options.sensitive
        ? `Cloudflare could not complete ${arguments_.slice(0, 3).join(' ')} (${kind}). Sensitive output was suppressed.`
        : `Cloudflare could not complete ${arguments_.slice(0, 3).join(' ')} (${kind}). ${redact(output, this.secrets).trim().slice(-1200)}`;
      throw new SetupFailure(message, kind, dashboard(this.accountId));
    }
    return result.stdout ?? '';
  }
  async json<T>(
    arguments_: string[],
    schema: z.ZodType<T>,
    options: { config?: string; sensitive?: boolean } = {},
  ): Promise<T> {
    const output = await this.run(arguments_, options);
    try {
      return schema.parse(JSON.parse(output));
    } catch {
      throw new SetupFailure(
        `Wrangler returned an unexpected structured result for ${arguments_.slice(0, 3).join(' ')}. Restore the locked tooling and retry.`,
      );
    }
  }
  async identify() {
    return this.json(['whoami', '--json'], identitySchema);
  }
  async credentials() {
    const result = await this.json(
      ['auth', 'token', '--json'],
      z.object({
        type: z.enum(['oauth', 'api_token', 'api_key']),
        token: z.string().optional(),
      }),
      { sensitive: true },
    );
    if (!result.token)
      throw new SetupFailure(
        'Use Wrangler browser login or a scoped API token for setup. Global API keys cannot initialize remote bindings.',
        'authentication',
      );
    this.token = result.token;
    this.secrets.add(result.token);
  }
  browserAuthentication() {
    this.token = undefined;
    for (const key of [
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_API_KEY',
      'CLOUDFLARE_EMAIL',
      'CF_API_TOKEN',
      'CF_API_KEY',
      'CF_EMAIL',
    ])
      delete this.environment[key];
  }
  useToken(token: string) {
    this.browserAuthentication();
    this.environment.CLOUDFLARE_API_TOKEN = token;
    this.secrets.add(token);
  }
  async api<T>(
    resource: string,
    schema: z.ZodType<T>,
    options: {
      body?: unknown;
      method?: 'GET' | 'PUT' | 'POST' | 'DELETE';
      missing?: boolean;
      pagination?: { cursor?: string };
    } = {},
  ): Promise<T | undefined> {
    if (!this.token)
      throw new SetupFailure(
        'Cloudflare authentication must be refreshed.',
        'authentication',
      );
    let response: Response;
    try {
      response = await fetch(
        `https://api.cloudflare.com/client/v4${resource}`,
        {
          method:
            options.method ?? (options.body === undefined ? 'GET' : 'PUT'),
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
          signal: AbortSignal.any([
            this.controller.signal,
            AbortSignal.timeout(30_000),
          ]),
          redirect: 'error',
        },
      );
    } catch {
      throw new SetupFailure(
        'Cloudflare could not be reached. Check your connection and retry.',
        'transient',
      );
    }
    if (options.missing && response.status === 404) return undefined;
    if (response.ok && response.status === 204) return schema.parse(null);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SetupFailure(
        `Cloudflare returned an unreadable response (${response.status}). Retry after checking service status.`,
        response.status >= 500 ? 'transient' : 'configuration',
      );
    }
    const envelope = z
      .object({
        success: z.boolean(),
        result: z.unknown(),
        result_info: z.object({ cursor: z.string().nullish() }).nullish(),
        errors: z
          .array(z.object({ code: z.number(), message: z.string() }))
          .nullish(),
      })
      .safeParse(payload);
    if (response.ok && !envelope.success)
      throw new SetupFailure(
        `Cloudflare returned an unexpected response envelope for ${resource} (HTTP ${response.status}; invalid fields: ${envelope.error.issues.map((issue) => issue.path.join('.') || 'response').join(', ')}). Report this setup/API response format mismatch.`,
      );
    if (!response.ok || !envelope.success || !envelope.data.success) {
      const messages = envelope.success
        ? (envelope.data.errors
            ?.map((error) => `${error.code}: ${error.message}`)
            .join('; ') ?? '')
        : '';
      const kind =
        response.status === 401
          ? 'authentication'
          : response.status === 403
            ? 'permission'
            : response.status === 429 || response.status >= 500
              ? 'transient'
              : classifyFailure(messages);
      const retryHeader = Number(response.headers.get('retry-after'));
      throw new SetupFailure(
        `Cloudflare ${response.status}: ${redact(messages, this.secrets) || 'request failed'}.`,
        kind,
        this.accountId ? dashboard(this.accountId) : undefined,
        Number.isFinite(retryHeader)
          ? Math.min(retryHeader * 1000, 60_000)
          : undefined,
      );
    }
    const parsed = schema.safeParse(envelope.data.result);
    if (!parsed.success)
      throw new SetupFailure(
        `Cloudflare returned an unexpected result for ${resource} (HTTP ${response.status}). Report this setup/API response format mismatch.`,
      );
    if (options.pagination)
      options.pagination.cursor =
        envelope.data.result_info?.cursor ?? undefined;
    return parsed.data;
  }
  async pages<T>(resource: string, schema: z.ZodType<T>): Promise<T[]> {
    const results: T[] = [];
    for (let page = 1; ; page++) {
      if (!this.token)
        throw new SetupFailure(
          'Cloudflare authentication must be refreshed.',
          'authentication',
        );
      const url = new URL(`https://api.cloudflare.com/client/v4${resource}`);
      url.searchParams.set('page', String(page));
      url.searchParams.set('per_page', '50');
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${this.token}` },
          signal: AbortSignal.any([
            this.controller.signal,
            AbortSignal.timeout(30_000),
          ]),
          redirect: 'error',
        });
      } catch {
        throw new SetupFailure(
          'Cloudflare discovery could not reach the network. Retry after checking your connection.',
          'transient',
        );
      }
      if (!response.ok)
        throw new SetupFailure(
          `Cloudflare discovery returned ${response.status}. Check zone/account permissions and retry.`,
          response.status === 403
            ? 'permission'
            : response.status === 401
              ? 'authentication'
              : 'transient',
        );
      const parsed = z
        .object({
          success: z.literal(true),
          result: z.array(schema),
          result_info: z
            .object({ total_pages: z.number().optional() })
            .optional(),
        })
        .parse(await response.json());
      results.push(...parsed.result);
      if (
        page >= (parsed.result_info?.total_pages ?? page) &&
        parsed.result.length < 50
      )
        break;
      if (
        parsed.result_info?.total_pages &&
        page >= parsed.result_info.total_pages
      )
        break;
    }
    return results;
  }
  async buckets() {
    const buckets: { name: string }[] = [];
    const pagination: { cursor?: string } = {};
    do {
      const page = await this.api(
        `/accounts/${this.accountId}/r2/buckets?per_page=1000${pagination.cursor ? `&cursor=${encodeURIComponent(pagination.cursor)}` : ''}`,
        z.object({
          buckets: z.array(z.object({ name: z.string() })).default([]),
        }),
        { pagination },
      );
      if (!page)
        throw new SetupFailure(
          'Cloudflare did not return the bucket inventory.',
        );
      buckets.push(...page.buckets);
    } while (pagination.cursor);
    return buckets;
  }
  async assertPrivate(bucket: string) {
    const base = `/accounts/${this.accountId}/r2/buckets/${encodeURIComponent(bucket)}/domains`;
    const managed = await this.api(
      `${base}/managed`,
      z.object({ enabled: z.boolean() }),
    );
    const custom = await this.api(
      `${base}/custom`,
      z.object({
        domains: z.array(
          z.object({ domain: z.string(), enabled: z.boolean() }),
        ),
      }),
    );
    if (
      !managed ||
      !custom ||
      managed.enabled ||
      custom.domains.some((domain) => domain.enabled)
    )
      throw new SetupFailure(
        'This R2 bucket permits public access. Disable its r2.dev URL and enabled R2 Custom Domains, or choose a dedicated private bucket.',
        'configuration',
        dashboard(this.accountId, 'bucket-settings', bucket),
      );
  }
  async sql(config: string, command: string) {
    const rows = await this.json(
      ['d1', 'execute', 'DB', '--remote', '--command', command, '--json'],
      z.array(
        z.object({ results: z.array(z.record(z.string(), z.unknown())) }),
      ),
      { config },
    );
    return rows.flatMap((result) => result.results);
  }
  async createDatabase(name: string) {
    const database = await this.api(
      `/accounts/${this.accountId}/d1/database`,
      databaseSchema,
      { method: 'POST', body: { name } },
    );
    if (!database)
      throw new SetupFailure(
        'D1 creation could not be verified. Choose a new unused database name; existing resources cannot establish a fresh baseline.',
      );
    return database;
  }
  async worker(name: string) {
    return this.api(
      `/accounts/${this.accountId}/workers/scripts/${name}/settings`,
      settingsSchema,
      { missing: true },
    );
  }
  async activeVersion(name: string) {
    const result = await this.api(
      `/accounts/${this.accountId}/workers/scripts/${name}/deployments`,
      z.object({
        deployments: z.array(
          z.object({
            versions: z.array(
              z.object({ version_id: z.string(), percentage: z.number() }),
            ),
          }),
        ),
      }),
      { missing: true },
    );
    const versions = result?.deployments[0]?.versions;
    return versions?.length === 1 && versions[0].percentage === 100
      ? versions[0].version_id
      : undefined;
  }
  async deploy(config: string, name: string, fingerprint: string) {
    const output = path.join(setupDirectory, `deploy-${name}.ndjson`);
    await rm(output, { force: true });
    await this.run(
      [
        'deploy',
        '--tag',
        `hearth-${fingerprint.slice(0, 16)}`,
        '--message',
        `Hearth setup ${fingerprint}`,
      ],
      { config, outputFile: output, interactive: true },
    );
    const text = await readFile(output, 'utf8');
    const records = text
      .split('\n')
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line));
    const record = records
      .map((value) =>
        z
          .object({
            type: z.literal('deploy'),
            worker_name: z.literal(name),
            version_id: z.string().min(1),
          })
          .safeParse(value),
      )
      .find((value) => value.success);
    if (
      !record?.success ||
      (await this.activeVersion(name)) !== record.data.version_id
    )
      throw new SetupFailure(
        `The ${name} deployment could not be verified. Retry to reconcile its active version.`,
      );
    return record.data.version_id;
  }
  async build() {
    const result = await execa(
      this.environment.npm_execpath ?? 'pnpm',
      ['run', 'build'],
      {
        cwd: root,
        env: this.env,
        extendEnv: false,
        shell: false,
        reject: false,
        cancelSignal: this.controller.signal,
        killDescendants: true,
      },
    );
    await this.diagnostic('build', `${result.stdout}\n${result.stderr}`);
    if (result.exitCode !== 0)
      throw new SetupFailure(
        'The web build failed. Correct the error in artifacts/setup/diagnostics.log, then retry this step.',
      );
  }
}

export async function retryTransient<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof SetupFailure) ||
        error.kind !== 'transient' ||
        attempt >= 2 ||
        signal?.aborted
      )
        throw error;
      await setTimeout(error.retryAfter || [1000, 3000][attempt], undefined, {
        signal,
      });
    }
  }
}
