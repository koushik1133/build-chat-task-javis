import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function Loading() {
  return <PageSkeleton stats={0} rows={8} wide={true} label="Loading tickets…" />;
}
