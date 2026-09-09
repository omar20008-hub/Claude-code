import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '@/server/config/env';
import * as schema from './schema';

/**
 * Postgres connection pool.
 *
 * Held on globalThis so Next's dev-mode module reloading does not open a new
 * pool on every edit and exhaust `max_connections`.
 */
declare global {
  // eslint-disable-next-line no-var
  var __aiwSql: postgres.Sql | undefined;
}

function createClient(): postgres.Sql {
  return postgres(env().DATABASE_URL, {
    max: env().DATABASE_POOL_MAX,
    idle_timeout: 30,
    connect_timeout: 10,
    // postgres.js parameterises everything; this disables the prepared-statement
    // cache that transaction poolers (PgBouncer) cannot support.
    prepare: false,
    onnotice: () => {},
    types: {
      // Return bigint as JS number. Every bigint column here is a byte count,
      // an impression count or a minor-unit amount — all far below 2^53.
      bigint: postgres.BigInt,
    },
  });
}

export const sql: postgres.Sql = globalThis.__aiwSql ?? createClient();

if (env().NODE_ENV !== 'production') {
  globalThis.__aiwSql = sql;
}

export const db = drizzle(sql, { schema, logger: false });

export type Database = typeof db;

/** Transaction handle, as passed to `db.transaction(...)`. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Either the pool or an open transaction. Most services accept this. */
export type Executor = Database | Transaction;

export { schema };
