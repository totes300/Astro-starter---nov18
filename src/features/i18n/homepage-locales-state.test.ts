import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, parse } from "groq-js";
import { DEFAULT_LOCALE, homeUris, LOCALE_IDS, withLocalePrefix } from "~/sanity/i18n";
import { localeParams } from "./fragment";
import { HOMEPAGE_LOCALES_QUERY, toHomepageLocalesState } from "./homepage-locales-state";

// Bound like the proxy state binds them: an unbound `$locales` matches nothing in groq-js.
async function homeUriByLocale(dataset: Record<string, unknown>[]) {
  const params = localeParams();
  const payload = await (await evaluate(parse(HOMEPAGE_LOCALES_QUERY, { params }), { dataset, params })).get();

  return [...toHomepageLocalesState(payload).homeUriByLocale];
}

test("a password protected homepage is left out, so neither the switcher nor the landing redirect names it", async () => {
  const [home] = homeUris();
  const dataset = [
    { _id: "home", _type: "page", language: DEFAULT_LOCALE, uri: { current: home }, passwordProtected: true },
    { _id: "about", _type: "page", language: DEFAULT_LOCALE, uri: { current: "/about" } },
  ];

  assert.deepEqual(await homeUriByLocale(dataset), []);
});

test("a public homepage is listed by its language, noindex or not", async () => {
  const [home] = homeUris();
  const dataset = [{ _id: "home", _type: "page", uri: { current: home }, seoMetadata: { noIndex: true } }];

  assert.deepEqual(await homeUriByLocale(dataset), [[DEFAULT_LOCALE, home]]);
});

test("a homepage in a language the site does not serve is left out", async () => {
  const [home] = homeUris();
  const dataset = [{ _id: "ghost", _type: "page", language: "zz", uri: { current: home } }];

  assert.deepEqual(await homeUriByLocale(dataset), []);
});

test("every configured language's published homepage is listed", async () => {
  const dataset = LOCALE_IDS.map((language) => ({
    _id: `home-${language}`,
    _type: "page",
    language,
    uri: { current: withLocalePrefix(language, "/") },
  }));

  assert.deepEqual(
    await homeUriByLocale(dataset),
    LOCALE_IDS.map((language) => [language, withLocalePrefix(language, "/")])
  );
});
