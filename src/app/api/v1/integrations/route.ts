import { eq } from 'drizzle-orm';
import { route, jsonResponse } from '@/server/api/handler';
import { withTenant } from '@/server/tenancy/context';
import { integrations } from '@/server/db/schema';
import { allCapabilities } from '@/server/agents/gateway';
import { probeN8n } from '@/server/agents/n8n-client';
import { getKnowledgeSourceStatus } from '@/server/services/knowledge-service';
import { isN8nConfigured, isStorageConfigured, env } from '@/server/config/env';
import { META_CONFIG } from '@/server/agents/adapters/advertising';
import {
  KNOWLEDGE_DRIVE_FOLDER_ID,
  KNOWLEDGE_DRIVE_FOLDER_NAME,
  KNOWLEDGE_REINDEX_INTERVAL_HOURS,
} from '@/server/agents/adapters/knowledge';

/**
 * Integration status (§17, §23).
 *
 * NOTHING SECRET CROSSES THIS BOUNDARY. Google and Meta credentials live inside
 * the n8n workflows, not in this application, and the n8n webhook URLs are
 * server-side configuration. What the browser gets is: whether a connection is
 * working, which account or folder it points at, and when it was last checked.
 *
 * `credentialOwner: 'n8n'` is returned so the UI can state plainly where the
 * credential actually lives rather than implying this workspace holds it.
 */
export const GET = route({}, async ({ session, correlationId }) => {
  const [rows, knowledgeSource, n8nProbe] = await Promise.all([
    withTenant({ organizationId: session.organizationId }, (tx) =>
      tx
        .select()
        .from(integrations)
        .where(eq(integrations.organizationId, session.organizationId)),
    ),
    getKnowledgeSourceStatus(session.organizationId),
    isN8nConfigured() ? probeN8n().catch(() => null) : Promise.resolve(null),
  ]);

  const capabilities = allCapabilities();
  const byKind = new Map(rows.map((row) => [row.kind, row]));

  return jsonResponse(
    {
      googleDrive: {
        status: byKind.get('GOOGLE_DRIVE')?.status ?? 'NOT_CONFIGURED',
        folderId: KNOWLEDGE_DRIVE_FOLDER_ID,
        folderName: KNOWLEDGE_DRIVE_FOLDER_NAME,
        reindexIntervalHours: KNOWLEDGE_REINDEX_INTERVAL_HOURS,
        supportedFormats: knowledgeSource?.supportedFormats ?? [],
        documentCount: knowledgeSource?.documentCount ?? null,
        lastSyncedAt: knowledgeSource?.lastSyncedAt ?? null,
        lastSyncStatus: knowledgeSource?.lastSyncStatus ?? null,
        recentFailures: knowledgeSource?.recentFailures ?? 0,
        // The OAuth token is held by the n8n credential store; this app has none.
        credentialOwner: 'n8n',
      },
      meta: {
        status: byKind.get('META_ADS')?.status ?? 'NOT_CONFIGURED',
        adAccountId: META_CONFIG.adAccountId,
        pageId: META_CONFIG.pageId,
        apiVersion: META_CONFIG.apiVersion,
        currency: META_CONFIG.currency,
        credentialOwner: 'n8n',
        // Declared limits, from the adapter rather than from UI copy.
        limitations: capabilities
          .find((c) => c.agent === 'ADVERTISING_AGENT')
          ?.unavailable.map((u) => u.reasonKey),
      },
      n8n: {
        status: !isN8nConfigured()
          ? 'NOT_CONFIGURED'
          : n8nProbe?.reachable
            ? 'CONNECTED'
            : 'ERROR',
        reachable: n8nProbe?.reachable ?? false,
        latencyMs: n8nProbe?.latencyMs ?? null,
        // Workflow IDs are operator-facing identifiers, not secrets. The base
        // URL and webhook ids are NOT returned.
        workflows: {
          knowledge: env().N8N_KNOWLEDGE_WORKFLOW_ID ?? null,
          creative: env().N8N_CREATIVE_WORKFLOW_ID ?? null,
          advertising: env().N8N_ADVERTISING_WORKFLOW_ID ?? null,
        },
      },
      storage: {
        configured: isStorageConfigured(),
      },
      agents: capabilities,
    },
    correlationId,
  );
});
