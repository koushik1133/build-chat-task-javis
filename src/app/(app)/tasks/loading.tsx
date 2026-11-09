import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function Loading() {
  return <PageSkeleton stats={0} rows={6} wide={false} label="Loading tasks…" />;
}
