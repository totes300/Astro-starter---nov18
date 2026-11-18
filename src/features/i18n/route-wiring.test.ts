// The switcher links to the translations a route hands `SiteShell`; a route that builds hreflang but drops them
// offers only homepages, which nothing else would notice.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CATCH_ALL = join("src", "pages", "[...uri].astro");
const PAGE_ROUTE_TEMPLATE = join("templates", "page-route", "page.astro.hbs");

const ROUTE_SOURCES = [
  ...readdirSync(join(ROOT, "src", "pages"), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".astro"))
    .map((file) => join("src", "pages", file)),
  PAGE_ROUTE_TEMPLATE,
];

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

test("every route that builds hreflang also hands its translations to the switcher", () => {
  const builders = ROUTE_SOURCES.filter((file) => read(file).includes("buildAlternateLinks("));

  // The catch-all serves every project and the template scaffolds every new route, so neither may go quiet.
  assert.ok(builders.includes(CATCH_ALL), `${CATCH_ALL} builds no hreflang`);
  assert.ok(builders.includes(PAGE_ROUTE_TEMPLATE), `${PAGE_ROUTE_TEMPLATE} builds no hreflang`);

  const offences = builders.filter((file) => !/<SiteShell[^>]*\stranslations=\{page\.alternates\}/.test(read(file)));

  assert.deepEqual(offences, [], `pass translations={page.alternates} to <SiteShell> in: ${offences.join(", ")}`);
});

test("the shell hands the translations on to the header and the footer that host the switchers", () => {
  const shell = read(join("src", "features", "site", "SiteShell.astro"));

  assert.match(shell, /<SiteHeader[^>]*\stranslations=\{translations\}/);
  assert.match(shell, /<SiteFooter[^>]*\stranslations=\{translations\}/);
});

test("the footer stays up for the switcher only when the switcher has two usable rows", () => {
  const footer = read(join("src", "features", "site", "site-footer", "SiteFooter.astro"));

  assert.match(footer, /const menu = languageMenu\(/);
  assert.match(footer, /\(columns\.length > 0 \|\| menu\) &&/);
  assert.match(footer, /<LanguageSwitcher[^>]*\smenu=\{menu\}/);
});
