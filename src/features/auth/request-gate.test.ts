// The route patterns are the ones Astro matches (`context.routePattern`), before and after locale routing rewrites
// a prefixed request; a file spelling of a page still routes to the page, so exemption is decided by route.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS } from "~/sanity/i18n";
import {
  classifyRequest,
  classifyRequestSpelling,
  type GateDecision,
  NOT_FOUND_ROUTE,
  panelHostPath,
  publicRequestPath,
  requestPathname,
} from "./request-gate";

const STUDIO = "/studio";
const SECONDARY = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;

function decodeLikeAstro(pathname: string): string {
  let current = pathname;

  for (let iteration = 0; iteration < 10; iteration++) {
    try {
      const decoded = decodeURI(current);

      if (decoded === current) {
        break;
      }

      current = decoded;
    } catch {
      break;
    }
  }

  return current;
}

/** `locals.path` through the very function `localeRouting` uses, on `context.url` as Astro decodes it and sets it back. */
function publicPath(pathname: string): string {
  const url = new URL(`https://x.test${pathname}`);

  url.pathname = decodeLikeAstro(url.pathname).replace(/\/{2,}/g, "/");
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");

  return publicRequestPath(url);
}

type Visit = {
  /** The route the request as sent matched. */
  route: string;
  /** The route locale routing rewrote it to, when it did. */
  rendered?: string;
  pathname: string;
};

/** The middleware's two checks in order: the spelling as sent, then the rendered route gated as the public path. */
function gate({ route, rendered = route, pathname }: Visit): GateDecision {
  const raw = requestPathname(new Request(`https://x.test${pathname}`));
  const refusal = classifyRequestSpelling({ routePattern: route, pathname: raw, studioBasePath: STUDIO });

  if (refusal) {
    return { kind: refusal };
  }

  return classifyRequest({ routePattern: rendered, path: publicPath(raw), studioBasePath: STUDIO });
}

function page(route: string, pathname: string) {
  return gate({ route, pathname });
}

test("a file spelling of a page is a 404, encoded or not, in any letter case or language, and never exempt", () => {
  for (const [route, pathname] of [
    ["/[...uri]", "/x.html"],
    ["/[...uri]", "/secret.html"],
    ["/[...uri]", "/secret.HTML"],
    ["/blog/[slug]", "/blog/x.html"],
    ["/[...uri]", "/index.html"],
    ["/[...uri]", "/index"],
    ["/[...uri]", "/%78.html"],
    ["/[...uri]", "/x%2Ehtml"],
    ["/blog/[slug]", "/blog/%78.html"],
    ["/[...uri]", "/x.htm"],
    ["/[...uri]", `/${SECONDARY}/secret.html`],
    ["/[...uri]", `/${SECONDARY}/blog/post.html`],
    ["/[...uri]", `/${SECONDARY}/index.html`],
  ] as const) {
    assert.deepEqual(page(route, pathname), { kind: "not-found" }, pathname);
  }
});

test("the 404 page render of such a spelling is gated as the page it names, locale prefix included", () => {
  assert.deepEqual(page(NOT_FOUND_ROUTE, "/x.html"), { kind: "page", path: "/x" });
  assert.deepEqual(page(NOT_FOUND_ROUTE, "/index.html"), { kind: "page", path: "/" });
  assert.deepEqual(page(NOT_FOUND_ROUTE, `/${SECONDARY}/secret.html`), { kind: "page", path: `/${SECONDARY}/secret` });
  assert.deepEqual(page(NOT_FOUND_ROUTE, `/${SECONDARY}/blog/post.html`), { kind: "page", path: `/${SECONDARY}/blog/post` });
  assert.deepEqual(page(NOT_FOUND_ROUTE, "/api/no-handler"), { kind: "page", path: "/api/no-handler" });
  assert.deepEqual(page(NOT_FOUND_ROUTE, "/unknown.txt"), { kind: "page", path: "/unknown.txt" });
});

