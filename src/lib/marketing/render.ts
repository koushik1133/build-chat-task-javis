/**
 * Merge-field rendering for marketing content. Pure and client-safe so the
 * composer can preview exactly what the cron will send.
 *
 *  - `{{field}}` placeholders are replaced from a flat vars map; unknown
 *    fields render empty; values are HTML-escaped for the HTML body and left
 *    raw for subjects / SMS.
 *  - Email bodies MUST carry an unsubscribe link; `ensureUnsubscribe` appends
 *    a footer when the author left `{{unsubscribe_url}}` out.
 *  - `markdownToHtml` is a deliberately small renderer (headings, paragraphs,
 *    bold/italic, links, lists, hr) — no raw HTML passthrough, so author input
 *    can never inject script into a recipient's inbox.
 */

export type MergeVars = Record<string, string | null | undefined>;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

const MERGE_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** Replace `{{field}}` tokens. `escape` wraps each value for HTML output. */
export function renderMerge(template: string, vars: MergeVars, opts: { escape?: boolean } = {}): string {
  return template.replace(MERGE_RE, (_m, key: string) => {
    const v = vars[key];
    const str = v === null || v === undefined ? "" : String(v);
    return opts.escape ? escapeHtml(str) : str;
  });
}

/** Merge keys referenced by a template (deduplicated, in order). */
export function mergeKeys(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(MERGE_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export function hasUnsubscribe(bodyMd: string): boolean {
  return /\{\{\s*unsubscribe_url\s*\}\}/.test(bodyMd);
}

/** Email bodies always end with an unsubscribe line. Idempotent. */
export function ensureUnsubscribe(bodyMd: string, text = "Unsubscribe"): string {
  if (hasUnsubscribe(bodyMd)) return bodyMd;
  return `${bodyMd.replace(/\s+$/, "")}\n\n---\n\n[${text}]({{unsubscribe_url}})`;
}

/** SMS: append the opt-out link when missing (short, no markdown). */
export function ensureSmsOptOut(body: string): string {
  if (hasUnsubscribe(body)) return body;
  return `${body.replace(/\s+$/, "")}\nOpt out: {{unsubscribe_url}}`;
}

/* ---------- markdown (subset) ---------- */

function inline(md: string): string {
  // Escape first; everything below only emits tags we control.
  let s = escapeHtml(md);
  // links [text](url) — only http(s)/mailto and merge placeholders are allowed as href.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => {
    const ok = /^(https?:\/\/|mailto:|\{\{\s*[a-zA-Z_]+\s*\}\})/.test(href);
    return ok ? `<a href="${href}" style="color:#2563eb">${text}</a>` : text;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  return s;
}

/** Minimal, safe markdown → HTML. Author HTML is escaped, never passed through. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p style="margin:0 0 12px;line-height:1.55">${para.map(inline).join("<br/>")}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.kind} style="margin:0 0 12px;padding-left:22px">${list.items.map((i) => `<li style="margin:0 0 4px">${inline(i)}</li>`).join("")}</${list.kind}>`);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      const level = h[1].length;
      const size = level === 1 ? 22 : level === 2 ? 18 : 16;
      out.push(`<h${level} style="margin:0 0 12px;font-size:${size}px;line-height:1.3">${inline(h[2])}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushPara();
      flushList();
      out.push(`<hr style="border:0;border-top:1px solid #e5e7eb;margin:16px 0"/>`);
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const kind = ul ? "ul" : "ol";
      const text = (ul ?? ol)![1];
      if (!list || list.kind !== kind) {
        flushList();
        list = { kind, items: [] };
      }
      list.items.push(text);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join("\n");
}

/** Extract every http(s) link target from rendered HTML (href attributes). */
export function extractLinks(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const href = m[1].replace(/&amp;/g, "&");
    if (/^https?:\/\//i.test(href) && !out.includes(href)) out.push(href);
  }
  return out;
}

/** Rewrite every tracked link in rendered HTML through `wrap(url)`. */
export function rewriteLinks(html: string, wrap: (url: string) => string | null): string {
  return html.replace(/href="([^"]+)"/g, (m, href: string) => {
    const url = href.replace(/&amp;/g, "&");
    if (!/^https?:\/\//i.test(url)) return m;
    const wrapped = wrap(url);
    return wrapped ? `href="${escapeHtml(wrapped)}"` : m;
  });
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Full email render: merge subject (raw), ensure unsubscribe, markdown → HTML,
 * merge body (escaped), optional preheader and tracking pixel.
 */
export function renderEmail(input: { subject: string; preheader?: string | null; body_md: string; vars: MergeVars; pixelUrl?: string | null }): RenderedEmail {
  const subject = renderMerge(input.subject, input.vars).trim();
  const bodyMd = ensureUnsubscribe(input.body_md);
  // Merge BEFORE markdown so {{unsubscribe_url}} becomes a real href; values are escaped as HTML
  // text, and markdownToHtml escapes the rest. URLs in vars stay usable inside [..](..).
  const merged = renderMerge(bodyMd, input.vars, { escape: false });
  let html = markdownToHtml(merged);
  if (input.preheader?.trim()) {
    const pre = escapeHtml(renderMerge(input.preheader, input.vars));
    html = `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${pre}</div>\n${html}`;
  }
  if (input.pixelUrl) html += `\n<img src="${escapeHtml(input.pixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0"/>`;
  const text = merged.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)").replace(/[*_`#>]/g, "");
  return { subject, html, text };
}

export function renderSms(body: string, vars: MergeVars): string {
  return renderMerge(ensureSmsOptOut(body), vars).trim();
}

/** Sample contact used by the composer preview and test sends. */
export const SAMPLE_VARS: MergeVars = {
  first_name: "Alex",
  full_name: "Alex Morgan",
  company: "Morgan & Co",
  email: "alex@example.com",
  org_name: "Your business",
  unsubscribe_url: "https://example.com/u/preview",
};

export function firstNameOf(fullName: string | null | undefined): string {
  return (fullName ?? "").trim().split(/\s+/)[0] ?? "";
}
