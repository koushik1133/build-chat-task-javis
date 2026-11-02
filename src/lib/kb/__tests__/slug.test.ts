import { describe, expect, it } from "vitest";
import { excerptFromMarkdown, isValidSlug, slugify, uniqueSlug } from "@/lib/kb/slug";

describe("slugify", () => {
  it("lowercases, strips punctuation and collapses separators", () => {
    expect(slugify("How do I reset my password?")).toBe("how-do-i-reset-my-password");
    expect(slugify("  Multiple   spaces -- and dashes  ")).toBe("multiple-spaces-and-dashes");
    expect(slugify("It's John's FAQ")).toBe("its-johns-faq");
  });

  it("strips diacritics and unicode", () => {
    expect(slugify("Café — résumé üploads")).toBe("cafe-resume-uploads");
  });

  it("never returns an empty slug and respects the max length", () => {
    expect(slugify("???")).toBe("article");
    expect(slugify("")).toBe("article");
    const long = slugify("a".repeat(50) + " " + "b".repeat(50));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith("-")).toBe(false);
  });
});

describe("isValidSlug", () => {
  it("accepts kebab-case and rejects everything else", () => {
    expect(isValidSlug("getting-started")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
    expect(isValidSlug("-leading")).toBe(false);
    expect(isValidSlug("Upper")).toBe(false);
    expect(isValidSlug("has space")).toBe(false);
    expect(isValidSlug("")).toBe(false);
  });
});

describe("uniqueSlug", () => {
  it("returns the base when free and suffixes -2, -3 otherwise", () => {
    const taken = new Set(["faq", "faq-2"]);
    expect(uniqueSlug("faq", (c) => taken.has(c))).toBe("faq-3");
    expect(uniqueSlug("new", (c) => taken.has(c))).toBe("new");
  });
});

describe("excerptFromMarkdown", () => {
  it("drops markdown syntax and truncates on a word boundary", () => {
    const md = "## Title\n\nSome **bold** text with a [link](https://x.y) and `code`.\n\n```js\nconsole.log(1)\n```\n\nMore words here.";
    expect(excerptFromMarkdown(md)).toBe("Title Some bold text with a link and . More words here.");
    const long = excerptFromMarkdown("word ".repeat(100), 50);
    expect(long.length).toBeLessThanOrEqual(51);
    expect(long.endsWith("…")).toBe(true);
  });
});
