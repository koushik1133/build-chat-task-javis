import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function Loading() {
  return <PageSkeleton stats={4} rows={8} wide={true} label="Loading contacts…" />;
}
