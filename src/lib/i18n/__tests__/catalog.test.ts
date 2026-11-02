import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/locales/en";
import { es } from "@/lib/i18n/locales/es";
import { hi } from "@/lib/i18n/locales/hi";
import {
  LOCALES,
  getMessages,
  interpolate,
  localeFromAcceptLanguage,
  makeT,
  resolveLocale,
  t,
  toLocale,
} from "@/lib/i18n";
import { navGroupLabel, navKeyFor, navLabel } from "@/lib/i18n/nav";
import { APP_NAV, NAV_GROUPS } from "@/lib/app-nav";

const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();

describe("message catalogs", () => {
  const enKeys = Object.keys(en).sort();

  it("has a meaningful number of keys", () => {
    expect(enKeys.length).toBeGreaterThanOrEqual(150);
  });

  it.each([
    ["es", es],
    ["hi", hi],
  ])("%s has exactly the keys en has", (_name, catalog) => {
    expect(Object.keys(catalog).sort()).toEqual(enKeys);
  });

  it.each([
    ["es", es],
    ["hi", hi],
  ])("%s has no empty strings and keeps every placeholder", (_name, catalog) => {
    for (const key of enKeys as Array<keyof typeof en>) {
      expect(catalog[key].trim().length, key).toBeGreaterThan(0);
      expect(placeholders(catalog[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it("getMessages returns a complete catalog for every locale", () => {
    for (const locale of LOCALES) {
      expect(Object.keys(getMessages(locale)).sort()).toEqual(enKeys);
    }
  });
});

describe("t / interpolate", () => {
  it("interpolates named vars and leaves unknown placeholders", () => {
    expect(interpolate("Hi {name}, {n} new", { name: "Ana", n: 3 })).toBe("Hi Ana, 3 new");
    expect(interpolate("{missing} stays", {})).toBe("{missing} stays");
  });
  it("translates with vars in each locale", () => {
    expect(t(getMessages("en"), "calendar.minutes", { count: 30 })).toBe("30 min");
    expect(t(getMessages("es"), "auth.continueWith", { provider: "Google" })).toBe("Continuar con Google");
    expect(makeT(getMessages("hi"))("common.save")).toBe("सहेजें");
  });
});

describe("locale detection", () => {
  it("coerces BCP-47 tags", () => {
    expect(toLocale("es-MX")).toBe("es");
    expect(toLocale("HI_IN")).toBe("hi");
    expect(toLocale("fr")).toBeNull();
    expect(toLocale(null)).toBeNull();
  });
  it("parses Accept-Language by q-weight", () => {
    expect(localeFromAcceptLanguage("fr-FR,fr;q=0.9,es;q=0.8,en;q=0.7")).toBe("es");
    expect(localeFromAcceptLanguage("hi-IN;q=0.5,en-US")).toBe("en");
    expect(localeFromAcceptLanguage("de")).toBeNull();
    expect(localeFromAcceptLanguage(null)).toBeNull();
  });
  it("resolves in order org → cookie → header → en", () => {
    expect(resolveLocale({ orgLocale: "hi", cookieLocale: "es", acceptLanguage: "en" })).toBe("hi");
    expect(resolveLocale({ orgLocale: null, cookieLocale: "es", acceptLanguage: "en" })).toBe("es");
    expect(resolveLocale({ orgLocale: "xx", cookieLocale: null, acceptLanguage: "hi-IN" })).toBe("hi");
    expect(resolveLocale({})).toBe("en");
  });
});

describe("nav labels", () => {
  it("every static sidebar href has a catalog key", () => {
    for (const item of APP_NAV) {
      expect(navKeyFor(item.href), item.href).not.toBeNull();
    }
  });
  it("every sidebar group title has a catalog key", () => {
    const tEs = makeT(getMessages("es"));
    for (const g of NAV_GROUPS) {
      expect(navGroupLabel(g.title, tEs), g.title).not.toBe(g.title);
    }
  });
  it("translates labels and falls back for unknown hrefs", () => {
    const tEs = makeT(getMessages("es"));
    expect(navLabel("/billing", tEs, "Billing")).toBe("Facturación");
    expect(navLabel("/settings/team?x=1", tEs, "Team")).toBe("Equipo");
    expect(navLabel("/agents/swarms/abc", tEs)).toBe("Enjambres de agentes");
    expect(navLabel("/nope", tEs, "Nope")).toBe("Nope");
  });
});
