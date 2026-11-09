import Link from "next/link";
import { Store } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ShopNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-4 py-16 text-center sm:py-24">
      <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-muted-foreground" aria-hidden>
        <Store className="h-6 w-6" />
      </span>
      <h1 className="text-balance text-xl font-semibold tracking-tight">This shop is not available</h1>
      <p className="mt-2 text-pretty text-sm text-muted-foreground">The link may be wrong, or the shop has been switched off. If you followed a link from an email, check it was copied in full.</p>
      <Button asChild variant="outline" touch className="mt-6">
        <Link href="/">Go to the homepage</Link>
      </Button>
    </div>
  );
}
