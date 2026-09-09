import { getTranslations } from 'next-intl/server';
import { ForgotPasswordForm } from './forgot-password-form';

export async function generateMetadata() {
  const t = await getTranslations('auth.forgotPassword');
  return { title: t('title') };
}

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
