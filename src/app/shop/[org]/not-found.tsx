import Link from "next/link";
import { Store } from "lucide-react";

export default function ShopNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-4 py-20 text-center">
      <Store className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden />
      <h1 className="text-xl font-semibold tracking-tight">This shop is not available</h1>
      <p className="mt-2 text-sm text-muted-foreground">The link may be wrong, or the shop has been switched off.</p>
      <Link href="/" className="mt-6 text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Go to the homepage
      </Link>
    </div>
  );
}
