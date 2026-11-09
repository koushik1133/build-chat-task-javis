/**
 * Static accessibility scanner: pure, regex/heuristic checks over TSX source.
 * Intentionally conservative — only high-confidence patterns are "error";
 * softer signals are "warn". Not a replacement for axe, a CI tripwire.
 */

export type A11yRule =
  | "img-alt"
  | "icon-only-button"
  | "form-control-label"
  | "click-non-interactive"
  | "blank-rel"
  | "positive-tabindex"
  | "autofocus"
  | "aria-hidden-focusable"
  | "button-type";

export interface A11yFinding {
  rule: A11yRule;
  severity: "error" | "warn";
  line: number;
  /** Opening tag text, whitespace-collapsed (first 90 chars). */
  snippet: string;
  message: string;
}

interface JsxTag {
  name: string;
  start: number;
  /** Index just past the closing `>` of the opening tag. */
  end: number;
  attrs: string;
  selfClosing: boolean;
}

const TAG_START = /<([A-Za-z][A-Za-z0-9.]*)(?=[\s/>])/g;

/** Find the end of an opening tag, honouring {...} nesting and quotes. */
function readTag(src: string, start: number, name: string): JsxTag | null {
  let i = start + 1 + name.length;
  let depth = 0;
  let quote: string | null = null;
  const attrStart = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (depth > 0) {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === '"' || c === "'" || c === "`") quote = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === '"' || c === "'") quote = c;
    else if (c === ">") {
      const selfClosing = src[i - 1] === "/";
      return { name, start, end: i + 1, attrs: src.slice(attrStart, selfClosing ? i - 1 : i), selfClosing };
    }
    else if (c === "<" || c === ";") return null; // not JSX (generic / comparison)
  }
  return null;
}

function hasAttr(attrs: string, attr: string): boolean {
  return new RegExp(`(^|[\\s{])${attr.replace("-", "\\-")}(\\s*=|\\s|$|/)`).test(attrs);
}

function attrValue(attrs: string, attr: string): string | null {
  const m = attrs.match(new RegExp(`(?:^|\\s)${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{([^}]*)\\})`));
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

/** An accessible-name attribute that is present AND non-empty (`aria-label=""` names nothing). */
function hasName(attrs: string, attr: string): boolean {
  if (!hasAttr(attrs, attr)) return false;
  const v = attrValue(attrs, attr);
  return v === null || v.trim() !== "" && v.trim() !== '""' && v.trim() !== "''";
}

function lineOf(src: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

/** Text between an opening tag and its matching close, or null when it cannot be found. */
function childrenOf(src: string, tag: JsxTag): string | null {
  if (tag.selfClosing) return "";
  const re = new RegExp(`<(/?)${tag.name.replace(".", "\\.")}(?=[\\s/>])`, "g");
  re.lastIndex = tag.end;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1]) {
      depth--;
      if (depth === 0) return src.slice(tag.end, m.index);
    } else {
      const t = readTag(src, m.index, tag.name);
      if (t && !t.selfClosing) depth++;
    }
  }
  return null;
}

/** True when children have no visible text and no expression that might render text (only icon-like elements). */
function isIconOnly(children: string): boolean {
  if (/sr-only/.test(children)) return false;
  let rest = children.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  // Remove self-closing JSX elements (icons) repeatedly.
  rest = rest.replace(/<[A-Za-z][A-Za-z0-9.]*(?:\s(?:[^<>{}]|\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})*)?\/>/g, "");
  rest = rest.replace(/\s+/g, "");
  return rest === "";
}

const NATIVE_FIELDS = new Set(["input", "select", "textarea"]);
const NON_LABELLED_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);
const FOCUSABLE_NATIVE = new Set(["button", "a", "input", "select", "textarea"]);

function insideOpenLabel(src: string, idx: number): boolean {
  const before = src.slice(Math.max(0, idx - 1500), idx);
  const open = (before.match(/<label[\s>]/g) || []).length;
  const close = (before.match(/<\/label>/g) || []).length;
  return open > close;
}