test("an unknown dotted path is gated like any page, not skipped for its extension", () => {
  assert.deepEqual(page("/[...uri]", "/secret.txt"), { kind: "page", path: "/secret.txt" });
  assert.deepEqual(page("/[...uri]", "/sitemap.xml/"), { kind: "page", path: "/sitemap.xml" });
});

test("named endpoint routes, the API and the Studio are exempt", () => {
  for (const [route, pathname] of [
    ["/robots.txt", "/robots.txt"],
    ["/sitemap.xml", "/sitemap.xml"],
    ["/favicon.ico", "/favicon.ico"],
    ["/llms.txt", "/llms.txt"],
    ["/openapi.json", "/openapi.json"],
    ["/api/contact-form", "/api/contact-form"],
    ["/api/revalidate", "/api/revalidate"],
    ["/api/agent-markdown/[...uri]", "/api/agent-markdown/a%2Fb"],
    ["/studio/[...params]", "/studio/structure"],
  ] as const) {
    assert.deepEqual(page(route, pathname), { kind: "exempt" }, route);
  }
});

test("the feed is a file route kept behind the gate, on its one path", () => {
  assert.deepEqual(page("/feed.xml", "/feed.xml"), { kind: "page", path: "/feed.xml" });
});

test("Astro's image endpoint answers 404 under any query, so it cannot re-serve a page under a chosen type", () => {
  for (const url of ["https://x.test/_image", "https://x.test/_image?href=/secret&f=html", "https://x.test/_image/"]) {
    assert.deepEqual(page("/_image", requestPathname(new Request(url))), { kind: "not-found" }, url);
  }

  assert.deepEqual(gate({ route: "/[...uri]", rendered: "/_image", pathname: `/${SECONDARY}/_image` }), { kind: "not-found" });
});

test("a Studio-looking request path on a page route is not exempt", () => {
  assert.deepEqual(page("/[...uri]", "/studio"), { kind: "page", path: "/studio" });
});

test("every spelling of a page gates as its stored URI: encoded, doubled slash, trailing slash", () => {
  for (const pathname of ["/secret", "/%73ecret", "/%2573ecret", "//secret", "/secret/", "/secret//"]) {
    assert.deepEqual(page("/[...uri]", pathname), { kind: "page", path: "/secret" }, pathname);
  }

  for (const pathname of ["/über-uns", "/%C3%BCber-uns", "/u%CC%88ber-uns", "//%C3%BCber-uns/"]) {
    assert.deepEqual(page("/[...uri]", pathname), { kind: "page", path: "/über-uns" }, pathname);
  }
});

test("letter case is kept, so the gate checks the very path the route queries Sanity by", () => {
  const upper = `/${SECONDARY.toUpperCase()}/secret`;

  assert.deepEqual(page("/[...uri]", "/Secret"), { kind: "page", path: "/Secret" });
  assert.deepEqual(page("/[...uri]", upper), { kind: "page", path: upper });
});

test("a path the router and the gate could read differently is a 400, in any language", () => {
  for (const pathname of [
    "/a%2Fb",
    "/%2F/x",
    "/a%252Fb",
    "/a%25",
    "/%E0%A4%A",
    "/a%5Cb",
    "/team%5Cprivate",
    "/x/%252e%252e/secret",
    `/${SECONDARY}/a%2Fb`,
    `/${SECONDARY}/blog%5Cpost`,
    "/se%09cret",
    "/se%0Acret",
    `/${SECONDARY}/blog/po%0Dst`,
  ]) {
    assert.deepEqual(page("/[...uri]", pathname), { kind: "bad-request" }, pathname);
  }
});

test("the spelling is judged as sent, not as Astro's URL holds it, so %5C cannot gate as another page", () => {
  const request = new Request("https://x.test/team%5Cprivate");

  // What `context.url.pathname`, and so `locals.path`, holds: the pathname setter turned the decoded `\` into `/`.
  assert.equal(publicPath(requestPathname(request)), "/team/private");
  assert.equal(decodeURI(requestPathname(request)), "/team\\private", "the router renders the page stored as team\\private");
  assert.equal(
    classifyRequestSpelling({ routePattern: "/[...uri]", pathname: requestPathname(request), studioBasePath: STUDIO }),
    "bad-request"
  );
  assert.deepEqual(
    classifyRequest({ routePattern: "/[...uri]", path: publicPath(requestPathname(request)), studioBasePath: STUDIO }),
    { kind: "page", path: "/team/private" },
    "what the page check alone would have let through"
  );
});

