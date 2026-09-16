import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/server/auth/session';
import { listAssets } from '@/server/services/asset-service';
import { capabilitiesFor } from '@/server/agents/gateway';
import { isStorageConfigured } from '@/server/config/env';
import { CreativeStudio } from '@/components/creative/studio';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('creative');
  return { title: t('title') };
}

/**
 * Creative Studio (§18).
 *
 * `videoSupported` is read from the adapter, which reports false because the
 * connected workflow's agent is instructed never to choose video — the Veo
 * model on the linked Google account has no quota. The UI therefore disables
 * the video option and explains why, instead of accepting a request it knows
 * will come back as a still image (§52).
 */
export default async function CreativePage() {
  const session = await requireSession();

  const capability = capabilitiesFor('CREATIVE_AGENT');
  const videoGap = capability.unavailable.find((gap) => gap.capability === 'video_generation');

  const recent = await listAssets({
    organizationId: session.organizationId,
    limit: 8,
    sort: 'newest',
  });

  return (
    <CreativeStudio
      configured={capability.configured}
      storageConfigured={isStorageConfigured()}
      videoSupported={!videoGap}
      recentAssets={recent.items.map((asset) => ({
        id: asset.id,
        title: asset.title,
        kind: asset.kind,
        createdAt: asset.createdAt.toISOString(),
      }))}
    />
  );
}
