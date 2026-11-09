import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function Loading() {
  return <PageSkeleton stats={3} rows={6} wide label="Loading automations…" />;
}
