import { z } from "zod";
import { query } from "@/lib/dsql";
import { registerTool } from "@/lib/agents/registry";
import type { ToolResult } from "@/lib/agents/types";
import { sendChat } from "@/lib/chatops/send";

/** chat.send: post a message to one of the org's connected chat apps (Slack, Teams, Discord, webhook). */

const Input = z.object({
  integration: z.string().min(1).max(120).describe("Integration id or name"),
  title: z.string().min(1).max(200),
  text: z.string().max(3000).optional(),
});
type InputT = z.infer<typeof Input>;

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}

registerTool<InputT>({
  name: "chat.send",
  module: "chat",
  description: "Send a short message to a connected chat integration (Slack, Teams, Discord or webhook) by id or name.",
  input: Input,
  parameters: {
    type: "object",
    properties: { integration: { type: "string", description: "Integration id or name" }, title: { type: "string" }, text: { type: "string" } },
    required: ["integration", "title"],
  },
  scope: "write",
  requiresApproval: true,
  preview: (i) => `Post "${i.title}" to chat integration ${i.integration}`,
  async run(ctx, input) {
    try {
      const rows = await query<{ id: string }>(`SELECT id FROM chat_integrations WHERE user_id = $1 AND enabled = TRUE AND (id = $2 OR LOWER(name) = LOWER($2)) LIMIT 1`, [ctx.userId, input.integration]);
      if (!rows[0]) return fail("No enabled chat integration with that id or name.");
      const r = await sendChat(rows[0].id, { title: input.title, text: input.text ?? "", eventType: "agent.message" }, { dataId: ctx.userId });
      return r.ok ? { ok: true, summary: `Sent to ${input.integration}`, data: { status: r.status } } : fail(r.error ?? "Delivery failed");
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});
