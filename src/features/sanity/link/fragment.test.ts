import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, parse } from "groq-js";
import { localeParams } from "~/features/i18n/fragment";
import { DEFAULT_LOCALE } from "~/sanity/i18n";
import { LinkFn, type LinkFragmentResult, link } from "./fragment";
import { safeHref } from "./safe-href";

const PAGE = { _id: "page-about", _type: "page", title: "About", uri: { current: "/about" } };

// A language no configuration lists, so the case holds in every locale mode and after any trim.
const GHOST = {
  _id: "ghost-page",
  _type: "page",
  language: "zz",
  title: "GHOST title",
  uri: { current: "/zz/ghost" },
  pageBuilder: { sectionsArray: [{ _key: "s1", sectionSettings: { sectionTitle: "GHOST section" } }] },
};

/** Params bound at parse time too, as the read seams bind them; an unbound `$locales` would hide every target. */
async function linkOf(value: Record<string, unknown>, locales?: string[]): Promise<LinkFragmentResult> {
  const query = `${LinkFn} *[_id == "doc"][0]{ "link": ${link("link")} }.link`;
  const dataset = [PAGE, GHOST, { _id: "doc", _type: "doc", link: value }];
  const params = { ...localeParams(), ...(locales ? { locales } : {}) };
  const result = await (await evaluate(parse(query, { params }), { dataset, params })).get();

  return result as LinkFragmentResult;
}

async function hrefOf(value: Record<string, unknown>): Promise<string> {
  return (await linkOf(value)).href;
}

test("site-relative hrefs and allowed schemes survive the query", async () => {
  assert.equal(await hrefOf({ type: "internal", internal: { link: { _ref: PAGE._id } } }), "/about");
  assert.equal(await hrefOf({ type: "external", external: "/ok" }), "/ok");
  assert.equal(await hrefOf({ type: "external", external: "#a" }), "#a");
  assert.equal(await hrefOf({ type: "params", paramsHref: "?modal=x" }), "?modal=x");
  assert.equal(await hrefOf({ type: "external", external: "https://other.org/a" }), "https://other.org/a");
  assert.equal(await hrefOf({ type: "external", external: "HTTPS://other.org/" }), "HTTPS://other.org/");
  assert.equal(await hrefOf({ type: "email", email: "hi@example.org" }), "mailto:hi@example.org");
  assert.equal(await hrefOf({ type: "phone", phone: "+39 333 1234567" }), "tel:+39 333 1234567");
});

test("a runnable or off-site href stored by an API write leaves the query as an empty string", async () => {
  for (const href of [
    "javascript:alert(1)",
    " JAVASCRIPT:x",
    "JaVaScRiPt:alert(document.cookie)",
    "//evil.example",
    "data:text/html,x",
    "vbscript:msgbox(1)",
    "about",
  ]) {
    assert.equal(await hrefOf({ type: "external", external: href }), "", href);
    assert.equal(await hrefOf({ type: "params", paramsHref: href }), "", href);
  }
});

test("what the coarse query filter passes, safeHref still refuses at render", async () => {
  const href = await hrefOf({ type: "external", external: "/\\evil.example" });

  assert.equal(href, "/\\evil.example");
  assert.equal(safeHref(href), null);
});

test("a link to a document in a language the site does not serve leaks neither its URI nor its title", async () => {
  const internal = { type: "internal", internal: { link: { _ref: GHOST._id } } };

  assert.deepEqual(await linkOf(internal), {
    type: "internal",
    openInNewTab: false,
    canDownload: false,
    href: "",
    text: "",
  });
  assert.equal((await linkOf({ ...internal, customText: "Read more" })).text, "Read more");

  const section = await linkOf({ type: "internal", internal: { link: { _ref: GHOST._id }, sectionTarget: "s1" } });

  assert.equal(section.href, "");
  assert.equal(section.text, "");
});

test("the same link resolves once its language is served, and a live or dangling target is untouched", async () => {
  const internal = { type: "internal", internal: { link: { _ref: GHOST._id } } };
  const served = await linkOf(internal, [DEFAULT_LOCALE, "zz"]);

  assert.equal(served.href, "/zz/ghost");
  assert.equal(served.text, "GHOST title");
  assert.deepEqual(await linkOf({ type: "internal", internal: { link: { _ref: PAGE._id } } }), {
    type: "internal",
    openInNewTab: false,
    canDownload: false,
    href: "/about",
    text: "About",
  });
  assert.equal((await linkOf({ type: "internal", internal: { link: { _ref: "missing" } }, customText: "Kept" })).text, "Kept");
});

test("the guard is written once per link, so a query carrying many links stays under the GET limit", () => {
  assert.equal(LinkFn.split("in $locales").length - 1, 1);
});
