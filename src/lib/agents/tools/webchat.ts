import { z } from "zod";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { listSessions } from "@/lib/webchat/session";
import { unansweredCount } from "@/lib/webchat/service";

/** Web chat tools (read-only): open sessions on the website widget and how many await a reply. */

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}

const SessionsInput = z.object({
  status: z.enum(["active", "open", "handed_off", "closed", "all"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
type SessionsInputT = z.infer<typeof SessionsInput>;

registerTool<SessionsInputT>({
  name: "webchat.sessions",
  module: "webchat",
  description: "List website chat sessions (open by default) with the number of visitors still waiting for a human reply.",
  input: SessionsInput,
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["active", "open", "handed_off", "closed", "all"] },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
  scope: "read",
  preview: (i) => `List ${i.status ?? "active"} web chat sessions`,
  async run(ctx, input) {
    try {
      const [sessions, counts] = await Promise.all([listSessions(ctx.userId, { status: input.status ?? "active", limit: input.limit ?? 25 }), unansweredCount(ctx.userId)]);
      return {
        ok: true,
        data: {
          counts,
          sessions: sessions.map((s) => ({ id: s.id, status: s.status, pageUrl: s.page_url, startedAt: s.started_at, lastSeenAt: s.last_seen_at, conversationId: s.conversation_id, contactId: s.contact_id })),
        },
        summary: `${counts.open} active web chat session(s), ${counts.unanswered} awaiting a reply`,
      };
    } catch (err) {
      return fail(`Could not list web chat sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});
