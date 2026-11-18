import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LOCALE,
  getIntlLocale,
  getLocaleTitle,
  getOgLocale,
  getStudioLocaleTitle,
  homeUris,
  IS_I18N_ENABLED,
  isHomeUri,
  isLocale,
  LOCALE_IDS,
  LOCALES,
  localePrefix,
  splitLocalePrefix,
  withLocalePrefix,
} from "./i18n";

// Fixtures derive from the configured locales, so the suite survives a project changing the list.
// Prefix-rule tests need a non-default locale and self-skip on a single-locale build.
const secondary = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;
const secondaryPrefix = `/${secondary}`;

describe("locale config", () => {
  // `DEFAULT_LOCALE` cannot carry `satisfies Locale`: typegen rejects it and every query interpolating it fails to extract.
  it("has a default locale that is one of the configured locales", () => {
    assert.ok(LOCALE_IDS.includes(DEFAULT_LOCALE as (typeof LOCALE_IDS)[number]));
  });

  it("has unique locale ids", () => {
    assert.equal(new Set(LOCALE_IDS).size, LOCALE_IDS.length);
  });

  it("gives every locale the flag of its region", () => {
    for (const entry of LOCALES) {
      const { id, region, flag } = entry as { id: string; region?: string; flag?: string };

      assert.ok(flag, `"${id}" has no flag`);

      if (region) {
        const regional = String.fromCodePoint(...[...region.toUpperCase()].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65));

        assert.equal(flag, regional, `"${id}" shows ${flag}, but its region ${region} is ${regional}`);
      }
    }
  });

  it("names a language in the Studio by its flag and native title", () => {
    for (const { id, title, flag } of LOCALES) {
      assert.equal(getStudioLocaleTitle(id), `${flag} ${title}`);
    }

    assert.equal(getStudioLocaleTitle("zz"), "zz");
  });

  it("uses locale ids that are valid as URL segments and hreflang values", () => {
    for (const id of LOCALE_IDS) {
      assert.match(id, /^[a-z]{2}(-[a-z0-9]{2,8})*$/i, `"${id}" is not a usable BCP 47 identifier`);
    }
  });

  // The media plugin files a legacy plain-string alt text under the first locale.
  it("lists the default locale first", () => {
    assert.equal(LOCALES[0].id, DEFAULT_LOCALE);
  });

  it("gives each region as an ISO 3166 code", () => {
    for (const locale of LOCALES) {
      const { region } = locale as { region?: string };

      if (region !== undefined) {
        assert.match(region, /^[A-Z]{2}$/, `"${locale.id}" has region "${region}"`);
      }
    }
  });

  it("formats with the locale's region and falls back to the default for an unknown locale", () => {
    for (const locale of LOCALE_IDS) {
      assert.ok(getIntlLocale(locale).startsWith(locale), locale);
      assert.doesNotThrow(() => new Intl.DateTimeFormat(getIntlLocale(locale)));
      assert.equal(getOgLocale(locale), getIntlLocale(locale).replace("-", "_"));
    }

    assert.equal(getIntlLocale("zz"), getIntlLocale(DEFAULT_LOCALE));
  });

  it("reports i18n as enabled only for more than one locale", () => {
    assert.equal(IS_I18N_ENABLED, LOCALES.length > 1);
  });

  it("recognises configured locales and rejects anything else", () => {
    assert.ok(isLocale(DEFAULT_LOCALE));
    assert.equal(isLocale("zz"), false);
    assert.equal(isLocale(undefined), false);
  });

  it("falls back to the id when a locale has no title", () => {
    assert.equal(getLocaleTitle(DEFAULT_LOCALE), LOCALES.find(({ id }) => id === DEFAULT_LOCALE)?.title);
    assert.equal(getLocaleTitle("zz"), "zz");
  });
});