test("the page check refuses a public path that still carries an escape, whoever handed it over", () => {
  for (const path of ["/a%2Fb", "/a%25", "/team\\private", "/x/../secret"]) {
    assert.deepEqual(classifyRequest({ routePattern: "/[...uri]", path, studioBasePath: STUDIO }), { kind: "bad-request" }, path);
  }
});

test("the section preview is caught under every spelling and route, before any page or draft rule", () => {
  for (const [route, pathname] of [
    ["/[...uri]", "/section-preview"],
    ["/section-preview/[section]", "/section-preview/hero"],
    ["/section-preview/[section]", "/section-preview/%68ero"],
    ["/section-preview/[section]", "//section-preview/hero"],
    ["/section-preview/[section]", "/section-preview/hero/"],
    [NOT_FOUND_ROUTE, "/section-preview/hero.html"],
    [NOT_FOUND_ROUTE, "/section-preview/nope"],
  ] as const) {
    assert.deepEqual(page(route, pathname), { kind: "section-preview" }, pathname);
  }

  // A file spelling is a 404 on its own route first; the 404 render above is what gates it.
  assert.deepEqual(page("/section-preview/[section]", "/section-preview/hero.html"), { kind: "not-found" });
  assert.deepEqual(page("/[...uri]", "/Section-Preview"), { kind: "page", path: "/Section-Preview" });
  assert.deepEqual(classifyRequest({ routePattern: "/section-preview/[section]", path: "/about", studioBasePath: STUDIO }), {
    kind: "section-preview",
  });
});

test("a prefixed page gates as its public URI, never as the folder the rewrite renders", { skip: !IS_I18N_ENABLED }, () => {
  const prefix = `/${SECONDARY}`;

  for (const pathname of [`${prefix}/blog/post`, `${prefix}/blog/%70ost`, `${prefix}/blog/post/`, `/${prefix}/blog/post`]) {
    assert.deepEqual(
      gate({ route: "/[...uri]", rendered: "/blog/[slug]", pathname }),
      { kind: "page", path: `${prefix}/blog/post` },
      pathname
    );
  }

  assert.deepEqual(gate({ route: "/[...uri]", rendered: "/blog/authors/[slug]", pathname: `${prefix}/blog/authors/ada` }), {
    kind: "page",
    path: `${prefix}/blog/authors/ada`,
  });
  assert.deepEqual(gate({ route: "/[...uri]", rendered: "/[...uri]", pathname: prefix }), { kind: "page", path: prefix });
});

test("a repeated or default prefix under another language gates as the whole path it queries", { skip: !IS_I18N_ENABLED }, () => {
  for (const pathname of [
    `/${SECONDARY}/${SECONDARY}/x`,
    `/${SECONDARY}/${DEFAULT_LOCALE}/x`,
    `/${SECONDARY}/${SECONDARY}`,
    `/${SECONDARY}/${SECONDARY}/feed.xml`,
    `/${SECONDARY}/${SECONDARY}/api/contact-form`,
  ]) {
    assert.deepEqual(gate({ route: "/[...uri]", rendered: "/[...uri]", pathname }), { kind: "page", path: pathname }, pathname);
  }
});

test("locals.path is the stored form: decoded, prefix and letter case kept, trailing slash dropped", () => {
  const at = (pathname: string) => publicRequestPath(new URL(`https://x.test${pathname}`));

  assert.equal(at("/"), "/");
  assert.equal(at("/About/"), "/About");
  assert.equal(at(`/${SECONDARY}/caff%C3%A8/`), `/${SECONDARY}/caffè`);
  // A reserved escape stays encoded, and the page check refuses what still carries one.
  assert.equal(at("/a%2Fb"), "/a%2Fb");
  assert.deepEqual(classifyRequest({ routePattern: "/[...uri]", path: at("/a%2Fb"), studioBasePath: STUDIO }), {
    kind: "bad-request",
  });
});

