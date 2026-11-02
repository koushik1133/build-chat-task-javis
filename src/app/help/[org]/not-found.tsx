import Link from "next/link";

export default function HelpNotFound() {
  return (
    <div className="mx-auto max-w-lg px-4 py-20 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">This help center or article does not exist, or it is not public.</p>
      <Link href="/" className="mt-6 inline-flex min-h-11 items-center rounded text-xs text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Go to the homepage</Link>
    </div>
  );
}
