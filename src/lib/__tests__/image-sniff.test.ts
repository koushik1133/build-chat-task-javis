import { describe, expect, it } from "vitest";
import { isSafeSvg, sniffImage } from "@/lib/image-sniff";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]);
const ico = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(16)]);

describe("sniffImage", () => {
  it("identifies raster formats by magic bytes regardless of the declared type", () => {
    expect(sniffImage(png, "image/svg+xml")).toEqual({ mime: "image/png", ext: "png" });
    expect(sniffImage(jpeg, "image/png")).toEqual({ mime: "image/jpeg", ext: "jpg" });
    expect(sniffImage(webp, "image/webp")).toEqual({ mime: "image/webp", ext: "webp" });
    expect(sniffImage(ico, "image/x-icon")).toEqual({ mime: "image/x-icon", ext: "ico" });
  });

  it("rejects HTML / text disguised as an image", () => {
    expect(sniffImage(Buffer.from("<html><script>alert(1)</script></html>"), "image/png")).toBeNull();
    expect(sniffImage(Buffer.from("<svg><script>alert(1)</script></svg>"), "image/png")).toBeNull();
    expect(sniffImage(Buffer.alloc(0), "image/png")).toBeNull();
  });

  it("accepts a static SVG only when declared as SVG", () => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><circle r="4" fill="url(#g)"/><use href="#a"/></svg>');
    expect(sniffImage(svg, "image/svg+xml")).toEqual({ mime: "image/svg+xml", ext: "svg" });
    expect(sniffImage(svg, "image/png")).toBeNull();
  });
});

describe("isSafeSvg", () => {
  it("refuses scripts, event handlers, javascript: URLs, entities and external references", () => {
    expect(isSafeSvg('<svg><script>alert(1)</script></svg>')).toBe(false);
    expect(isSafeSvg('<svg onload="alert(1)"></svg>')).toBe(false);
    expect(isSafeSvg('<svg><a href="javascript:alert(1)"><text>x</text></a></svg>')).toBe(false);
    expect(isSafeSvg('<svg><foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject></svg>')).toBe(false);
    expect(isSafeSvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>')).toBe(false);
    expect(isSafeSvg('<svg><image xlink:href="https://evil.example/t.png"/></svg>')).toBe(false);
    expect(isSafeSvg('<svg><image href="data:text/html,x"/></svg>')).toBe(false);
    expect(isSafeSvg('<svg><style>@import url(https://evil.example/x.css)</style></svg>')).toBe(false);
    expect(isSafeSvg('<svg><rect style="fill:url(https://evil.example/x)"/></svg>')).toBe(false);
    expect(isSafeSvg("not svg at all")).toBe(false);
  });

  it("accepts ordinary logo markup", () => {
    expect(isSafeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><path d="M0 0h10v10z" fill="url(#g)"/></svg>')).toBe(true);
    expect(isSafeSvg('<!-- logo -->\n<svg><use xlink:href="#icon"/></svg>')).toBe(true);
  });
});