test("a prefix opens no endpoint, file route or Studio: one path each, so a rule on it holds", { skip: !IS_I18N_ENABLED }, () => {
  for (const [rendered, pathname] of [
    ["/api/contact-form", "/api/contact-form"],
    ["/api/draft-mode/enable", "/api/draft-mode/enable"],
    ["/api/revalidate", "/api/revalidate"],
    ["/robots.txt", "/robots.txt"],
    ["/sitemap.xml", "/sitemap.xml"],
    ["/llms.txt", "/llms.txt"],
    ["/studio/[...params]", "/studio"],
  ] as const) {
    assert.deepEqual(
      gate({ route: "/[...uri]", rendered, pathname: `/${SECONDARY}${pathname}` }),
      { kind: "not-found" },
      pathname
    );
  }
});

test("the feed answers in the default language only: a prefix 404s it", { skip: !IS_I18N_ENABLED }, () => {
  assert.deepEqual(gate({ route: "/[...uri]", rendered: "/feed.xml", pathname: `/${SECONDARY}/feed.xml` }), {
    kind: "not-found",
  });
  assert.deepEqual(page(NOT_FOUND_ROUTE, `/${SECONDARY}/feed.xml`), { kind: "page", path: `/${SECONDARY}/feed.xml` });
});

test("the section preview stays gated under a language prefix", { skip: !IS_I18N_ENABLED }, () => {
  const pathname = `/${SECONDARY}/section-preview/hero`;

  assert.deepEqual(gate({ route: "/[...uri]", rendered: "/section-preview/[section]", pathname }), { kind: "section-preview" });
  assert.deepEqual(gate({ route: "/[...uri]", rendered: "/[...uri]", pathname }), { kind: "section-preview" });
  assert.deepEqual(page(NOT_FOUND_ROUTE, `/${SECONDARY}/section-preview/hero.html`), { kind: "section-preview" });
});

test("a panel partial gates as the page it renders, so a locked profile is locked in its panel too", () => {
  const route = "/blog/authors/[slug]/modal";

  assert.deepEqual(page(route, "/blog/authors/ada/modal"), { kind: "page", path: "/blog/authors/ada", panel: true });
  assert.deepEqual(page(route, "/blog/authors/%61da/modal/"), { kind: "page", path: "/blog/authors/ada", panel: true });
  assert.deepEqual(page(NOT_FOUND_ROUTE, "/blog/authors/ada/modal"), { kind: "page", path: "/blog/authors/ada/modal" });
  assert.deepEqual(page("/[...uri]", "/team/modal"), { kind: "page", path: "/team/modal" }, "a page is its own path");
});

test("a prefixed panel partial gates as its prefixed page", { skip: !IS_I18N_ENABLED }, () => {
  assert.deepEqual(
    gate({ route: "/[...uri]", rendered: "/blog/authors/[slug]/modal", pathname: `/${SECONDARY}/blog/authors/ada/modal` }),
    { kind: "page", path: `/${SECONDARY}/blog/authors/ada`, panel: true }
  );
});

// The decision names the host for its lock; Markdown for it at the panel URL would copy the page to a non-page URL.
test("the middleware never negotiates Markdown for a panel, only for the page it is a view of", () => {
  const middleware = readFileSync(join(import.meta.dirname, "..", "..", "middleware.ts"), "utf8");

  assert.match(middleware, /decision\.panel \? null : await rewriteToAgentMarkdown\(context, decision\.path\)/);
});

test("panelHostPath strips the panel segment only, never a page that merely ends alike", () => {
  assert.equal(panelHostPath("/blog/authors/ada/modal"), "/blog/authors/ada");
  assert.equal(panelHostPath("/modal"), "/");
  assert.equal(panelHostPath("/blog/authors/ada"), "/blog/authors/ada");
  assert.equal(panelHostPath("/team/supermodal"), "/team/supermodal");
});
