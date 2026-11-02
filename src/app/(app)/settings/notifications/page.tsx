import Link from "next/link";
import { Inbox } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { PushToggle } from "@/components/pwa/push-toggle";
import { InstallHint } from "@/components/pwa/install-hint";

export const metadata = { title: "Notifications · Settings" };

export default function NotificationSettingsPage() {
  return (
    <PageContainer
      title="Notifications"
      description="Choose how KernelHub reaches you when something needs attention."
      tooltip="Push notifications are per device: enable them on each phone or computer you use. Email, SMS and in-app alerts are managed in the Outbox."
    >
      <div className="space-y-4">
        <PushToggle />
        <InstallHint />
        <div className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground sm:p-5">
          <div className="flex items-start gap-3">
            <Inbox className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>
              Every message the platform sends (email, SMS, WhatsApp, in-app, webhooks) is listed with its delivery status in the{" "}
              <Link href="/settings/outbox" className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">
                Outbox
              </Link>
              .
            </p>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
