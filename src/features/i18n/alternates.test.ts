import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS } from "~/sanity/i18n";
import { buildAlternateLinks } from "./alternates";

// Fixtures derive from `sanity/i18n.ts`, so the suite survives a project changing the locale list.
// The reciprocity tests need a second locale and self-skip on a single-locale build.
const siteUrl = "https://example.com";
const secondary = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;
const defaultUri = "/about";
const secondaryUri = `/${secondary}/chi-siamo`;

describe("buildAlternateLinks", { skip: !IS_I18N_ENABLED }, () => {
  it("emits nothing when the page has no translations", () => {
    assert.deepEqual(buildAlternateLinks({ siteUrl, locale: DEFAULT_LOCALE, uri: defaultUri, alternates: [] }), []);
  });

  it("emits a reciprocal set including the page itself plus x-default", () => {
    const links = buildAlternateLinks({
      siteUrl,
      locale: DEFAULT_LOCALE,
      uri: defaultUri,
      alternates: [
        { language: DEFAULT_LOCALE, uri: defaultUri },
        { language: secondary, uri: secondaryUri },
      ],
    });

    assert.deepEqual(links, [
      { hreflang: DEFAULT_LOCALE, href: `${siteUrl}${defaultUri}`, path: defaultUri },
      { hreflang: secondary, href: `${siteUrl}${secondaryUri}`, path: secondaryUri },
      { hreflang: "x-default", href: `${siteUrl}${defaultUri}`, path: defaultUri },
    ]);
  });

  it("produces the same set when rendering the translated page", () => {
    const links = buildAlternateLinks({
      siteUrl,
      locale: secondary,
      uri: secondaryUri,
      alternates: [
        { language: DEFAULT_LOCALE, uri: defaultUri },
        { language: secondary, uri: secondaryUri },
      ],
    });

    assert.deepEqual(new Set(links.map(({ href }) => href)), new Set([`${siteUrl}${defaultUri}`, `${siteUrl}${secondaryUri}`]));
    assert.equal(links.at(-1)?.hreflang, "x-default");
  });

  it("drops noindex variants and the x-default that would point at one", () => {
    const links = buildAlternateLinks({
      siteUrl,
      locale: secondary,
      uri: secondaryUri,
      alternates: [
        { language: DEFAULT_LOCALE, uri: defaultUri, noIndex: true },
        { language: secondary, uri: secondaryUri },
      ],
    });

    assert.deepEqual(links, []);
  });

  it("emits nothing for a noindex page", () => {
    const links = buildAlternateLinks({
      siteUrl,
      locale: DEFAULT_LOCALE,
      uri: defaultUri,
      noIndex: true,
      alternates: [{ language: secondary, uri: secondaryUri }],
    });

    assert.deepEqual(links, []);
  });

  it("ignores variants in languages the site does not ship", () => {
    const links = buildAlternateLinks({
      siteUrl,
      locale: DEFAULT_LOCALE,
      uri: defaultUri,
      alternates: [{ language: "zz", uri: "/zz/about" }],
    });

    assert.deepEqual(links, []);
  });

  it("uses the stored home paths verbatim", () => {
    const links = buildAlternateLinks({
      siteUrl,
      locale: DEFAULT_LOCALE,
      uri: "/",
      alternates: [
        { language: DEFAULT_LOCALE, uri: "/" },
        { language: secondary, uri: `/${secondary}` },
      ],
    });

    assert.deepEqual(links, [
      { hreflang: DEFAULT_LOCALE, href: `${siteUrl}/`, path: "/" },
      { hreflang: secondary, href: `${siteUrl}/${secondary}`, path: `/${secondary}` },
      { hreflang: "x-default", href: `${siteUrl}/`, path: "/" },
    ]);
  });
});

describe("buildAlternateLinks on a single-locale build", { skip: IS_I18N_ENABLED }, () => {
  it("emits nothing even when alternates are present", () => {
    const links = buildAlternateLinks({
      siteUrl,
      locale: DEFAULT_LOCALE,
      uri: defaultUri,
      alternates: [{ language: DEFAULT_LOCALE, uri: defaultUri }],
    });

    assert.deepEqual(links, []);
  });
});
