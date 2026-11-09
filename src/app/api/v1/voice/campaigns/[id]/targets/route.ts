import { addTargets, getCampaign, listTargets } from "@/lib/voice/campaigns";
import { ROUTES } from "@/lib/public-api/registry";
import { op, libCall, mustFind, singlePage } from "@/lib/public-api/handler";
import { targetView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = op(ROUTES.listVoiceTargets, async ({ principal, params, list }) => {
  const c = mustFind(await getCampaign(principal.dataId, params.id), "Campaign");
  return singlePage((await listTargets(principal.dataId, c.id, list.limit)).map(targetView));
});

export const POST = op(ROUTES.addVoiceTargets, async ({ principal, params, body }) => {
  const c = mustFind(await getCampaign(principal.dataId, params.id), "Campaign");
  const filter = body.lifecycle || body.tag || body.q ? { lifecycle: body.lifecycle ?? null, tag: body.tag ?? null, q: body.q ?? null } : null;
  const r = await libCall(() => addTargets(principal.dataId, c.id, { contact_ids: body.contact_ids, filter, phones: body.phones }));
  return { data: r, status: 201 };
});