describe("localePrefix", () => {
  it("gives the default locale no segment", () => {
    assert.equal(localePrefix(DEFAULT_LOCALE), "");
  });

  it("gives every other locale its own segment", { skip: !IS_I18N_ENABLED }, () => {
    assert.equal(localePrefix(secondary), secondaryPrefix);
  });

  it("gives an unknown locale no segment", () => {
    assert.equal(localePrefix("zz"), "");
  });
});

describe("withLocalePrefix", () => {
  it("leaves default-locale paths untouched", () => {
    assert.equal(withLocalePrefix(DEFAULT_LOCALE, "/about"), "/about");
    assert.equal(withLocalePrefix(DEFAULT_LOCALE, "/"), "/");
  });

  it("prefixes every other locale", { skip: !IS_I18N_ENABLED }, () => {
    assert.equal(withLocalePrefix(secondary, "/chi-siamo"), `${secondaryPrefix}/chi-siamo`);
    assert.equal(withLocalePrefix(secondary, "/blog/ciao"), `${secondaryPrefix}/blog/ciao`);
  });

  it("collapses a prefixed home path to the bare prefix", { skip: !IS_I18N_ENABLED }, () => {
    assert.equal(withLocalePrefix(secondary, "/"), secondaryPrefix);
  });
});

describe("splitLocalePrefix", () => {
  it("treats an unprefixed path as the default locale", () => {
    assert.deepEqual(splitLocalePrefix("/about"), { locale: DEFAULT_LOCALE, localeInPath: null, pathname: "/about" });
  });

  it("strips a known locale prefix", { skip: !IS_I18N_ENABLED }, () => {
    assert.deepEqual(splitLocalePrefix(`${secondaryPrefix}/chi-siamo`), {
      locale: secondary,
      localeInPath: secondary,
      pathname: "/chi-siamo",
    });
  });

  it("resolves a bare locale prefix to the home path", { skip: !IS_I18N_ENABLED }, () => {
    assert.deepEqual(splitLocalePrefix(secondaryPrefix), { locale: secondary, localeInPath: secondary, pathname: "/" });
  });

  // No stored URI carries it, but the request path may; reporting it is what drives the 301.
  it("reports the redundant default-locale prefix", () => {
    assert.deepEqual(splitLocalePrefix(`/${DEFAULT_LOCALE}/about`), {
      locale: DEFAULT_LOCALE,
      localeInPath: DEFAULT_LOCALE,
      pathname: "/about",
    });
  });

  it("leaves a first segment that is not a locale alone", () => {
    assert.deepEqual(splitLocalePrefix(`/blog/${secondary}`), {
      locale: DEFAULT_LOCALE,
      localeInPath: null,
      pathname: `/blog/${secondary}`,
    });
  });

  // Works unguarded: the default locale's own prefix is recognised in a path on any build.
  it("handles the root and trailing slashes", () => {
    assert.equal(splitLocalePrefix("/").pathname, "/");
    assert.equal(splitLocalePrefix(`${secondaryPrefix}/`).pathname, "/");
    assert.equal(splitLocalePrefix(`${secondaryPrefix}/blog/`).pathname, "/blog");
  });

  it("round-trips with withLocalePrefix", () => {
    for (const locale of LOCALE_IDS) {
      for (const path of ["/", "/about", "/blog/ciao", "/blog/authors/ciao"]) {
        const uri = withLocalePrefix(locale, path);
        const split = splitLocalePrefix(uri);

        assert.equal(split.locale, locale, uri);
        assert.equal(split.pathname, path, uri);
      }
    }
  });
});

describe("isHomeUri", () => {
  it("lists one home path per locale, the default's unprefixed", () => {
    assert.deepEqual(
      homeUris(),
      LOCALE_IDS.map((locale) => (locale === DEFAULT_LOCALE ? "/" : `/${locale}`))
    );

    for (const uri of homeUris()) {
      assert.ok(isHomeUri(uri), uri);
    }
  });

  it("is false for any other path", () => {
    assert.equal(isHomeUri("/about"), false);
    assert.equal(isHomeUri(`${secondaryPrefix}/chi-siamo`), false);
  });
});
