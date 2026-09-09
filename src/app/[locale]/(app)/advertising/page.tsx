import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/server/auth/session';
import { listAssets } from '@/server/services/asset-service';
import { capabilitiesFor } from '@/server/agents/gateway';
import { META_CONFIG } from '@/server/agents/adapters/advertising';
import { CampaignWizard } from '@/components/advertising/wizard';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const t = await getTranslations('advertising');
  return { title: t('title') };
}

export default async function AdvertisingPage() {
  const session = await requireSession();
  const capability = capabilitiesFor('ADVERTISING_AGENT');

  // Only stored assets can be a creative; a pending or failed one has no bytes
  // for the workflow to validate.
  const assets = await listAssets({
    organizationId: session.organizationId,
    limit: 60,
    sort: 'newest',
  });

  return (
    <CampaignWizard
      configured={capability.configured}
      adAccountId={META_CONFIG.adAccountId}
      currency={META_CONFIG.currency}
      timezone={META_CONFIG.timezone}
      assets={assets.items.map((asset) => ({
        id: asset.id,
        title: asset.title,
        kind: asset.kind,
        width: asset.width,
        height: asset.height,
      }))}
    />
  );
}
