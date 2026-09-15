import { redirect } from 'next/navigation';
import { getSession } from '@/server/auth/session';

export default async function LocaleRootPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await getSession();

  // Authenticated users go to dashboard
  if (session) {
    redirect(`/${locale}/dashboard`);
  }

  // Unauthenticated users go to login
  redirect(`/${locale}/login`);
}
