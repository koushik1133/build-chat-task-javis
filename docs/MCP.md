# KernelHub MCP server

KernelHub exposes every agent tool over the [Model Context Protocol](https://modelcontextprotocol.io) so external assistants and IDE agents can operate the workspace with the same guard-rails as in-app agents.

- **Endpoint**: `POST https://<your-host>/api/mcp` (Streamable HTTP, stateless JSON-RPC; no SSE).
- **Auth**: `Authorization: Bearer kh_…` — an API key from **Settings → API keys**.
- **Rate limit**: 300 requests/min per key (`429` + `Retry-After`).

## Scopes

Tools are filtered by the key's scopes. Each tool belongs to a module, which maps to an area (`src/lib/agents/tool-scopes.ts`):

| Tool modules | Area | Read tools need | Write tools need |
| --- | --- | --- | --- |
| `crm`, `records`, `privacy` | crm | `read:crm` | `write:crm` |
| `leads` | leads | `read:leads` | `write:leads` |
| `comms`, `voice` | messaging | `read:messaging` | `write:messaging` |
| `knowledge` (incl. `kb.*`) | knowledge | `read:knowledge` | `write:knowledge` |
| `production` | production | `read:production` | `write:production` |
| `tasks` | tasks | `read:tasks` | `write:tasks` |
| `agents`, `marketplace` | agents | `read:agents` | `write:agents` |
| `social` | social | `read:social` | `write:social` |
| `calendar` | calendar | `read:calendar` | `write:calendar` |
| `billing`, `finance`, `inventory`, `credits` | billing | `read:billing` | `write:billing` |
| `helpdesk` | helpdesk | `read:helpdesk` | `write:helpdesk` |
| `strategy`, `optimize`, `agency`, `home` | reports | `read:reports` | `write:reports` |

`write:<area>` implies `read:<area>`. The legacy `mcp` scope grants every tool. `tools/list` only returns tools the key may call; calling anything else returns an `isError` result with `required_scope`.

## Approvals

Calls run at the **approve** autonomy level: a write tool that the registry gates (e.g. `comms.send_email`, `records.delete`, `voice.start_campaign`) is **not executed**. Instead the call returns

```json
{ "status": "awaiting_approval", "approval_id": "…", "tool": "comms.send_email", "decide": "POST https://…/api/v1/approvals/<id>/decide" }
```

and the action waits in the Approvals inbox (or `POST /api/v1/approvals/{id}/decide` with `{ "decision": "approved" }`, which executes it inline and returns the outcome). Reads and ungated writes (e.g. `tasks.create`, `helpdesk.create_ticket`, `inventory.checkout`) run immediately.

## Resources

| URI | Content |
| --- | --- |
| `kernelhub://openapi.json` | The REST API as OpenAPI 3.1. Each operation carries `x-kernelhub-tools`, the tool names that perform the same action, so a client can choose between REST and MCP. |
| `kernelhub://docs/api` | `docs/API.md` |
| `kernelhub://docs/mcp` | this document |

## Client configuration

Claude Desktop / Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "kernelhub": {
      "type": "http",
      "url": "https://<your-host>/api/mcp",
      "headers": { "Authorization": "Bearer kh_…" }
    }
  }
}
```

Cursor / Windsurf accept the same `url` + `headers` shape. For a quick check:

```bash
curl -s https://<host>/api/mcp -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'
```

## Tool catalogue

Every tool is `module.action` with a JSON-schema `inputSchema` (`additionalProperties: false`). Names are stable; new tools are added, never renamed. The authoritative list is `tools/list`; the same tools power the in-app copilots and autonomous agents (`src/lib/agents/tools/*`).

## Tenancy

A key is personal; its data scope is its owner's workspace (`organizations.owner_user_id`). Every tool filters by that id — there is no way to reach another workspace through MCP.
