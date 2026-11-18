import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS } from "~/sanity/i18n";
import { buildLanguageLinks } from "./language-links";

// Fixtures derive from `sanity/i18n.ts`; the cases needing a second language self-skip on a single-locale build.
const secondary: string = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;
const secondaryHome = `/${secondary}`;
const homes = new Map([
  [DEFAULT_LOCALE, "/"],
  [secondary, secondaryHome],
]);

function hrefs(links: ReturnType<typeof buildLanguageLinks>) {
  return Object.fromEntries(links.map(({ locale, href }) => [locale, href]));
}

describe("buildLanguageLinks", { skip: !IS_I18N_ENABLED }, () => {
  it("links each language to the page's own translation", () => {
    const links = buildLanguageLinks({
      locale: DEFAULT_LOCALE,
      uri: "/about",
      alternates: [
        { language: DEFAULT_LOCALE, uri: "/about" },
        { language: secondary, uri: `${secondaryHome}/chi-siamo` },
      ],
      homeUriByLocale: homes,
    });

    assert.deepEqual(hrefs(links), { [DEFAULT_LOCALE]: "/about", [secondary]: `${secondaryHome}/chi-siamo` });
    assert.deepEqual(
      links.map(({ locale }) => locale),
      LOCALE_IDS.filter((id) => id in hrefs(links))
    );
    assert.equal(links.find(({ isCurrent }) => isCurrent)?.locale, DEFAULT_LOCALE);
  });

  it("falls back to the other language's homepage when the page is untranslated", () => {
    const links = buildLanguageLinks({ locale: DEFAULT_LOCALE, uri: "/about", alternates: null, homeUriByLocale: homes });

    assert.equal(hrefs(links)[secondary], secondaryHome);
  });

  it("keeps a noindex translation, which readers can still visit", () => {
    const links = buildLanguageLinks({
      locale: DEFAULT_LOCALE,
      uri: "/about",
      alternates: [{ language: secondary, uri: `${secondaryHome}/chi-siamo`, noIndex: true }],
      homeUriByLocale: homes,
    });

    assert.equal(hrefs(links)[secondary], `${secondaryHome}/chi-siamo`);
  });

  it("offers nothing when no other language has anywhere to go", () => {
    const links = buildLanguageLinks({
      locale: DEFAULT_LOCALE,
      uri: "/about",
      alternates: [{ language: "zz", uri: "/zz/about" }],
      homeUriByLocale: new Map([[DEFAULT_LOCALE, "/"]]),
    });

    assert.deepEqual(links, []);
  });
});

describe("buildLanguageLinks on a single-locale build", { skip: IS_I18N_ENABLED }, () => {
  it("offers nothing", () => {
    assert.deepEqual(buildLanguageLinks({ locale: DEFAULT_LOCALE, uri: "/", homeUriByLocale: new Map() }), []);
  });
});
