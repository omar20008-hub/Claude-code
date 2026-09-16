import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '@/server/config/env';
import * as schema from './schema';

/**
 * Postgres connection pool.
 *
 * LAZY BY DESIGN. Nothing here reads the environment or opens a socket at
 * import time. Two reasons:
 *
 *  1. `next build` imports every route module to collect page data. If this
 *     module validated DATABASE_URL on import, a production build would need
 *     production secrets — which is both a supply-chain smell and impossible in
 *     a CI job that legitimately has none.
 *  2. Serverless cold starts pay for a pool they may never use.
 *
 * The Proxy defers `postgres()` until the first property access, which is the
 * first actual query.
 *
 * The instance is cached on globalThis so Next's dev-mode module reloading does
 * not open a new pool on every edit and exhaust `max_connections`.
 */
declare global {
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

function realSql(): postgres.Sql {
  if (!globalThis.__aiwSql) {
    globalThis.__aiwSql = createClient();
  }
  return globalThis.__aiwSql;
}

/**
 * The postgres.js client. Callable and indexable exactly like the real thing;
 * the underlying connection is created on first use.
 */
export const sql: postgres.Sql = new Proxy((() => {}) as unknown as postgres.Sql, {
  get(_target, property, receiver) {
    return Reflect.get(realSql(), property, receiver);
  },
  apply(_target, thisArg, args) {
    return Reflect.apply(realSql() as unknown as (...a: unknown[]) => unknown, thisArg, args);
  },
  has(_target, property) {
    return Reflect.has(realSql(), property);
  },
});

let drizzleInstance: ReturnType<typeof drizzle<typeof schema>> | undefined;

function realDb(): ReturnType<typeof drizzle<typeof schema>> {
  drizzleInstance ??= drizzle(realSql(), { schema, logger: false });
  return drizzleInstance;
}

export type Database = ReturnType<typeof drizzle<typeof schema>>;

/** Drizzle client, initialised on first query for the same reasons as `sql`. */
export const db: Database = new Proxy({} as Database, {
  get(_target, property, receiver) {
    return Reflect.get(realDb(), property, receiver);
  },
  has(_target, property) {
    return Reflect.has(realDb(), property);
  },
});

/** Transaction handle, as passed to `db.transaction(...)`. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Either the pool or an open transaction. Most services accept this. */
export type Executor = Database | Transaction;

export { schema };
