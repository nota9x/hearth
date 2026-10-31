import { drizzle } from 'drizzle-orm/d1';

import * as schema from './schema.ts';

export const database = (binding: D1Database) => drizzle(binding, { schema });
export type Database = ReturnType<typeof database>;
export type User = typeof schema.users.$inferSelect;
