import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/supabase/server";
import { resolveDataId } from "@/lib/auth/session-scope";
import { AppShell } from "@/components/app-shell";
import { buildChannelNav } from "@/lib/nav/channel-nav";
import { CommandPalette } from "@/components/command-palette";
import { FeatureRequestButton } from "@/components/feature-request-button";
import { I18nProvider } from "@/components/i18n/provider";
import { getMessages } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/i18n/server";
import { getOrgSettings } from "@/lib/org-settings";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  if (!session) {
    const pathname = (await headers()).get("x-pathname") ?? "/chat";
    redirect(`/login?next=${encodeURIComponent(pathname)}`);
  }

  const email = session.user.email ?? "(no email)";

  // Server-rendered so the CHANNELS group is present in the first paint.
  const dataId = await resolveDataId(session.user.id);
  const [channels, locale, orgSettings] = await Promise.all([
    buildChannelNav(dataId),
    getRequestLocale(dataId),
    getOrgSettings(dataId).catch(() => ({ locale: "en" as const, currency: "USD", timezone: "UTC" })),
  ]);

  return (
    <I18nProvider locale={locale} messages={getMessages(locale)} currency={orgSettings.currency} timezone={orgSettings.timezone}>
      <AppShell userEmail={email} channels={channels}>
        {children}
      </AppShell>
      <CommandPalette />
      <FeatureRequestButton />
    </I18nProvider>
  );
}
