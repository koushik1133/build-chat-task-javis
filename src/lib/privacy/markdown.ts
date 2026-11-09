/**
 * Minimal, dependency-free markdown → HTML for privacy notices. Escapes HTML
 * first so notice authors cannot inject script; supports headings, lists,
 * paragraphs, bold/italic, links. Client-safe (pure).
 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\*)(.+?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+|\/[^)\s]*)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
}

export function renderMarkdown(md: string): string {
  const lines = esc(md.replace(/\r\n/g, "\n")).split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    if (h) {
      flushPara();
      closeList();
      out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`);
      continue;
    }
    if (ul || ol) {
      flushPara();
      const kind = ul ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        list = kind;
        out.push(`<${kind}>`);
      }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  flushPara();
  closeList();
  return out.join("\n");
}
