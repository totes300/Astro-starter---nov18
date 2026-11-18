import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LOCALE } from "~/sanity/i18n";
import {
  blogLd,
  blogPostingLd,
  breadcrumbLd,
  itemListLd,
  jsonLdGraph,
  organizationLd,
  personLd,
  profilePageLd,
  webPageLd,
  webSiteLd,
} from "./structured-data";

const SITE_URL = "https://example.com";
const LANGUAGE = "en";

test("organizationLd drops members the CMS has not filled in", () => {
  const node = organizationLd({ name: "Acme", url: SITE_URL });

  assert.deepEqual(Object.keys(node).sort(), ["@id", "@type", "name", "url"]);
});

test("organizationLd keeps logo and sameAs once they are populated", () => {
  const node = organizationLd({
    name: "Acme",
    url: SITE_URL,
    logo: "https://cdn.example/og.png",
    sameAs: ["https://x.com/acme"],
  });

  assert.equal(node.logo, "https://cdn.example/og.png");
  assert.deepEqual(node.sameAs, ["https://x.com/acme"]);
});

test("webSiteLd points its publisher at the organization node id", () => {
  const node = webSiteLd({ name: "Acme", url: SITE_URL });

  assert.equal(node["@id"], `${SITE_URL}/#website`);
  assert.deepEqual(node.publisher, { "@id": `${SITE_URL}/#organization` });
});

test("webPageLd gives each url its own identity and points back at the site and the organization", () => {
  const node = webPageLd({ name: "About", url: `${SITE_URL}/about`, siteUrl: SITE_URL, inLanguage: LANGUAGE });

  assert.equal(node["@id"], `${SITE_URL}/about#webpage`);
  assert.deepEqual(node.isPartOf, { "@id": `${SITE_URL}/#website` });
  assert.deepEqual(node.about, { "@id": `${SITE_URL}/#organization` });
  assert.equal("description" in node, false);
});

test("every page node carries the language it is written in, and the site node the default unless told", () => {
  assert.equal(webPageLd({ url: `${SITE_URL}/it/chi-siamo`, siteUrl: SITE_URL, inLanguage: "it" }).inLanguage, "it");
  assert.equal(webSiteLd({ name: "Acme", url: SITE_URL, inLanguage: "it" }).inLanguage, "it");
  assert.equal(webSiteLd({ name: "Acme", url: SITE_URL }).inLanguage, DEFAULT_LOCALE);
});

test("breadcrumbLd numbers positions from one and omits the item for a crumb with no url", () => {
  const node = breadcrumbLd([{ name: "Home", url: `${SITE_URL}/` }, { name: "About" }]);

  assert.deepEqual(node.itemListElement, [
    { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_URL}/` },
    { "@type": "ListItem", position: 2, name: "About" },
  ]);
});

test("breadcrumbLd drops unnamed crumbs and renumbers, so an unpopulated CMS label leaves no blank rung", () => {
  const node = breadcrumbLd([
    { name: "Home", url: `${SITE_URL}/` },
    { name: "", url: `${SITE_URL}/untitled` },
  ]);

  assert.deepEqual(node.itemListElement, [{ "@type": "ListItem", position: 1, name: "Home", item: `${SITE_URL}/` }]);
});

test("breadcrumbLd drops a rung above the page that has nowhere to link, as a blog index with no usable URI", () => {
  const node = breadcrumbLd([
    { name: "Home", url: `${SITE_URL}/it` },
    { name: "Blog" },
    { name: "Articolo", url: `${SITE_URL}/it/blog/articolo` },
  ]);

  assert.deepEqual(node.itemListElement, [
    { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_URL}/it` },
    { "@type": "ListItem", position: 2, name: "Articolo", item: `${SITE_URL}/it/blog/articolo` },
  ]);
});

test("jsonLdGraph wraps nodes in a single context envelope", () => {
  const graph = jsonLdGraph([{ "@type": "WebSite" }]);

  assert.equal(graph["@context"], "https://schema.org");
  assert.deepEqual(graph["@graph"], [{ "@type": "WebSite" }]);
});

test("blogLd identifies the index as a collection and points back at the site and the organization", () => {
  const node = blogLd({ name: "Field notes", url: `${SITE_URL}/blog`, siteUrl: SITE_URL, inLanguage: "it" });

  assert.equal(node["@type"], "Blog");
  assert.equal(node.inLanguage, "it");
  assert.equal(node["@id"], `${SITE_URL}/blog#blog`);
  assert.deepEqual(node.isPartOf, { "@id": `${SITE_URL}/#website` });
  assert.deepEqual(node.publisher, { "@id": `${SITE_URL}/#organization` });
});

