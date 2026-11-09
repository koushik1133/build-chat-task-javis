import { ApprovalError, decideApproval } from "@/lib/approvals/decide";
import { ROUTES } from "@/lib/public-api/registry";
import { ApiError } from "@/lib/public-api/envelope";
import { op } from "@/lib/public-api/handler";
import { approvalView } from "@/lib/public-api/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = op(ROUTES.decideApproval, async ({ principal, params, body }) => {
  try {
    const r = await decideApproval(principal.dataId, params.id, body, `api_key:${principal.keyId}`, { allowedScopes: principal.scopes });
    return { data: { ...approvalView(r.approval), outcome: r.outcome } };
  } catch (err) {
    if (err instanceof ApprovalError) {
      const code = err.status === 404 ? "not_found" : err.status === 409 ? "conflict" : err.status === 403 ? "forbidden" : "bad_request";
      throw new ApiError(err.status, code, err.message);
    }
    throw err;
  }
});
