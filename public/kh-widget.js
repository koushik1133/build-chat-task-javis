/*! KernelHub website widget (chat, lead, booking, help). See /settings/widgets for the embed snippet. */
( () => {
"use strict";
if (window.__khWidgetLoaded) return;
window.__khWidgetLoaded = true;
var script = document.currentScript || ( () => { var s = document.querySelectorAll("script[data-site]"); return s[s.length - 1]; })();
if (!script) return;
var ds = script.dataset || {}, SITE = ds.site;
if (!SITE) return;
var BASE = (ds.base || ( () => { try { return new URL(script.src).origin; } catch (e) { return ""; } })()).replace(/\/$/, "");
var CONSENT_MSG = "Please tick the consent box to continue.", NAME_MSG = "Please enter your name and a valid email.", MODES = ["chat", "lead", "booking", "help"], P = "/api/widget/", CH = P + "chat/" + SITE + "/";
var ov = {
mode: MODES.indexOf(ds.mode) >= 0 ? ds.mode : null,
color: /^#[0-9a-fA-F]{6}$/.test(ds.color || "") ? ds.color : null,
position: ds.position === "bottom-left" || ds.position === "bottom-right" ? ds.position : null,
greeting: ds.greeting ? String(ds.greeting).slice(0, 200) : null,
consent: ["required", "optional", "off"].indexOf(ds.consent) >= 0 ? ds.consent : null
};
var LS = "kh-widget:" + SITE;
function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(LS + ":" + k) || "null"); localStorage.setItem(LS + ":" + k, JSON.stringify(v)); } catch (e) { return null; } }
var visitorId = store("visitor") || ( () => { var v = "v-" + Math.random().toString(36).slice(2) + Date.now().toString(36); store("visitor", v); return v; })();
function readable(hex) {
var n = parseInt(hex.slice(1), 16);
function c(x) { x = ((n >> x) & 255) / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
return 0.2126 * c(16) + 0.7152 * c(8) + 0.0722 * c(0) > 0.45 ? "#111" : "#fff";
}
function each(a, fn) { Array.prototype.forEach.call(a, fn); }
function v(x) { return x.value.trim(); }
function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function api(path, o) {
o = o || {};
var h = { "Content-Type": "application/json" };
if (o.token) h.Authorization = "Bearer " + o.token;
var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
var t = ctrl && setTimeout( () => { ctrl.abort(); }, o.timeout || 30000);
return fetch(BASE + path, { method: o.method || "GET", headers: h, body: o.body ? JSON.stringify(o.body) : undefined, signal: ctrl ? ctrl.signal : undefined })
.then( (r) => { return r.text().then( (txt) => { var j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) {} if (!r.ok) { var err = new Error((j && (j.error || j.detail)) || ("HTTP " + r.status)); err.status = r.status; throw err; } return j; }); })
.finally( () => { if (t) clearTimeout(t); });
}
function el(tag, attrs, children) {
var e = document.createElement(tag);
if (attrs) for (var k in attrs) { if (k === "text") e.textContent = attrs[k]; else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2), attrs[k]); else if (attrs[k] != null) e.setAttribute(k, attrs[k]); }
(children || []).forEach( (c) => { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
return e;
}
function inp(name, type, extra) { var a = { name: name, type: type || "text", autocomplete: { name: "name", email: "email", phone: "tel" }[name] || null }; for (var k in extra || {}) a[k] = extra[k]; return el("input", a); }
function contactFields(f, n, e, p) { f.appendChild(lbl("Name", n)); f.appendChild(lbl("Email", e)); f.appendChild(lbl("Phone (optional)", p)); }
function lbl(text, ctl) { return el("label", null, [text, ctl]); }
function form(intro) { var f = el("form", { class: "kh-form", novalidate: "" }); if (intro) f.appendChild(el("p", { class: "kh-mut", text: intro })); return f; }
function err() { return el("p", { class: "kh-err", role: "alert" }); }
function primary(text) { return el("button", { class: "kh-primary", type: "submit", text: text }); }
function link(text, fn) { return el("button", { class: "kh-link", type: "button", text: text, onclick: fn }); }
function ok(text) { clear(); body.appendChild(el("p", { class: "kh-ok", role: "status", text: text })); }

var CSS = ":host{all:initial}*{box-sizing:border-box;font-family:system-ui,sans-serif}" +
".kh-root{position:fixed;bottom:20px;z-index:2147483000;--c:#f97316;--cf:#fff;--bg:#fff;--fg:#111827;--mut:#6b7280;--bd:#e5e7eb;--sub:#f3f4f6}.kh-root.right{right:20px}.kh-root.left{left:20px}" +
"@media(prefers-color-scheme:dark){.kh-root{--bg:#111827;--fg:#f9fafb;--mut:#9ca3af;--bd:#374151;--sub:#1f2937}}" +
".kh-btn{display:inline-flex;align-items:center;gap:8px;background:var(--c);color:var(--cf);border:0;border-radius:999px;padding:12px 18px;font-size:15px;font-weight:600;cursor:pointer;box-shadow:0 8px 24px #0003;min-height:44px}" +
".kh-root :focus-visible{outline:3px solid var(--c);outline-offset:2px}" +
".kh-panel{position:absolute;bottom:60px;width:360px;max-width:calc(100vw - 40px);height:560px;max-height:calc(100vh - 100px);background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-radius:16px;box-shadow:0 24px 64px #0004;display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateY(8px);pointer-events:none;transition:opacity .18s,transform .18s}" +
".right .kh-panel{right:0}.left .kh-panel{left:0}.kh-panel.open{opacity:1;transform:none;pointer-events:auto}" +
"@media(max-width:600px){.kh-panel{position:fixed;inset:0;width:auto;max-width:none;height:auto;max-height:none;border-radius:0}}" +
"@media(prefers-reduced-motion:reduce){.kh-panel{transition:none}}" +
".kh-head{background:var(--c);color:var(--cf);padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:8px}.kh-head h2{margin:0;font-size:16px;font-weight:700}.kh-head p{margin:2px 0 0;font-size:12px;opacity:.9}" +
".kh-x{background:#fff3;color:inherit;border:0;border-radius:8px;width:36px;height:36px;font-size:20px;cursor:pointer;line-height:1}" +
".kh-tabs{display:flex;border-bottom:1px solid var(--bd);background:var(--sub)}.kh-tabs button{flex:1;background:none;border:0;border-bottom:2px solid transparent;padding:10px 4px;font-size:12px;font-weight:600;color:var(--mut);cursor:pointer;min-height:40px}.kh-tabs button[aria-selected=true]{color:var(--c);border-bottom-color:var(--c)}" +
".kh-body{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px}" +
".kh-msg{max-width:85%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}.kh-msg.u{align-self:flex-end;background:var(--c);color:var(--cf);border-bottom-right-radius:4px}.kh-msg.a{align-self:flex-start;background:var(--sub);border-bottom-left-radius:4px}.kh-sys{font-size:12px;color:var(--mut);text-align:center;padding:4px}" +
".kh-foot{border-top:1px solid var(--bd);padding:10px;display:flex;gap:8px;align-items:flex-end}.kh-foot textarea{flex:1;resize:none;border:1px solid var(--bd);border-radius:10px;padding:10px;font-size:14px;background:var(--bg);color:var(--fg);min-height:44px;max-height:120px}" +
".kh-send{background:var(--c);color:var(--cf);border:0;border-radius:10px;min-width:44px;height:44px;font-weight:700;cursor:pointer}" +
".kh-form{display:flex;flex-direction:column;gap:10px}.kh-form label{font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px}.kh-form input,.kh-form textarea,.kh-form select{border:1px solid var(--bd);border-radius:10px;padding:10px;font-size:14px;background:var(--bg);color:var(--fg);min-height:44px;width:100%}.kh-form textarea{min-height:80px;resize:vertical}" +
".kh-check{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--mut);font-weight:400!important;flex-direction:row!important}.kh-check input{width:18px;height:18px;min-height:0;margin-top:2px;flex:none}" +
".kh-primary{background:var(--c);color:var(--cf);border:0;border-radius:10px;padding:12px;font-size:14px;font-weight:700;cursor:pointer;min-height:44px}.kh-root button:disabled{opacity:.5;cursor:not-allowed}.kh-link{background:none;border:0;color:var(--c);font-size:13px;font-weight:600;cursor:pointer;padding:8px;text-decoration:underline}" +
".kh-err{color:#dc2626;font-size:13px;margin:0}.kh-ok{color:#059669;font-size:14px}.kh-mut{color:var(--mut);font-size:13px;margin:0}" +
".kh-slots{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.kh-slots button,.kh-days button{border:1px solid var(--bd);background:var(--bg);color:var(--fg);border-radius:8px;padding:8px 4px;font-size:12px;cursor:pointer;min-height:40px}.kh-slots [aria-pressed=true],.kh-days [aria-pressed=true]{background:var(--c);color:var(--cf);border-color:var(--c)}.kh-days{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px}.kh-days button{flex:none;min-width:64px}" +
".kh-art{border:1px solid var(--bd);border-radius:10px;padding:10px;display:block;color:inherit;text-decoration:none}.kh-art strong{display:block;font-size:14px}.kh-art span{font-size:12px;color:var(--mut)}" +
".kh-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}";

var cfg, host, root, panel, btn, body, tabsEl, live, openState = false, mode, chatTimer = null;
var session = { token: store("token"), status: null, lastTs: null, msgs: [] };

function mount(c) {
cfg = c;
mode = ov.mode && c.modes.indexOf(ov.mode) >= 0 ? ov.mode : c.defaultMode;
host = el("div", { id: "kh-widget-host" });
root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
var wrap = el("div", { class: "kh-root " + ((ov.position || c.position) === "bottom-left" ? "left" : "right") });
wrap.style.setProperty("--c", ov.color || c.color);
wrap.style.setProperty("--cf", ov.color ? readable(ov.color) : c.colorForeground);
root.appendChild(el("style", { text: CSS }));
btn = el("button", { class: "kh-btn", type: "button", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "kh-panel", onclick: toggle }, [
el("span", { "aria-hidden": "true", text: "💬" }), el("span", { text: mode === "booking" ? "Book now" : mode === "help" ? "Help" : "Chat with us" })]);
panel = el("div", { class: "kh-panel", id: "kh-panel", role: "dialog", "aria-label": c.brandName + " widget", hidden: "" });
panel.appendChild(el("div", { class: "kh-head" }, [
el("div", null, [el("h2", { text: c.brandName }), el("p", { text: c.siteTitle || "We usually reply quickly" })]),
el("button", { class: "kh-x", type: "button", "aria-label": "Close", onclick: toggle, text: "×" })]));
if (c.modes.length > 1) {
tabsEl = el("div", { class: "kh-tabs", role: "tablist", "aria-label": "Widget sections" });
c.modes.forEach( (m) => {
tabsEl.appendChild(el("button", { type: "button", role: "tab", "data-mode": m, "aria-selected": String(m === mode), text: { chat: "Chat", lead: "Contact", booking: "Book", help: "Help" }[m], onclick: () => { setMode(m); }, onkeydown: tabKeys }));
});
panel.appendChild(tabsEl);
}
live = el("div", { class: "kh-sr", "aria-live": "polite" });
body = el("div", { class: "kh-body", role: "tabpanel" });
panel.appendChild(live); panel.appendChild(body);
wrap.appendChild(panel); wrap.appendChild(btn); root.appendChild(wrap);
document.body.appendChild(host);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openState) toggle(); });
render();
}
function tabKeys(e) {
var tabs = Array.prototype.slice.call(tabsEl.querySelectorAll("[role=tab]")), i = tabs.indexOf(e.target);
if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); var n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]; n.focus(); setMode(n.getAttribute("data-mode")); }
}
function setMode(m) {
mode = m;
if (tabsEl) each(tabsEl.querySelectorAll("[role=tab]"), (t) => { t.setAttribute("aria-selected", String(t.getAttribute("data-mode") === m)); });
render();
}
function toggle() {
openState = !openState;
btn.setAttribute("aria-expanded", String(openState));
if (openState) { panel.removeAttribute("hidden"); requestAnimationFrame( () => { panel.classList.add("open"); var f = panel.querySelector("textarea,input,.kh-primary"); if (f) f.focus(); }); if (mode === "chat") startPolling(); }
else { panel.classList.remove("open"); setTimeout( () => { if (!openState) panel.setAttribute("hidden", ""); }, 200); stopPolling(); btn.focus(); }
}
function clear() { body.textContent = ""; var f = panel.querySelector(".kh-foot"); if (f) f.remove(); }
function render() {
clear(); stopPolling();
({ chat: renderChat, lead: renderLead, booking: renderBooking, help: renderHelp })[mode]();
}

