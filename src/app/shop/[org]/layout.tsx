import { notFound } from "next/navigation";
import { resolveStorefrontBySlug } from "@/lib/storefront/settings";

export const dynamic = "force-dynamic";

/** Resolves the storefront once per request so unknown / disabled shops are a real 404. */
export default async function ShopOrgLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const { org } = await params;
  const pub = await resolveStorefrontBySlug(org).catch(() => null);
  if (!pub) notFound();
  return <>{children}</>;
}
