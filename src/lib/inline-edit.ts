// Script injected into the iframe srcDoc when Edit Mode is on.
// Click any text element to edit; on blur, posts the full HTML back to the parent.

export const INLINE_EDIT_SCRIPT = `
<script id="jarvis-edit-script">
(function () {
  var EDITABLE = "h1,h2,h3,h4,h5,h6,p,span,a,li,button,blockquote,figcaption,small,strong,em,label,th,td";
  var saveTimer = null;

  var style = document.createElement("style");
  style.id = "jarvis-edit-style";
  style.textContent = [
    "[data-jarvis-editable]:hover{outline:2px dashed rgba(99,102,241,.45);outline-offset:2px;cursor:text;}",
    "[contenteditable=true]{outline:2px solid #6366f1!important;outline-offset:2px;background:rgba(99,102,241,.06);}",
    "#jarvis-edit-toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;padding:8px 14px;border-radius:8px;font:500 12px system-ui;z-index:99999;opacity:0;transition:opacity .2s;pointer-events:none;}",
    "#jarvis-edit-toast.show{opacity:1;}"
  ].join("");
  document.head.appendChild(style);

  var toast = document.createElement("div");
  toast.id = "jarvis-edit-toast";
  toast.textContent = "Saved";
  document.body.appendChild(toast);

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(function () { toast.classList.remove("show"); }, 1200);
  }

  document.querySelectorAll(EDITABLE).forEach(function (el) {
    if (el.closest("a") && el.tagName !== "A") return;
    if (!el.textContent || !el.textContent.trim()) return;
    el.setAttribute("data-jarvis-editable", "1");
  });

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!(t instanceof HTMLElement)) return;
    var editable = t.closest("[data-jarvis-editable]");
    if (!editable) return;
    if (editable.tagName === "A") e.preventDefault();
    if (editable.getAttribute("contenteditable") === "true") return;
    editable.setAttribute("contenteditable", "true");
    editable.focus();
    var range = document.createRange();
    range.selectNodeContents(editable);
    var sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  }, true);

  document.addEventListener("focusout", function (e) {
    var t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.getAttribute("contenteditable") !== "true") return;
    t.removeAttribute("contenteditable");
    queueSave();
  }, true);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      var active = document.activeElement;
      if (active instanceof HTMLElement && active.getAttribute("contenteditable") === "true") {
        active.blur();
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      var act = document.activeElement;
      if (act instanceof HTMLElement && act.getAttribute("contenteditable") === "true" && /^H[1-6]$|^BUTTON$|^A$|^LABEL$|^SPAN$/.test(act.tagName)) {
        e.preventDefault();
        act.blur();
      }
    }
  }, true);

  function queueSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var clone = document.documentElement.cloneNode(true);
      var s = clone.querySelector("#jarvis-edit-script"); if (s) s.remove();
      var st = clone.querySelector("#jarvis-edit-style"); if (st) st.remove();
      var ts = clone.querySelector("#jarvis-edit-toast"); if (ts) ts.remove();
      clone.querySelectorAll("[data-jarvis-editable]").forEach(function (el) {
        el.removeAttribute("data-jarvis-editable");
        el.removeAttribute("contenteditable");
      });
      var html = "<!doctype html>\\n" + clone.outerHTML;
      window.parent.postMessage({ type: "jarvis:save", html: html }, "*");
      showToast("Saved");
    }, 400);
  }
})();
</script>
`;

export function injectEditScript(html: string): string {
  if (!html) return html;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${INLINE_EDIT_SCRIPT}</body>`);
  }
  return html + INLINE_EDIT_SCRIPT;
}