function consentField(f) {
var cm = ov.consent || cfg.consentMode;
if (cm === "off") return { value: () => { return undefined; }, ok: () => { return true; }, bind: () => {} };
var cb = el("input", { type: "checkbox", name: "consent", "aria-required": cm === "required" ? "true" : null });
f.appendChild(el("label", { class: "kh-check" }, [cb, el("span", { text: cfg.consentText + (cm === "required" ? " (required)" : "") })]));
return { value: () => { return { marketing: cb.checked }; }, ok: () => { return cm !== "required" || cb.checked; }, bind: (submit) => { var u = () => { submit.disabled = cm === "required" && !cb.checked; }; cb.addEventListener("change", u); u(); } };
}

function renderChat() {
if (!session.msgs.length) body.appendChild(el("div", { class: "kh-msg a", text: ov.greeting || cfg.greeting }));
session.msgs.forEach( (m) => { body.appendChild(msgNode(m)); });
body.appendChild(el("div", { class: "kh-sys", id: "kh-tail" }, [link("Leave your details", renderHandoff)]));
var ta = el("textarea", { rows: "1", placeholder: "Type a message…", "aria-label": "Your message", maxlength: "2000", onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } } });
var sb = el("button", { class: "kh-send", type: "button", "aria-label": "Send", text: "➤", onclick: send });
panel.appendChild(el("div", { class: "kh-foot" }, [ta, sb]));
scrollEnd();
if (openState) startPolling();
function send() {
var text = v(ta); if (!text) return;
ta.value = ""; sb.disabled = true;
addMsg({ role: "user", content: text, ts: new Date().toISOString() });
var typing = sys("…");
ensureSession().then( () => { return api(CH + "messages", { method: "POST", token: session.token, body: { text: text } }); })
.then( (r) => {
typing.remove();
if (r.reply) addMsg(r.reply); else sys("Thanks — a team member will reply here shortly.");
if (r.now) session.lastTs = r.now;
}).catch( (e) => {
typing.remove();
if (e.status === 401 || e.status === 410) { dropSession(); sys("Session expired — please send that again."); }
else sys(e.status === 429 ? "Too many messages — please wait a moment." : "Message failed to send. Please try again.");
}).finally( () => { sb.disabled = false; ta.focus(); });
}
}
function msgNode(m) { return el("div", { class: "kh-msg " + (m.role === "user" ? "u" : "a"), text: m.content }); }
function addMsg(m) {
session.msgs.push(m);
if (!session.lastTs || m.ts > session.lastTs) session.lastTs = m.ts;
var tail = body.querySelector("#kh-tail"), node = msgNode(m);
if (tail) body.insertBefore(node, tail); else body.appendChild(node);
if (m.role !== "user") live.textContent = "New reply: " + m.content;
scrollEnd();
}
function sys(t) { var n = el("div", { class: "kh-sys", text: t }); body.appendChild(n); scrollEnd(); return n; }
function scrollEnd() { body.scrollTop = body.scrollHeight; }
function dropSession() { session.token = null; store("token", null); }
function ensureSession() {
if (session.token) return Promise.resolve();
return api(CH + "session", { method: "POST", body: { visitorId: visitorId, pageUrl: location.href.slice(0, 1000) } }).then( (r) => { session.token = r.token; session.status = r.status; store("token", r.token); });
}
function startPolling() {
if (!session.token || chatTimer) return;
var tick = () => {
api(CH + "messages?wait=15000" + (session.lastTs ? "&since=" + encodeURIComponent(session.lastTs) : ""), { token: session.token, timeout: 25000 })
.then( (r) => {
var n = 0;
(r.messages || []).forEach( (m) => { if (!session.msgs.some( (x) => { return x.ts === m.ts && x.content === m.content; })) { addMsg(m); n++; } });
if (!session.lastTs && r.now) session.lastTs = r.now;
session.status = r.status;
chatTimer = setTimeout(tick, n ? 500 : 1500);
}).catch( (e) => { if (e.status === 401) { dropSession(); chatTimer = null; return; } chatTimer = setTimeout(tick, 8000); });
};
chatTimer = setTimeout(tick, 300);
}
function stopPolling() { if (chatTimer) { clearTimeout(chatTimer); chatTimer = null; } }
function renderHandoff() {
clear(); stopPolling();
var e = err(), f = form("Leave your details and we will follow up."), name = inp("name"), email = inp("email", "email"), phone = inp("phone", "tel");
contactFields(f, name, email, phone);
var consent = consentField(f), submit = primary("Send my details");
f.appendChild(submit); f.appendChild(e); f.appendChild(link("← Back to chat", render));
consent.bind(submit);
f.addEventListener("submit", (ev) => {
ev.preventDefault(); e.textContent = "";
if (!v(name)) return (e.textContent = "Please enter your name.");
if (!v(email) && !v(phone)) return (e.textContent = "Please give us an email or phone number.");
if (!consent.ok()) return (e.textContent = CONSENT_MSG);
submit.disabled = true;
ensureSession().then( () => { return api(CH + "handoff", { method: "POST", token: session.token, body: { name: v(name), email: v(email), phone: v(phone), consent: consent.value() } }); })
.then( (r) => { session.msgs = r.messages || session.msgs; if (session.msgs.length) session.lastTs = session.msgs[session.msgs.length - 1].ts; render(); })
.catch( (x) => { e.textContent = x.status === 429 ? "Too many attempts — please try later." : "Could not send. Please try again."; submit.disabled = false; });
});
body.appendChild(f); name.focus();
}

