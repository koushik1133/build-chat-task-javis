import type { Metadata } from "next";
import { AutomationsClient } from "@/components/automations/automations-client";

export const metadata: Metadata = { title: "Automations" };
export const dynamic = "force-dynamic";

export default function AutomationsPage() {
  return <AutomationsClient />;
}