export function scanSource(src: string): A11yFinding[] {
  const out: A11yFinding[] = [];
  const hasForm = /<form[\s>]/.test(src);
  const hasHtmlFor = /htmlFor\s*=/.test(src);
  TAG_START.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_START.exec(src))) {
    const name = m[1];
    const tag = readTag(src, m.index, name);
    if (!tag) continue;
    const { attrs } = tag;
    const spread = /\{\s*\.\.\./.test(attrs);
    const snippet = src.slice(tag.start, tag.end).replace(/\s+/g, " ").slice(0, 90);
    const line = lineOf(src, tag.start);
    const add = (rule: A11yRule, severity: "error" | "warn", message: string) => out.push({ rule, severity, line, snippet, message });

    if (name === "img" && !spread && !hasAttr(attrs, "alt")) add("img-alt", "error", "<img> needs an alt attribute (use alt=\"\" when decorative).");

    if ((name === "button" || name === "Button") && !spread) {
      const named = hasName(attrs, "aria-label") || hasName(attrs, "aria-labelledby") || hasName(attrs, "title");
      if (!named) {
        const kids = childrenOf(src, tag);
        if (kids !== null && isIconOnly(kids)) add("icon-only-button", "error", "Icon-only button needs aria-label, title or an sr-only label.");
      }
      if (name === "button" && hasForm && !hasAttr(attrs, "type")) add("button-type", "warn", "<button> in a file with a <form> should set type explicitly.");
    }

    if (NATIVE_FIELDS.has(name) && !spread) {
      const type = attrValue(attrs, "type");
      const visuallyHidden = type === "file" && (/(^|\s)hidden(\s|=|$)/.test(attrs) || /className\s*=\s*"[^"]*\bhidden\b/.test(attrs));
      const skip = (name === "input" && type !== null && NON_LABELLED_INPUT_TYPES.has(type)) || visuallyHidden;
      // A quoted literal id must be the target of an htmlFor="<id>" in the file; a dynamic id keeps the file-level check.
      const literalId = /(?:^|\s)id\s*=\s*"([^"]+)"/.exec(attrs)?.[1] ?? null;
      const idLabelled = literalId !== null
        ? new RegExp(`htmlFor\\s*=\\s*(?:"${literalId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"|\\{\\s*["'\`]${literalId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]\\s*\\})`).test(src)
        : hasAttr(attrs, "id") && hasHtmlFor;
      const labelled =
        hasName(attrs, "aria-label") || hasName(attrs, "aria-labelledby") || hasName(attrs, "title") || idLabelled || insideOpenLabel(src, tag.start);
      if (!skip && !labelled) add("form-control-label", "error", `<${name}> needs a label (id + htmlFor, aria-label, aria-labelledby or a wrapping <label>).`);
    }

    if ((name === "div" || name === "span") && hasAttr(attrs, "onClick")) {
      const handler = attrValue(attrs, "onClick") ?? "";
      const onlyStop = /stopPropagation/.test(handler) && !/[a-z]\w*\(/.test(handler.replace(/e\.stopPropagation\(\)/g, ""));
      const fullHandler = /onClick=\{([\s\S]*)\}/.exec(attrs)?.[1] ?? "";
      const isStop = onlyStop || /^\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.stopPropagation\(\)\s*$/.test(fullHandler.trim());
      const roleVal = attrValue(attrs, "role");
      const backdrop = roleVal === "presentation" || roleVal === "none" || roleVal === "dialog" || roleVal === "alertdialog";
      if (!isStop && !backdrop && !(hasAttr(attrs, "role") && hasAttr(attrs, "tabIndex") && hasAttr(attrs, "onKeyDown"))) {
        add("click-non-interactive", "error", `<${name} onClick> needs role, tabIndex and onKeyDown (or use a <button>).`);
      }
    }

    if (name === "a" && /target\s*=\s*["{]\s*["']?_blank/.test(attrs) && !/rel\s*=\s*["{][^"}]*(noopener|noreferrer)/.test(attrs)) {
      add("blank-rel", "error", 'target="_blank" needs rel="noopener noreferrer".');
    }

    const ti = attrs.match(/tabIndex\s*=\s*(?:"(-?\d+)"|\{\s*(-?\d+)\s*\})/);
    const tiVal = ti ? Number(ti[1] ?? ti[2]) : null;
    if (tiVal !== null && tiVal > 0) add("positive-tabindex", "error", "Positive tabIndex breaks natural focus order.");

    if (hasAttr(attrs, "autoFocus")) add("autofocus", "warn", "autoFocus can disorient screen-reader users; fine only inside dialogs.");

    const hidden = /aria-hidden\s*=\s*(?:"true"|\{\s*true\s*\})/.test(attrs);
    if (hidden && (FOCUSABLE_NATIVE.has(name) || (tiVal !== null && tiVal >= 0))) add("aria-hidden-focusable", "error", "aria-hidden on a focusable element hides it from AT while it stays tabbable.");
  }
  return out;
}

/** Stable fingerprint for the allow-list: survives line shifts. */
export function fingerprint(file: string, f: A11yFinding): string {
  return `${file}|${f.rule}|${f.snippet}`;
}
