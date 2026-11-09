import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { readCappedText } from "@/lib/request-limits";
import { cartView, changeCart, getOrCreateCart, setCartEmail } from "@/lib/storefront/cart";
import { NO_STORE, notFound, readCartToken, resolveShop, shopError, shopRateLimit, withCartCookie } from "@/lib/storefront/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ org: string }> };

const AddBody = z.object({ product_id: z.string().min(1).max(100), qty: z.number().int().min(1).max(100_000).default(1) }).strict();
const PatchBody = z
  .object({
    product_id: z.string().min(1).max(100).optional(),
    qty: z.number().int().min(0).max(100_000).optional(),
    email: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
    pickup: z.boolean().optional(),
  })
  .strict();
const DeleteBody = z.object({ product_id: z.string().min(1).max(100) }).strict();

async function body<T extends z.ZodTypeAny>(req: NextRequest, schema: T): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: NextResponse }> {
  const text = await readCappedText(req, 8_192);
  if (text === null) return { ok: false, res: NextResponse.json({ error: "payload_too_large" }, { status: 413 }) };
  let json: unknown = {};
  try {
    json = text.trim() ? JSON.parse(text) : {};
  } catch {
    return { ok: false, res: NextResponse.json({ error: "invalid_json" }, { status: 400 }) };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, res: NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 }) };
  return { ok: true, data: parsed.data };
}

/** GET /api/shop/[org]/cart?pickup=1 — current cart (creates an empty one and sets the cookie when missing). */
export async function GET(req: NextRequest, ctx: Ctx) {
  const block = await shopRateLimit(req, "cart");
  if (block) return block;
  try {
    const pub = await resolveShop(ctx);
    if (!pub) return notFound();
    const { cart, token } = await getOrCreateCart(pub.dataId, pub.storefront, readCartToken(req, pub.storefront.slug));
    const pickup = new URL(req.url).searchParams.get("pickup");
    const view = await cartView(pub, cart, { pickup: pickup === null ? undefined : pickup === "1" });
    return withCartCookie(NextResponse.json({ cart: view }, { headers: NO_STORE }), pub, token);
  } catch (err) {
    return shopError(err, "shop.cart.GET");
  }
}

/** POST /api/shop/[org]/cart — { product_id, qty? } adds to the line. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const block = await shopRateLimit(req, "cart-write", 60);
  if (block) return block;
  try {
    const pub = await resolveShop(ctx);
    if (!pub) return notFound();
    const b = await body(req, AddBody);
    if (!b.ok) return b.res;
    const { cart, token } = await getOrCreateCart(pub.dataId, pub.storefront, readCartToken(req, pub.storefront.slug));
    const next = await changeCart(pub.dataId, pub.storefront, cart, { product_id: b.data.product_id, qty: b.data.qty, add: true });
    return withCartCookie(NextResponse.json({ cart: await cartView(pub, next) }, { status: 200, headers: NO_STORE }), pub, token);
  } catch (err) {
    return shopError(err, "shop.cart.POST");
  }
}

/** PATCH /api/shop/[org]/cart — { product_id, qty } sets a line (0 removes); { email } remembers the shopper. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const block = await shopRateLimit(req, "cart-write", 60);
  if (block) return block;
  try {
    const pub = await resolveShop(ctx);
    if (!pub) return notFound();
    const b = await body(req, PatchBody);
    if (!b.ok) return b.res;
    const { cart, token } = await getOrCreateCart(pub.dataId, pub.storefront, readCartToken(req, pub.storefront.slug));
    let row = cart;
    if (b.data.product_id && b.data.qty !== undefined) row = await changeCart(pub.dataId, pub.storefront, row, { product_id: b.data.product_id, qty: b.data.qty });
    if (b.data.email !== undefined) {
      await setCartEmail(row.id, b.data.email);
      row = { ...row, email: b.data.email };
    }
    return withCartCookie(NextResponse.json({ cart: await cartView(pub, row, { pickup: b.data.pickup }) }, { headers: NO_STORE }), pub, token);
  } catch (err) {
    return shopError(err, "shop.cart.PATCH");
  }
}

/** DELETE /api/shop/[org]/cart — { product_id } removes a line. */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const block = await shopRateLimit(req, "cart-write", 60);
  if (block) return block;
  try {
    const pub = await resolveShop(ctx);
    if (!pub) return notFound();
    const b = await body(req, DeleteBody);
    if (!b.ok) return b.res;
    const { cart, token } = await getOrCreateCart(pub.dataId, pub.storefront, readCartToken(req, pub.storefront.slug));
    const next = await changeCart(pub.dataId, pub.storefront, cart, { product_id: b.data.product_id, qty: 0 });
    return withCartCookie(NextResponse.json({ cart: await cartView(pub, next) }, { headers: NO_STORE }), pub, token);
  } catch (err) {
    return shopError(err, "shop.cart.DELETE");
  }
}
