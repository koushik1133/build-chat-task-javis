import { describe, expect, it } from "vitest";
import { scanSource } from "@/lib/a11y/scan";

const rules = (s: string) => scanSource(s).map((f) => f.rule);

describe("a11y scan", () => {
  it("flags img without alt, accepts alt and empty alt", () => {
    expect(rules('<img src="a" />')).toEqual(["img-alt"]);
    expect(rules('<img src="a" alt="" />')).toEqual([]);
    expect(rules("<img {...p} />")).toEqual([]);
  });
  it("flags icon-only buttons", () => {
    expect(rules("<button onClick={x}><X className=\"h-4\" /></button>")).toEqual(["icon-only-button"]);
    expect(rules('<button aria-label="Close"><X /></button>')).toEqual([]);
    expect(rules("<button><X /> Save</button>")).toEqual([]);
    expect(rules('<button><X /><span className="sr-only">Close</span></button>')).toEqual([]);
    expect(rules("<Button size=\"icon\" onClick={() => a > b}><Trash2 className=\"h-4 w-4\" /></Button>")).toEqual(["icon-only-button"]);
  });
  it("flags unlabelled fields", () => {
    expect(rules('<input value={v} onChange={f} />')).toEqual(["form-control-label"]);
    expect(rules('<input aria-label="x" />')).toEqual([]);
    expect(rules('<label>Name <input value={v} /></label>')).toEqual([]);
    expect(rules('<label htmlFor="a">A</label><input id="a" />')).toEqual([]);
    expect(rules('<input type="hidden" name="a" />')).toEqual([]);
    expect(rules("<select onChange={f}><option>a</option></select>")).toEqual(["form-control-label"]);
  });
  it("flags clickable non-interactive elements", () => {
    expect(rules("<div onClick={go}>x</div>")).toEqual(["click-non-interactive"]);
    expect(rules('<div role="button" tabIndex={0} onKeyDown={k} onClick={go}>x</div>')).toEqual([]);
    expect(rules("<div onClick={(e) => e.stopPropagation()}>x</div>")).toEqual([]);
  });
  it("flags target blank, positive tabindex, aria-hidden focusable", () => {
    expect(rules('<a href="x" target="_blank">x</a>')).toEqual(["blank-rel"]);
    expect(rules('<a href="x" target="_blank" rel="noopener noreferrer">x</a>')).toEqual([]);
    expect(rules('<div tabIndex={3} />')).toEqual(["positive-tabindex"]);
    expect(rules('<button aria-hidden="true">x</button>')).toEqual(["aria-hidden-focusable"]);
  });
  it("warns on autoFocus and untyped buttons in forms", () => {
    const f = scanSource("<form><button>Go</button><span autoFocus /></form>");
    expect(f.map((x) => x.rule).sort()).toEqual(["autofocus", "button-type"]);
    expect(f.every((x) => x.severity === "warn")).toBe(true);
  });
  it("ignores comparisons and generics", () => {
    expect(rules("const a = x <y && z > 1; const b: Array<string> = [];")).toEqual([]);
  });
});
