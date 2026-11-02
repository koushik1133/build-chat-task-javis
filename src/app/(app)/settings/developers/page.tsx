"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, Check, Copy, KeyRound, Webhook, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SkeletonList } from "@/components/ui/feedback";
import { TableScroller, TH, THEAD } from "@/components/ui/table-scroller";
import { PageContainer } from "@/components/page-container";
import { AREAS } from "@/lib/auth/roles";
import { AREA_LABELS, API_AREAS } from "@/lib/public-api/scopes";
import { cn } from "@/lib/utils";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <Button type="button" variant="outline" size="sm" touch onClick={copy} aria-label={label}>
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </Button>
  );
}

function Code({ code, label, className }: { code: string; label: string; className?: string }) {
  return (
    <div className={cn("relative", className)}>
      <pre className="overflow-x-auto rounded-md bg-muted p-3 pr-24 text-xs leading-relaxed">{code}</pre>
      <div className="absolute right-2 top-2">
        <CopyButton text={code} label={label} />
      </div>
    </div>
  );
}

function Section({ id, icon, title, children }: { id: string; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <h2 id={`${id}-h`} className="mb-3 flex items-center gap-2 text-sm font-semibold">
        {icon} {title}
      </h2>
      {children}
    </section>
  );
}

const ROUTE_TABLE: ReadonlyArray<{ resource: string; routes: string; scope: string }> = [
  { resource: "Contacts", routes: "GET/POST /contacts · GET/PATCH/DELETE /contacts/{id}", scope: "crm" },
  { resource: "Tasks", routes: "GET/POST /tasks · GET/PATCH/DELETE /tasks/{id}", scope: "tasks" },
  { resource: "Quotes", routes: "GET/POST /quotes · GET /quotes/{id} · POST /quotes/{id}/send", scope: "billing" },
  { resource: "Invoices", routes: "GET/POST /invoices · GET /invoices/{id} · POST …/send · POST …/payments", scope: "billing" },
  { resource: "Products", routes: "GET/POST /products · GET/PATCH /products/{id} · POST …/stock", scope: "billing" },
  { resource: "Bookings", routes: "GET /bookings · GET /bookings/{id} · POST …/cancel · GET /booking-types · GET /availability", scope: "calendar" },
  { resource: "Tickets", routes: "GET/POST /tickets · GET /tickets/{id} · POST …/replies", scope: "helpdesk" },
  { resource: "Records", routes: "GET /record-types · GET/POST /records/{type} · GET/PATCH /records/{type}/{id} · POST …/move", scope: "crm" },
  { resource: "Events", routes: "GET /events?since=&type=", scope: "settings" },
  { resource: "Webhooks", routes: "GET/POST /webhooks · GET/PATCH/DELETE /webhooks/{id} · GET /webhooks/sample/{event}", scope: "settings" },
  { resource: "Me", routes: "GET /me", scope: "settings" },
];

