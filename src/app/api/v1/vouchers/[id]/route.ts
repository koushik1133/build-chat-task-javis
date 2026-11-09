import { ROUTES } from "@/lib/public-api/registry";
import { mustFind, op } from "@/lib/public-api/handler";
import { getVoucher } from "@/lib/engagement/vouchers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.getVoucher, async ({ principal, params }) => ({ data: mustFind(await getVoucher(principal.dataId, params.id), "Voucher") }));
