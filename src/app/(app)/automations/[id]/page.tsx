import type { Metadata } from "next";
import { AutomationEditor } from "@/components/automations/editor";

export const metadata: Metadata = { title: "Automation" };
export const dynamic = "force-dynamic";

export default async function AutomationEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AutomationEditor id={id} />;
}
