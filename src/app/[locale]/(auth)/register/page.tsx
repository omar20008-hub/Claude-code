import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getSession } from '@/server/auth/session';
import { RegisterForm } from './register-form';

export async function generateMetadata() {
  const t = await getTranslations('auth.register');
  return { title: t('title') };
}

export default async function RegisterPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await getSession();
  if (session) redirect(`/${locale}/dashboard`);

  return <RegisterForm />;
}
