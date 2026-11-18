import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageLink } from "~/features/i18n/language-links";
import { languageMenu } from "./language-menu";

const english: LanguageLink = { locale: "en", title: "English", href: "/about", isCurrent: true };
const french: LanguageLink = { locale: "fr", title: "Français", href: "/fr/a-propos", isCurrent: false };

test("lists every language and names the page's own as current", () => {
  assert.deepEqual(languageMenu([english, french]), { links: [english, french], current: english });
  assert.deepEqual(languageMenu([french, english])?.current, english);
});

test("a stored URI outside the href allowlist drops its row", () => {
  const german: LanguageLink = { locale: "de", title: "Deutsch", href: "/de/uber-uns", isCurrent: false };

  for (const href of ["javascript:alert(1)", "//elsewhere.example/fr", "", " "]) {
    const menu = languageMenu([english, { ...french, href }, german]);

    assert.deepEqual(
      menu?.links.map((link) => link.locale),
      ["en", "de"],
      href
    );
  }
});

test("keeps the trimmed href it vetted", () => {
  assert.equal(languageMenu([english, { ...french, href: " /fr/a-propos " }])?.links[1]?.href, "/fr/a-propos");
});

test("renders nothing with fewer than two usable languages", () => {
  assert.equal(languageMenu([]), null);
  assert.equal(languageMenu([english]), null);
  assert.equal(languageMenu([english, { ...french, href: "javascript:void 0" }]), null);
});

test("falls back to the first row when the page's language is not listed", () => {
  const menu = languageMenu([
    { ...english, isCurrent: false },
    { ...french, isCurrent: false },
  ]);

  assert.equal(menu?.current.locale, "en");
});