function renderLead() {
var e = err(), f = form("Send us a message and we will get back to you."), name = inp("name"), email = inp("email", "email"), phone = inp("phone", "tel"), msg = el("textarea", { name: "message", maxlength: "2000" });
contactFields(f, name, email, phone); f.appendChild(lbl("Message", msg));
var consent = consentField(f), submit = primary("Send");
f.appendChild(submit); f.appendChild(e); consent.bind(submit);
f.addEventListener("submit", (ev) => {
ev.preventDefault(); e.textContent = "";
if (!v(name) || !isEmail(v(email))) return (e.textContent = NAME_MSG);
if (!consent.ok()) return (e.textContent = CONSENT_MSG);
submit.disabled = true;
var payload = { name: v(name), email: v(email), phone: v(phone), message: v(msg), page_url: location.href.slice(0, 500) }, c = consent.value();
if (c) payload.consent = c;
api("/api/leads/widget/" + SITE, { method: "POST", body: payload }).then( () => { ok("Thanks! We will be in touch soon."); })
.catch( () => { e.textContent = "Could not send. Please try again."; submit.disabled = false; });
});
body.appendChild(f);
}

function renderBooking() {
var types = cfg.bookingTypes || [];
if (!types.length) return body.appendChild(el("p", { class: "kh-mut", text: "Online booking is unavailable right now." }));
var e = err(), f = form(), sel = el("select", { name: "type", "aria-label": "Appointment type" });
types.forEach( (t) => { sel.appendChild(el("option", { value: t.slug, text: t.name + " · " + t.durationMinutes + " min" })); });
var days = el("div", { class: "kh-days", role: "group", "aria-label": "Choose a day" }), slots = el("div", { class: "kh-slots", role: "group", "aria-label": "Choose a time" }), picked = null, tz;
var name = inp("name"), email = inp("email", "email"), phone = inp("phone", "tel");
f.appendChild(lbl("Appointment", sel)); f.appendChild(days); f.appendChild(slots);
contactFields(f, name, email, phone);
var consent = consentField(f), submit = primary("Confirm booking");
f.appendChild(submit); f.appendChild(e); body.appendChild(f); consent.bind(submit);
function press(group, b) { each(group.children, (x) => { x.setAttribute("aria-pressed", "false"); }); b.setAttribute("aria-pressed", "true"); }
function loadSlots() {
days.textContent = "Loading…"; slots.textContent = ""; picked = null;
api(P + "booking/" + SITE + "?type=" + encodeURIComponent(sel.value)).then( (r) => {
tz = r.timezone; days.textContent = "";
var keys = Object.keys(r.byDay || {});
if (!keys.length) return days.appendChild(el("p", { class: "kh-mut", text: "No open times in the next 2 weeks." }));
keys.forEach( (d, i) => {
var b = el("button", { type: "button", "aria-pressed": String(i === 0), text: new Date(d + "T12:00:00").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }), onclick: () => { press(days, b); showDay(r.byDay[d]); } });
days.appendChild(b);
});
showDay(r.byDay[keys[0]]);
}).catch( () => { days.textContent = ""; e.textContent = "Could not load availability."; });
}
function showDay(list) {
slots.textContent = ""; picked = null;
list.forEach( (iso) => {
var b = el("button", { type: "button", "aria-pressed": "false", text: new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: tz || undefined }), onclick: () => { press(slots, b); picked = iso; } });
slots.appendChild(b);
});
}
sel.addEventListener("change", loadSlots); loadSlots();
f.addEventListener("submit", (ev) => {
ev.preventDefault(); e.textContent = "";
if (!picked) return (e.textContent = "Please pick a time.");
if (!v(name) || !isEmail(v(email))) return (e.textContent = NAME_MSG);
if (!consent.ok()) return (e.textContent = CONSENT_MSG);
submit.disabled = true;
var payload = { type: sel.value, name: v(name), email: v(email), startsAt: picked }, c = consent.value();
if (v(phone)) payload.phone = v(phone);
if (c) payload.consent = c;
api(P + "booking/" + SITE, { method: "POST", body: payload }).then( (r) => {
ok("Booked! " + new Date(r.booking.startsAt).toLocaleString([], { dateStyle: "full", timeStyle: "short", timeZone: tz || undefined }) + ". Confirmation sent to " + payload.email + ".");
body.appendChild(el("a", { class: "kh-link", href: BASE + r.cancelPath, target: "_blank", rel: "noopener", text: "Need to cancel?" }));
}).catch( (x) => { e.textContent = x.status === 409 ? "That time was just taken — please pick another." : "Booking failed. Please try again."; submit.disabled = false; if (x.status === 409) loadSlots(); });
});
}

