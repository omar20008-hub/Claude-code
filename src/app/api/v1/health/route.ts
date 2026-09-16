import { NextResponse } from 'next/server';
import { sql as rawSql } from 'drizzle-orm';
import { db } from '@/server/db/client';
import { isN8nConfigured, isStorageConfigured } from '@/server/config/env';

/**
 * Liveness and readiness probe.
 *
 * Deliberately unauthenticated, and deliberately terse: an orchestrator needs
 * to know whether to route traffic here, and an attacker must learn nothing
 * about the deployment. No version string, no hostname, no dependency
 * addresses, no error detail — just up or not.
 *
 * The database check is the readiness gate: a process that cannot reach
 * Postgres can serve nothing useful and should be pulled from the pool.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const startedAt = Date.now();

  let databaseOk = false;
  try {
    await db.execute(rawSql`SELECT 1`);
    databaseOk = true;
  } catch {
    databaseOk = false;
  }

  const body = {
    status: databaseOk ? 'ok' : 'degraded',
    checks: {
      database: databaseOk ? 'ok' : 'down',
      // Configuration facts, not probes: a probe here would let an
      // unauthenticated caller make us call out to third parties.
      n8n: isN8nConfigured() ? 'configured' : 'not_configured',
      storage: isStorageConfigured() ? 'configured' : 'not_configured',
    },
    latencyMs: Date.now() - startedAt,
  };

  return NextResponse.json(body, {
    status: databaseOk ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
