import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS } from "~/sanity/i18n";
import { joinSiteUrl } from "./site-url";
import { renderSitemap, type SitemapDocument, sitemapEntries } from "./sitemap";

const LASTMOD = "2026-10-01T10:00:00Z";
const URLSET = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">';
const SITE = "https://example.com";

// Typed as a plain string: with one locale, `LOCALE_IDS` narrows to the default's literal.
const SECONDARY: string = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;

const toUrl = (path: string) => joinSiteUrl(SITE, path);

function row(uri: string, language: string | null, translationGroup: string | null = null): SitemapDocument {
  return { uri, language, translationGroup, updatedAt: LASTMOD };
}

test("a URI with & or < is escaped, so one entry cannot invalidate the whole sitemap", () => {
  const xml = renderSitemap([
    { loc: "https://example.com/q&a", lastmod: LASTMOD },
    { loc: "https://example.com/a<b>", lastmod: LASTMOD },
    { loc: "https://example.com/it's", lastmod: LASTMOD },
  ]);

  assert.match(xml, /<loc>https:\/\/example\.com\/q&amp;a<\/loc>/);
  assert.match(xml, /<loc>https:\/\/example\.com\/a%3Cb%3E<\/loc>/);
  assert.match(xml, /<loc>https:\/\/example\.com\/it&apos;s<\/loc>/);
  assert.doesNotMatch(xml, /&(?!amp;|lt;|gt;|quot;|apos;)/, "no bare ampersand");
});

test("an alternate's href and hreflang are escaped, so neither can leave its attribute", () => {
  const xml = renderSitemap([
    {
      loc: "https://example.com/a",
      lastmod: LASTMOD,
      alternates: [
        { hreflang: 'it" onload="x', href: "https://example.com/it/q&a" },
        { hreflang: "en", href: 'https://example.com/a"><x' },
      ],
    },
  ]);

  assert.match(xml, /hreflang="it&quot; onload=&quot;x" href="https:\/\/example\.com\/it\/q&amp;a"/);
  assert.match(xml, /hreflang="en" href="https:\/\/example\.com\/a%22%3E%3Cx"/);
  assert.doesNotMatch(xml, /onload="/);
});

test("each entry carries its URL, its alternates and lastmod, percent-encoded, and nothing else", () => {
  assert.equal(
    renderSitemap([
      {
        loc: "https://example.com/it/caffè",
        lastmod: LASTMOD,
        alternates: [
          { hreflang: "en", href: "https://example.com/coffee" },
          { hreflang: "it", href: "https://example.com/it/caffè" },
          { hreflang: "x-default", href: "https://example.com/coffee" },
        ],
      },
    ]),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      URLSET,
      "  <url>",
      "    <loc>https://example.com/it/caff%C3%A8</loc>",
      '    <xhtml:link rel="alternate" hreflang="en" href="https://example.com/coffee" />',
      '    <xhtml:link rel="alternate" hreflang="it" href="https://example.com/it/caff%C3%A8" />',
      '    <xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/coffee" />',
      `    <lastmod>${LASTMOD}</lastmod>`,
      "  </url>",
      "</urlset>",
      "",
    ].join("\n")
  );
});

test("a URL that cannot be percent-encoded is left out rather than failing the whole sitemap", () => {
  const xml = renderSitemap([
    { loc: "https://example.com/\uD800", lastmod: LASTMOD },
    {
      loc: "https://example.com/ok",
      lastmod: LASTMOD,
      alternates: [{ hreflang: "it", href: "https://example.com/it/\uD800" }],
    },
  ]);

  assert.doesNotMatch(xml, /\uD800/);
  assert.match(xml, /<loc>https:\/\/example\.com\/ok<\/loc>/);
  assert.doesNotMatch(xml, /xhtml:link/);
});

test("no entries is still a valid, empty urlset", () => {
  assert.equal(renderSitemap([]), `<?xml version="1.0" encoding="UTF-8"?>\n${URLSET}\n\n</urlset>\n`);
});

test("an untranslated page, or any page on a single-language site, carries no annotations", () => {
  const entries = sitemapEntries([row("/about", DEFAULT_LOCALE), row("/team", null, "group-alone")], toUrl);

  assert.deepEqual(entries, [
    { loc: `${SITE}/about`, lastmod: LASTMOD },
    { loc: `${SITE}/team`, lastmod: LASTMOD },
  ]);
});

test("translations annotate each other both ways, with x-default on the default language's", { skip: !IS_I18N_ENABLED }, () => {
  const translated = `/${SECONDARY}/chi-siamo`;
  const entries = sitemapEntries([row(translated, SECONDARY, "group"), row("/about", DEFAULT_LOCALE, "group")], toUrl);
  const cluster = [
    { hreflang: SECONDARY, href: `${SITE}${translated}` },
    { hreflang: DEFAULT_LOCALE, href: `${SITE}/about` },
    { hreflang: "x-default", href: `${SITE}/about` },
  ];

  assert.deepEqual(entries, [
    { loc: `${SITE}${translated}`, lastmod: LASTMOD, alternates: cluster },
    { loc: `${SITE}/about`, lastmod: LASTMOD, alternates: cluster },
  ]);
});

test("a cluster without its default-language member gets no x-default", { skip: !IS_I18N_ENABLED }, () => {
  const entries = sitemapEntries([row(`/${SECONDARY}/a`, SECONDARY, "group"), row(`/${SECONDARY}/b`, SECONDARY, "group")], toUrl);

  assert.equal(
    entries.some((entry) => entry.alternates?.some(({ hreflang }) => hreflang === "x-default")),
    false
  );
});

test("a row in a language the site does not serve is never named as an alternate, nor annotated", {
  skip: !IS_I18N_ENABLED,
}, () => {
  const entries = sitemapEntries(
    [row("/about", DEFAULT_LOCALE, "group"), row(`/${SECONDARY}/chi-siamo`, SECONDARY, "group"), row("/zz/about", "zz", "group")],
    toUrl
  );

  assert.equal(JSON.stringify(entries.slice(0, 2)).includes("/zz/"), false);
  assert.deepEqual(entries[2], { loc: `${SITE}/zz/about`, lastmod: LASTMOD });
});
