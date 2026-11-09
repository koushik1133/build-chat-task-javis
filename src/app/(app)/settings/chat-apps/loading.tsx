import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function Loading() {
  return <PageSkeleton stats={0} rows={4} label="Loading chat apps…" />;
}
