import { describe, expect, it } from "vitest";
import { buildGroups, quickActionsFor, type PaletteItem } from "../palette";

const item = (kind: string, id: string, title: string, href = `/x/${id}`): PaletteItem => ({ kind, id, title, subtitle: null, href });
const labels = { pinned: "Pinned", recent: "Recent", actions: "Actions", pages: "Pages" };

describe("quickActionsFor", () => {
  it("shows only actions the caller can edit", () => {
    expect(quickActionsFor(null)).toEqual([]);
    const ids = quickActionsFor({ crm: { view: true, edit: true }, billing: { view: true, edit: false } }).map((a) => a.id);
    expect(ids).toEqual(["new-contact", "new-campaign"]);
  });
});

describe("buildGroups", () => {
  const base = {
    query: "",
    remoteActive: false,
    pinned: [{ ...item("page", "p", "CRM", "/crm"), pinnedId: "f1" }],
    recents: [item("order", "o1", "ORD-1", "/orders?order=o1"), item("page", "p", "CRM", "/crm")],
    actions: [item("action", "a", "Create task", "/tasks?new=task")],
    pages: [item("page", "h", "Home", "/home")],
    remote: [] as { kind: string; label: string; items: PaletteItem[] }[],
    labels,
  };
  it("idle order is pinned, recent (minus pinned), actions, pages", () => {
    const g = buildGroups(base);
    expect(g.map((x) => x.kind)).toEqual(["pinned", "recent", "action", "page"]);
    expect(g[1].items.map((i) => i.id)).toEqual(["o1"]);
  });
  it("remote results replace pages and mark pinned entries", () => {
    const g = buildGroups({ ...base, query: "crm", remoteActive: true, remote: [{ kind: "contact", label: "Contacts", items: [item("contact", "c1", "CRM Co", "/crm")] }] });
    expect(g.map((x) => x.kind)).toEqual(["pinned", "contact"]);
    const contacts = g.find((x) => x.kind === "contact");
    expect(contacts?.items[0].pinnedId).toBe("f1");
    expect(g.find((x) => x.kind === "page")).toBeUndefined();
  });
  it("hides actions for kind:/in: operator queries", () => {
    const g = buildGroups({ ...base, query: "kind:orders acme", remoteActive: true });
    expect(g.find((x) => x.kind === "action")).toBeUndefined();
  });
});
