import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { perspectiveCookieName } from "@sanity/preview-url-secret/constants";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS } from "~/sanity/i18n";
import {
  isSpeculativeRequest,
  LOCALE_COOKIE_MAX_AGE,
  LOCALE_COOKIE_NAME,
  landingLocale,
  landingResponse,
  negotiateLocale,
} from "./locale";

// Fixtures derive from `sanity/i18n.ts`, so the suite survives a project changing the locale list.
// Tests needing two languages self-skip on a single-locale build; `zz`/`xx` stand in for unshipped ones.
const secondary = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;

describe("negotiateLocale", () => {
  it("returns null without a header or a supported match", () => {
    assert.equal(negotiateLocale(null), null);
    assert.equal(negotiateLocale("zz,xx;q=0.8"), null);
  });

  it("matches the base subtag of a regional default-locale tag", () => {
    assert.equal(negotiateLocale(`${DEFAULT_LOCALE}-xy`), DEFAULT_LOCALE);
  });

  it("picks the highest q-value supported locale", { skip: !IS_I18N_ENABLED }, () => {
    assert.equal(negotiateLocale(`${secondary}-xy,${secondary};q=0.9,${DEFAULT_LOCALE};q=0.8`), secondary);
    assert.equal(negotiateLocale(`zz;q=1.0,${secondary};q=0.5,${DEFAULT_LOCALE};q=0.4`), secondary);
  });

  it("falls back to the base subtag of a regional tag", { skip: !IS_I18N_ENABLED }, () => {
    assert.equal(negotiateLocale(`${secondary}-ch`), secondary);
  });

  it("ignores entries explicitly rejected with q=0", { skip: !IS_I18N_ENABLED }, () => {
    assert.equal(negotiateLocale(`${secondary};q=0,${DEFAULT_LOCALE};q=0.5`), DEFAULT_LOCALE);
  });
});

function visit(path: string, headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request(`https://example.com${path}`, { method, headers: { accept: "text/html", ...headers } });
}

describe("landingLocale", () => {
  it("never sends a visitor who prefers the default language anywhere", () => {
    assert.equal(landingLocale(visit("/", { "accept-language": DEFAULT_LOCALE })), null);
    assert.equal(landingLocale(visit("/", { "accept-language": "zz" })), null);
    assert.equal(landingLocale(visit("/")), null);
  });

  it("sends a first visit to / towards the preferred configured language", { skip: !IS_I18N_ENABLED }, () => {
    assert.equal(landingLocale(visit("/", { "accept-language": `${secondary}-XY,${DEFAULT_LOCALE};q=0.5` })), secondary);
  });

  it("leaves every other request alone", { skip: !IS_I18N_ENABLED }, () => {
    const prefers = { "accept-language": secondary };

    assert.equal(landingLocale(visit("/about", prefers)), null);
    assert.equal(landingLocale(visit("/", { ...prefers, accept: "application/json" })), null);
    assert.equal(landingLocale(visit("/", prefers, "POST")), null);
    assert.equal(landingLocale(visit("/", { ...prefers, cookie: `${LOCALE_COOKIE_NAME}=${DEFAULT_LOCALE}` })), null);
    assert.equal(landingLocale(visit("/", { ...prefers, cookie: `${perspectiveCookieName}=drafts` })), null);
  });

  it("treats a hover prefetch as a candidate even when it does not ask for HTML", { skip: !IS_I18N_ENABLED }, () => {
    assert.equal(
      landingLocale(visit("/", { accept: "*/*", "accept-language": secondary, "sec-purpose": "prefetch" })),
      secondary
    );
    assert.equal(landingLocale(visit("/", { accept: "*/*", "accept-language": secondary })), null);
  });
});

describe("isSpeculativeRequest", () => {
  it("recognises a prefetch or prerender by the headers browsers send", () => {
    assert.equal(isSpeculativeRequest(visit("/", { "sec-purpose": "prefetch" })), true);
    assert.equal(isSpeculativeRequest(visit("/", { "sec-purpose": "prefetch;prerender" })), true);
    assert.equal(isSpeculativeRequest(visit("/", { purpose: "prefetch" })), true);
    assert.equal(isSpeculativeRequest(visit("/", { "x-moz": "prefetch" })), true);
  });

  it("leaves a navigation alone", () => {
    assert.equal(isSpeculativeRequest(visit("/")), false);
    assert.equal(isSpeculativeRequest(visit("/", { "sec-fetch-mode": "navigate" })), false);
  });
});

function cookieJar() {
  const set: { name: string; value: unknown; options: unknown }[] = [];

  return {
    set,
    cookies: {
      set(name: string, value: unknown, options?: unknown) {
        set.push({ name, value, options });
      },
    },
  };
}

describe("landingResponse", () => {
  it("sets the cookie and redirects a real visit to the published homepage", () => {
    const jar = cookieJar();
    const response = landingResponse(visit("/"), secondary, `/${secondary}`, jar.cookies);

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `/${secondary}`);
    assert.equal(response.headers.get("vary"), "Accept-Language, Cookie");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(jar.set, [
      { name: LOCALE_COOKIE_NAME, value: secondary, options: { path: "/", maxAge: LOCALE_COOKIE_MAX_AGE, sameSite: "lax" } },
    ]);
  });

  it("keeps the query string, so campaign parameters reach the language's homepage", () => {
    const location = (path: string) =>
      landingResponse(visit(path), secondary, `/${secondary}`, cookieJar().cookies).headers.get("location");

    assert.equal(location("/?utm_source=x&ref=a%20b"), `/${secondary}?utm_source=x&ref=a%20b`);
    assert.equal(location("/?"), `/${secondary}`);
  });

  it("decides nothing on a hover prefetch, and hands the browser nothing to reuse for the click", () => {
    const jar = cookieJar();
    const response = landingResponse(visit("/", { "sec-purpose": "prefetch" }), secondary, `/${secondary}`, jar.cookies);

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(jar.set, []);
  });
});
