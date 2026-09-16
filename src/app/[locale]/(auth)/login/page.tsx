import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getSession } from '@/server/auth/session';
import { LoginForm } from './login-form';

export async function generateMetadata() {
  const t = await getTranslations('auth.login');
  return { title: t('title') };
}

export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  // Already signed in: skip the form rather than letting someone create a
  // second session over the top of a live one.
  const session = await getSession();
  if (session) redirect(`/${locale}/dashboard`);

  return <LoginForm />;
}
