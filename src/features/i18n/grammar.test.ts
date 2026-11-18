import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { counted, joinList } from "./grammar";

describe("counted", () => {
  it("puts the count before the noun its plural rules pick", () => {
    const articles = counted("en", "article", "articles");

    assert.equal(articles(0), "0 articles");
    assert.equal(articles(1), "1 article");
    assert.equal(articles(2), "2 articles");
  });

  it("follows each language's own rules rather than a count of one", () => {
    assert.equal(counted("fr", "article", "articles")(0), "0 article");
    assert.equal(counted("it", "articolo", "articoli")(0), "0 articoli");
    assert.equal(counted("it", "articolo", "articoli")(1), "1 articolo");
  });

  it("reads every category but one as the plural, Italian's many included", () => {
    assert.equal(new Intl.PluralRules("it").select(1_000_000), "many");
    assert.equal(counted("it", "articolo", "articoli")(1_000_000), "1000000 articoli");
  });
});

describe("joinList", () => {
  it("keeps the serial comma the English copy uses", () => {
    assert.equal(joinList("en", ["Design", "Strategy", "Content"]), "Design, Strategy, and Content");
    assert.equal(joinList("en", ["Design", "Strategy"]), "Design and Strategy");
  });

  it("joins with the language's own conjunction", () => {
    assert.equal(joinList("it", ["Design", "Sviluppo", "Contenuti"]), "Design, Sviluppo e Contenuti");
  });

  it("passes a single item through and gives nothing for none", () => {
    assert.equal(joinList("en", ["Design"]), "Design");
    assert.equal(joinList("en", []), "");
  });
});