function renderHelp() {
var q = el("input", { type: "search", placeholder: "Search help articles…", "aria-label": "Search help articles" }), list = el("div", { class: "kh-form", "aria-live": "polite" }), t;
body.appendChild(el("div", { class: "kh-form" }, [q])); body.appendChild(list);
function search() {
api(P + "help/" + SITE + "?q=" + encodeURIComponent(v(q))).then( (r) => {
list.textContent = "";
if (!r.articles.length) list.appendChild(el("p", { class: "kh-mut", text: "No articles found." }));
r.articles.forEach( (a) => { list.appendChild(el("a", { class: "kh-art", href: a.url ? BASE + a.url : "#", target: "_blank", rel: "noopener" }, [el("strong", { text: a.title }), el("span", { text: a.excerpt || "" })])); });
var still = el("div", { class: "kh-sys" }, ["Still need help? "]);
if (cfg.modes.indexOf("chat") >= 0) still.appendChild(link("Chat with us", () => { setMode("chat"); }));
still.appendChild(link("Open a ticket", renderTicket));
list.appendChild(still);
}).catch( () => { list.textContent = ""; list.appendChild(el("p", { class: "kh-err", text: "Could not load help articles." })); });
}
q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(search, 300); });
search();
}
function renderTicket() {
clear();
var e = err(), f = form(), name = inp("name"), email = inp("email", "email"), subject = inp("subject", "text", { maxlength: "200" }), msg = el("textarea", { name: "body", maxlength: "5000" });
f.appendChild(lbl("Name", name)); f.appendChild(lbl("Email", email)); f.appendChild(lbl("Subject", subject)); f.appendChild(lbl("How can we help?", msg));
var submit = primary("Open ticket");
f.appendChild(submit); f.appendChild(e); f.appendChild(link("← Back to help", render));
f.addEventListener("submit", (ev) => {
ev.preventDefault(); e.textContent = "";
if (!v(name) || !isEmail(v(email)) || !v(subject) || !v(msg)) return (e.textContent = "Please fill in every field.");
submit.disabled = true;
api("/api/helpdesk/widget/" + SITE, { method: "POST", body: { name: v(name), email: v(email), subject: v(subject), body: v(msg) } })
.then( (r) => { ok("Ticket " + (r.ticket && r.ticket.number ? r.ticket.number : "") + " opened. We will reply by email."); })
.catch( () => { e.textContent = "Could not send. Please try again."; submit.disabled = false; });
});
body.appendChild(f); name.focus();
}

function boot() {
api(P + "config/" + SITE, { timeout: 10000 }).then( (c) => {
if (!c || !c.enabled || !c.modes || !c.modes.length) return;
mount(c);
if (session.token && c.modes.indexOf("chat") >= 0) {
api(CH + "messages", { token: session.token, timeout: 10000 }).then( (r) => {
session.msgs = r.messages || []; session.status = r.status;
if (session.msgs.length) session.lastTs = session.msgs[session.msgs.length - 1].ts;
if (mode === "chat") render();
}).catch(dropSession);
}
}).catch( (e) => { console.warn("[kh-widget]", e && e.message); });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
