import { ApprovalError, decideApproval } from "@/lib/approvals/decide";
import { ROUTES } from "@/lib/public-api/registry";
import { ApiError } from "@/lib/public-api/envelope";
import { op } from "@/lib/public-api/handler";
import { approvalView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.decideApproval, async ({ principal, params, body }) => {
  try {
    const r = await decideApproval(principal.dataId, params.id, body, `api_key:${principal.keyId}`);
    return { data: { ...approvalView(r.approval), outcome: r.outcome } };
  } catch (err) {
    if (err instanceof ApprovalError) throw new ApiError(err.status, err.status === 404 ? "not_found" : err.status === 409 ? "conflict" : "bad_request", err.message);
    throw err;
  }
});