export default function DevelopersPage() {
  const [origin, setOrigin] = useState("https://your-workspace.example");
  const [eventTypes, setEventTypes] = useState<string[] | null>(null);
  useEffect(() => {
    setOrigin(window.location.origin);
    // The event catalogue lives server-side (src/lib/events/bus.ts); the webhooks API exposes it.
    const ctrl = new AbortController();
    fetch("/api/webhooks", { cache: "no-store", signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setEventTypes(Array.isArray(d?.event_types) ? d.event_types : []))
      .catch(() => setEventTypes([]));
    return () => ctrl.abort();
  }, []);
  const base = `${origin}/api/v1`;

  const curlList = `curl "${base}/contacts?limit=20" \\
  -H "Authorization: Bearer kh_…"`;
  const curlCreate = `curl -X POST "${base}/contacts" \\
  -H "Authorization: Bearer kh_…" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"full_name":"Ada Lovelace","email":"ada@example.com","lifecycle":"lead"}'`;
  const curlPage = `# follow meta.next_cursor until it is null
curl "${base}/invoices?status=sent&cursor=eyJ…" -H "Authorization: Bearer kh_…"`;
  const envelope = `// 200 OK
{ "data": [ { "id": "…", "full_name": "Ada Lovelace", … } ],
  "meta": { "next_cursor": "MjAyNi0xMS0wMlQ…" } }

// 4xx / 5xx
{ "error": { "code": "validation_failed", "message": "Invalid body",
             "details": [ { "in": "body", "path": "email", "message": "Invalid email" } ] } }`;
  const verifyNode = `import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyKernelHubSignature(rawBody, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest("hex");
  const a = Buffer.from(expected, "hex"), b = Buffer.from(String(parts.v1 ?? ""), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Express: app.post("/hook", express.raw({ type: "*/*" }), (req, res) => {
//   if (!verifyKernelHubSignature(req.body.toString("utf8"), req.get("X-KernelHub-Signature"), process.env.KH_WEBHOOK_SECRET)) return res.sendStatus(401);
//   const event = JSON.parse(req.body); // { id, type, created_at, entity, entity_id, data }
//   res.sendStatus(200);
// });`;
  const payload = `POST https://hooks.example.com/kernelhub
Content-Type: application/json
X-KernelHub-Event: invoice.paid
X-KernelHub-Delivery: 7f1c…            # unique per delivery; use for de-duplication
X-KernelHub-Signature: t=1762070400,v1=5d41…

{ "id": "7f1c…", "type": "invoice.paid", "created_at": "2026-11-02T10:00:00.000Z",
  "entity": "invoice", "entity_id": "inv_…", "data": { "total_minor": 125000, "quote_id": null } }`;
  const zapier = `# Subscribe (performSubscribe) — keep the returned id
POST ${base}/webhooks
{ "url": "{{bundle.targetUrl}}", "event_types": ["invoice.paid"], "description": "Zapier" }

# Unsubscribe (performUnsubscribe)
DELETE ${base}/webhooks/{{bundle.subscribeData.id}}

# Sample for field mapping (performList)
GET ${base}/webhooks/sample/invoice.paid`;

  return (
    <PageContainer
      wide
      title="Developers"
      description="REST API v1, webhooks and connector guidance for Zapier, Make and custom integrations."
      tooltip="Everything here uses API keys from Settings → API keys. The OpenAPI document is public and always matches the running code."
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-4">
          <Section id="overview" icon={<BookOpen className="h-4 w-4" aria-hidden />} title="API overview">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Base URL</dt>
                <dd className="mt-0.5 flex items-center gap-2">
                  <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1 text-xs">{base}</code>
                  <CopyButton text={base} label="Copy base URL" />
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">OpenAPI 3.1</dt>
                <dd className="mt-0.5">
                  <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer" className="rounded-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    /api/v1/openapi.json
                  </a>{" "}
                  <span className="text-xs text-muted-foreground">— import into Postman, Insomnia or an SDK generator</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Authentication</dt>
                <dd className="mt-0.5">
                  <code className="rounded bg-muted px-1 text-xs">Authorization: Bearer kh_…</code>{" "}
                  <Link href="/settings/api-keys" className="rounded-sm text-xs underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    manage keys
                  </Link>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Rate limit</dt>
                <dd className="mt-0.5">
                  600 requests/minute per key · <code className="rounded bg-muted px-1 text-xs">X-RateLimit-Limit/Remaining/Reset</code>, 429 with <code className="rounded bg-muted px-1 text-xs">Retry-After</code>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Pagination</dt>
                <dd className="mt-0.5">
                  <code className="rounded bg-muted px-1 text-xs">?limit=50&cursor=…</code> — opaque keyset cursors, newest first, max 200 per page
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Idempotency</dt>
                <dd className="mt-0.5">
                  Send <code className="rounded bg-muted px-1 text-xs">Idempotency-Key</code> on POST; replays within 24h return the original response with <code className="rounded bg-muted px-1 text-xs">Idempotent-Replay: true</code>
                </dd>
              </div>
            </dl>
            <h3 className="mb-1 mt-4 text-xs font-medium">Response envelope</h3>
            <Code code={envelope} label="Copy envelope example" />
          </Section>

          <Section id="examples" icon={<KeyRound className="h-4 w-4" aria-hidden />} title="curl examples">
            <div className="space-y-3">
              <div>
                <h3 className="mb-1 text-xs font-medium">List contacts</h3>
                <Code code={curlList} label="Copy list example" />
              </div>
              <div>
                <h3 className="mb-1 text-xs font-medium">Create a contact (idempotent)</h3>
                <Code code={curlCreate} label="Copy create example" />
              </div>
              <div>
                <h3 className="mb-1 text-xs font-medium">Next page</h3>
                <Code code={curlPage} label="Copy pagination example" />
              </div>
            </div>
          </Section>

          <Section id="resources" icon={<BookOpen className="h-4 w-4" aria-hidden />} title="Resources">
            <TableScroller label="API resources">
              <table className="w-full min-w-[560px] text-sm">
                <thead className={THEAD}>
                  <tr>
                    <th scope="col" className={TH}>Resource</th>
                    <th scope="col" className={TH}>Routes (relative to base URL)</th>
                    <th scope="col" className={TH}>Scope area</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {ROUTE_TABLE.map((r) => (
                    <tr key={r.resource}>
                      <th scope="row" className="px-3 py-2 text-left font-medium">{r.resource}</th>
                      <td className="px-3 py-2 text-xs"><code>{r.routes}</code></td>
                      <td className="px-3 py-2 text-xs"><code>read:{r.scope}</code> / <code>write:{r.scope}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroller>
          </Section>

          <Section id="scopes" icon={<KeyRound className="h-4 w-4" aria-hidden />} title="Scopes">
            <p className="mb-3 text-sm text-muted-foreground">
              Keys carry <code className="rounded bg-muted px-1 text-xs">read:&lt;area&gt;</code> and <code className="rounded bg-muted px-1 text-xs">write:&lt;area&gt;</code> scopes. Write implies read. The legacy{" "}
              <code className="rounded bg-muted px-1 text-xs">mcp</code> scope grants everything (used by MCP clients).
            </p>
            <TableScroller label="Scopes">
              <table className="w-full min-w-[480px] text-sm">
                <thead className={THEAD}>
                  <tr>
                    <th scope="col" className={TH}>Area</th>
                    <th scope="col" className={TH}>Scopes</th>
                    <th scope="col" className={TH}>v1 routes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {AREAS.map((a) => (
                    <tr key={a} className={cn(!API_AREAS.includes(a) && "text-muted-foreground")}>
                      <th scope="row" className="px-3 py-1.5 text-left font-normal">{AREA_LABELS[a]}</th>
                      <td className="px-3 py-1.5 text-xs"><code>read:{a}</code>, <code>write:{a}</code></td>
                      <td className="px-3 py-1.5 text-xs">{API_AREAS.includes(a) ? "yes" : "reserved"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroller>
          </Section>

          <Section id="webhooks" icon={<Webhook className="h-4 w-4" aria-hidden />} title="Webhooks">
            <p className="mb-3 text-sm text-muted-foreground">
              Create endpoints under{" "}
              <Link href="/settings/webhooks" className="rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Settings → Webhooks
              </Link>{" "}
              or via <code className="rounded bg-muted px-1 text-xs">POST /webhooks</code>. Each delivery is a JSON POST, signed with the subscription secret. Retries: 1m, 5m, 30m, 2h, 12h, then dead; 20 consecutive failures disable the endpoint. Respond 2xx within 10 seconds.
            </p>
            <h3 className="mb-1 text-xs font-medium">Delivery</h3>
            <Code code={payload} label="Copy delivery example" className="mb-3" />
            <h3 className="mb-1 text-xs font-medium">Verify the signature (Node)</h3>
            <Code code={verifyNode} label="Copy verification snippet" />
            <h3 className="mb-1 mt-3 text-xs font-medium">Event types</h3>
            {eventTypes === null ? (
              <SkeletonList count={2} itemClassName="h-6" label="Loading event types…" />
            ) : eventTypes.length === 0 ? (
              <p className="text-xs text-muted-foreground">Event catalogue unavailable — see <code className="rounded bg-muted px-1">src/lib/events/bus.ts</code>.</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {eventTypes.map((t) => (
                  <code key={t} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{t}</code>
                ))}
              </div>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Subscribe with <code className="rounded bg-muted px-1">[&quot;*&quot;]</code> for everything or <code className="rounded bg-muted px-1">invoice.*</code> for a prefix. Sample bodies: <code className="rounded bg-muted px-1">GET /webhooks/sample/&lt;event&gt;</code>.
            </p>
          </Section>

          <Section id="zapier" icon={<Zap className="h-4 w-4" aria-hidden />} title="Zapier / Make">
            <p className="mb-3 text-sm text-muted-foreground">
              Both platforms use the REST-hooks pattern: they call subscribe when a Zap/scenario turns on, unsubscribe when it turns off, and fetch a sample for field mapping. Use an API key with{" "}
              <code className="rounded bg-muted px-1 text-xs">write:settings</code> plus the areas the actions need.
            </p>
            <Code code={zapier} label="Copy REST hooks example" />
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>Triggers: subscribe to one event type per trigger (e.g. <code className="rounded bg-muted px-1 text-xs">crm.contact.created</code>) so field mapping stays stable.</li>
              <li>Polling fallback: <code className="rounded bg-muted px-1 text-xs">GET /events?type=…&amp;since=…</code> returns the same payloads newest first.</li>
              <li>Actions: any POST/PATCH route; send <code className="rounded bg-muted px-1 text-xs">Idempotency-Key</code> so platform retries never duplicate records.</li>
              <li>Make: use the “Custom webhook” module as the target URL and the HTTP module for subscribe/unsubscribe.</li>
            </ul>
          </Section>
        </div>

        <nav aria-label="On this page" className="hidden lg:block">
          <ul className="sticky top-4 space-y-1 text-sm">
            {[
              ["overview", "API overview"],
              ["examples", "curl examples"],
              ["resources", "Resources"],
              ["scopes", "Scopes"],
              ["webhooks", "Webhooks"],
              ["zapier", "Zapier / Make"],
            ].map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="block rounded-md px-2 py-1 text-muted-foreground hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </PageContainer>
  );
}
