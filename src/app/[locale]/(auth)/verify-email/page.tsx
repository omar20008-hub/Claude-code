import { getTranslations } from 'next-intl/server';
import { VerifyEmailClient } from './verify-email-client';

export async function generateMetadata() {
  const t = await getTranslations('auth.verifyEmail');
  return { title: t('title') };
}

/**
 * Email verification landing page.
 *
 * The token arrives in the query string, and redemption happens through a POST
 * from the client rather than during this server render. That matters: link
 * scanners in mail clients and corporate gateways fetch URLs eagerly, and a
 * GET that consumed the token would burn it before the recipient ever clicked.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return <VerifyEmailClient token={token ?? null} />;
}