test("profilePageLd shares the webpage id and names the person as its mainEntity", () => {
  const url = `${SITE_URL}/blog/authors/ada`;
  const node = profilePageLd({
    name: "Ada",
    url,
    siteUrl: SITE_URL,
    mainEntityId: `${url}#person`,
    dateCreated: "2026-07-18T00:00:00Z",
    dateModified: "2026-07-20T10:00:00Z",
    inLanguage: "it",
  });

  assert.equal(node["@type"], "ProfilePage");
  assert.equal(node.inLanguage, "it");
  assert.equal(node["@id"], `${url}#webpage`);
  assert.deepEqual(node.mainEntity, { "@id": `${url}#person` });
  assert.equal(node.dateCreated, "2026-07-18T00:00:00Z");
  assert.equal(node.dateModified, "2026-07-20T10:00:00Z");
  assert.deepEqual(node.isPartOf, { "@id": `${SITE_URL}/#website` });
  assert.deepEqual(node.publisher, { "@id": `${SITE_URL}/#organization` });
});

test("personLd carries the id an article's author points at and works for the organization", () => {
  const url = `${SITE_URL}/blog/authors/ada`;
  const node = personLd({ name: "Ada", url, siteUrl: SITE_URL, jobTitle: "Editor", sameAs: ["https://x.com/ada"] });

  assert.equal(node["@id"], `${url}#person`);
  assert.deepEqual(node.worksFor, { "@id": `${SITE_URL}/#organization` });
  assert.deepEqual(node.mainEntityOfPage, { "@id": `${url}#webpage` });
  assert.deepEqual(node.sameAs, ["https://x.com/ada"]);
  assert.equal("image" in node, false);
});

test("blogPostingLd is a separate node from the page and points at it via mainEntityOfPage", () => {
  const url = `${SITE_URL}/blog/a-post`;
  const node = blogPostingLd({ headline: "A post", url, siteUrl: SITE_URL, inLanguage: "it" });

  assert.equal(node["@id"], `${url}#article`);
  assert.equal(node.inLanguage, "it");
  assert.deepEqual(node.mainEntityOfPage, { "@id": `${url}#webpage` });
  assert.deepEqual(node.isPartOf, { "@id": `${url}#webpage` });
});

test("blogPostingLd wraps a byline as a Person, with the author page's id when there is one", () => {
  const node = blogPostingLd({
    headline: "A post",
    url: `${SITE_URL}/blog/a-post`,
    siteUrl: SITE_URL,
    authorName: "Ada",
    authorUrl: `${SITE_URL}/blog/authors/ada`,
    datePublished: "2026-07-18",
    dateModified: "2026-07-20T10:00:00Z",
    inLanguage: LANGUAGE,
  });

  assert.deepEqual(node.author, {
    "@type": "Person",
    "@id": `${SITE_URL}/blog/authors/ada#person`,
    name: "Ada",
    url: `${SITE_URL}/blog/authors/ada`,
  });
  assert.equal(node.datePublished, "2026-07-18");
  assert.equal(node.dateModified, "2026-07-20T10:00:00Z");
});

test("blogPostingLd omits an absent byline, image and empty category list rather than emitting blanks", () => {
  const node = blogPostingLd({
    headline: "A post",
    url: `${SITE_URL}/blog/a-post`,
    siteUrl: SITE_URL,
    articleSection: [],
    inLanguage: LANGUAGE,
  });

  assert.equal("author" in node, false);
  assert.equal("image" in node, false);
  assert.equal("articleSection" in node, false);
  assert.equal("description" in node, false);
});

test("itemListLd numbers entries from one and counts what it was given", () => {
  const node = itemListLd({
    pageId: `${SITE_URL}/blog#webpage`,
    id: `${SITE_URL}/blog#articles`,
    name: "Articles",
    items: [
      { url: `${SITE_URL}/blog/a`, name: "A" },
      { url: `${SITE_URL}/blog/b`, name: "B" },
    ],
  });

  assert.equal(node.numberOfItems, 2);
  assert.deepEqual(node.itemListElement, [
    { "@type": "ListItem", position: 1, url: `${SITE_URL}/blog/a`, name: "A" },
    { "@type": "ListItem", position: 2, url: `${SITE_URL}/blog/b`, name: "B" },
  ]);
});

test("itemListLd ties the list to the page it is rendered on", () => {
  const node = itemListLd({
    pageId: `${SITE_URL}/blog#webpage`,
    id: `${SITE_URL}/blog#articles`,
    items: [{ url: `${SITE_URL}/blog/a` }],
  });

  assert.deepEqual(node.mainEntityOfPage, { "@id": `${SITE_URL}/blog#webpage` });
  assert.deepEqual(node.itemListElement, [{ "@type": "ListItem", position: 1, url: `${SITE_URL}/blog/a` }]);
  assert.equal("name" in node, false);
});
