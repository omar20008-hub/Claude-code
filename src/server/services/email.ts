import { env } from '@/server/config/env';
import { logger } from '@/server/observability/logger';
import type { Locale } from '@/i18n/config';

/**
 * Transactional email.
 *
 * Two transports:
 *  - `log` (development default): the message is written to the structured log,
 *    including the link, so a developer can complete a verification flow without
 *    an SMTP server. It is loud about the fact that nothing was actually sent —
 *    a silently-dropped verification email is a bug that surfaces days later.
 *  - `smtp`: the production path.
 *
 * Bodies are composed here rather than in the i18n catalogue because they are
 * not UI strings — they are sent to an address whose owner's language we know
 * from their profile, and they need plain-text and HTML variants.
 */

export type EmailTemplate = 'verify-email' | 'reset-password';

export interface SendEmailParams {
  to: string;
  locale: Locale;
  template: EmailTemplate;
  params: Record<string, string>;
}

interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const TEMPLATES: Record<
  EmailTemplate,
  Record<Locale, (p: Record<string, string>) => RenderedEmail>
> = {
  'verify-email': {
    ar: (p) => ({
      subject: 'وثّق بريدك الإلكتروني',
      text: `مرحبًا ${p.name},\n\nلتفعيل حسابك، افتح الرابط التالي:\n${p.url}\n\nالرابط صالح لمدة ٢٤ ساعة. إذا لم تنشئ هذا الحساب، تجاهل هذه الرسالة.`,
      html: htmlShell(
        'ar',
        `<p>مرحبًا ${escapeHtml(p.name ?? '')},</p>
         <p>لتفعيل حسابك في منصة القوى العاملة الذكية، اضغط على الزر التالي:</p>
         <p><a class="button" href="${escapeAttr(p.url ?? '')}">تفعيل الحساب</a></p>
         <p class="muted">الرابط صالح لمدة ٢٤ ساعة. إذا لم تنشئ هذا الحساب، تجاهل هذه الرسالة.</p>`,
      ),
    }),
    en: (p) => ({
      subject: 'Verify your email address',
      text: `Hello ${p.name},\n\nActivate your account by opening this link:\n${p.url}\n\nThe link is valid for 24 hours. If you didn't create this account, ignore this message.`,
      html: htmlShell(
        'en',
        `<p>Hello ${escapeHtml(p.name ?? '')},</p>
         <p>Activate your AI Workforce account by clicking the button below:</p>
         <p><a class="button" href="${escapeAttr(p.url ?? '')}">Activate account</a></p>
         <p class="muted">The link is valid for 24 hours. If you didn't create this account, ignore this message.</p>`,
      ),
    }),
  },
  'reset-password': {
    ar: (p) => ({
      subject: 'إعادة تعيين كلمة المرور',
      text: `مرحبًا ${p.name},\n\nلإعادة تعيين كلمة المرور، افتح الرابط التالي:\n${p.url}\n\nالرابط صالح لمدة ساعة واحدة. إذا لم تطلب ذلك، تجاهل هذه الرسالة — كلمة مرورك لم تتغير.`,
      html: htmlShell(
        'ar',
        `<p>مرحبًا ${escapeHtml(p.name ?? '')},</p>
         <p>وصلنا طلب لإعادة تعيين كلمة مرورك. اضغط الزر التالي لاختيار كلمة مرور جديدة:</p>
         <p><a class="button" href="${escapeAttr(p.url ?? '')}">إعادة تعيين كلمة المرور</a></p>
         <p class="muted">الرابط صالح لمدة ساعة واحدة. إذا لم تطلب ذلك، تجاهل هذه الرسالة — كلمة مرورك لم تتغير.</p>`,
      ),
    }),
    en: (p) => ({
      subject: 'Reset your password',
      text: `Hello ${p.name},\n\nReset your password by opening this link:\n${p.url}\n\nThe link is valid for one hour. If you didn't request this, ignore this message — your password has not changed.`,
      html: htmlShell(
        'en',
        `<p>Hello ${escapeHtml(p.name ?? '')},</p>
         <p>We received a request to reset your password. Click below to choose a new one:</p>
         <p><a class="button" href="${escapeAttr(p.url ?? '')}">Reset password</a></p>
         <p class="muted">The link is valid for one hour. If you didn't request this, ignore this message — your password has not changed.</p>`,
      ),
    }),
  },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Escapes a URL for an href, refusing anything but http(s). */
function escapeAttr(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '#';
    return escapeHtml(url.toString());
  } catch {
    return '#';
  }
}

function htmlShell(locale: Locale, body: string): string {
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const font =
    locale === 'ar'
      ? "'Segoe UI', Tahoma, 'Noto Naskh Arabic', sans-serif"
      : "'Segoe UI', Helvetica, Arial, sans-serif";

  // Email clients need inline-ish styles and table-safe markup; logical
  // properties are not reliable here, so `dir` carries the layout.
  return `<!doctype html>
<html lang="${locale}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f5f6f8;font-family:${font};line-height:1.7;color:#1f2937;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
    ${body}
  </div>
  <style>
    .button{display:inline-block;background:#0e7b4a;color:#ffffff !important;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;}
    .muted{color:#6b7280;font-size:14px;}
  </style>
</body>
</html>`;
}

export async function sendEmail(params: SendEmailParams): Promise<void> {
  const renderer = TEMPLATES[params.template][params.locale];
  const rendered = renderer(params.params);

  if (env().EMAIL_TRANSPORT === 'log') {
    // Deliberately at warn: in production this would mean mail is not being
    // delivered, which an operator must notice.
    logger.warn(
      {
        transport: 'log',
        to: params.to,
        subject: rendered.subject,
        // The link is the point of the log line in development.
        body: rendered.text,
      },
      'email not sent — EMAIL_TRANSPORT is "log"',
    );
    return;
  }

  const smtpUrl = env().SMTP_URL;
  if (!smtpUrl) {
    // Fail loudly rather than pretending to have sent. Callers treat this as a
    // real failure of the flow that needed the mail.
    logger.error(
      { to: params.to, template: params.template },
      'EMAIL_TRANSPORT is "smtp" but SMTP_URL is unset — mail was not sent',
    );
    throw new Error('SMTP transport selected but SMTP_URL is not configured');
  }

  // Deliberately not implemented with a bundled SMTP client: choosing one is a
  // deployment decision (SES, Postmark, Resend, a relay). docs/deployment.md
  // documents the one function to implement here. Until then the process
  // refuses to claim a message was delivered.
  throw new Error(
    'SMTP delivery is not wired up. Implement sendEmail() for your provider — see docs/deployment.md, "Email".',
  );
}
