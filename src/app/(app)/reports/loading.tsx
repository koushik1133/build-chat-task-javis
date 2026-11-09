import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function Loading() {
  return <PageSkeleton stats={4} rows={4} wide={true} label="Loading reports…" />;
}
