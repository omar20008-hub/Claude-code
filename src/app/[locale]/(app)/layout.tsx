import { redirect } from 'next/navigation';
import { getSession } from '@/server/auth/session';
import { AppShell } from '@/components/app-shell';

/**
 * Authenticated route group.
 *
 * This is the authoritative auth boundary for every page under it. Deliberately
 * a layout rather than middleware: validating a session needs a database read,
 * which does not belong in edge middleware that runs on every asset request.
 *
 * Server Components below this layout can rely on a session existing, but each
 * still scopes its own queries by `organizationId` — this check establishes
 * *who* the caller is, not what they may read.
 */
export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await getSession();

  if (!session) {
    // Locale-prefixed so an unauthenticated Arabic user lands on the Arabic
    // sign-in page rather than being re-negotiated by the middleware.
    redirect(`/${locale}/login`);
  }

  return (
    <AppShell
      user={{
        name: session.name,
        email: session.email,
        organizationName: session.organizationName,
      }}
    >
      {children}
    </AppShell>
  );
}
