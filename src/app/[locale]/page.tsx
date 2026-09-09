import { redirect } from 'next/navigation';

/**
 * Locale root.
 *
 * Sends anyone landing on `/ar` or `/en` to the dashboard, which then either
 * renders or bounces to sign-in depending on the session. Keeping the decision
 * in one place means there is no second, drifting copy of the auth check.
 */
export default async function LocaleRootPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(`/${locale}/dashboard`);
}
