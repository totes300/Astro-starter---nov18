import "../test-env";
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { evaluate, parse } from "groq-js";
import { SINGLETON_IDS } from "../../constants";
import { DEFAULT_LOCALE, getLocaleTitle, IS_I18N_ENABLED, LOCALE_IDS, withLocalePrefix } from "../../i18n";

let homepageTranslationIssue: typeof import("./page").homepageTranslationIssue;

before(async () => {
  ({ homepageTranslationIssue } = await import("./page"));
});

// `string`, so the fixtures stay valid when only the default locale is configured.
const secondary: string = LOCALE_IDS.find((locale) => locale !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;
const multiLocale = { skip: !IS_I18N_ENABLED };

const homepageGroup = {
  _id: "metadata",
  _type: "translation.metadata",
  translations: [
    { _key: DEFAULT_LOCALE, value: { _type: "reference", _ref: SINGLETON_IDS.homepage } },
    { _key: secondary, value: { _type: "reference", _ref: "home-translated" } },
  ],
};

type Read = Record<string, unknown>;

/** Runs the check with the Studio client answering from `dataset`, recording every read. */
function issue(document: Record<string, unknown>, uri: string, reads: Read[] = [], dataset: object[] = [homepageGroup]) {
  const client = {
    fetch: async (query: string, params: Read) => {
      reads.push(params);

      return (await evaluate(parse(query, { params }), { dataset, params })).get();
    },
  };

  return homepageTranslationIssue({ _type: "slug", current: uri }, {
    document: { _type: "page", ...document, uri: { current: uri } },
    getClient: () => client,
  } as never);
}

describe("homepageTranslationIssue", () => {
  it("refuses the homepage's translation once it leaves its language's home path", multiLocale, async () => {
    const fixedAt = `This is the ${getLocaleTitle(secondary)} homepage, so its URI is fixed at "${withLocalePrefix(secondary, "/")}".`;

    for (const _id of ["home-translated", "drafts.home-translated", "versions.spring.home-translated"]) {
      assert.equal(await issue({ _id, language: secondary }, withLocalePrefix(secondary, "/home")), fixedAt, _id);
    }
  });

  it("passes another page in that language, and the translation at its home path", multiLocale, async () => {
    const reads: Read[] = [];

    assert.equal(await issue({ _id: "drafts.about", language: secondary }, withLocalePrefix(secondary, "/about"), reads), true);
    assert.equal(await issue({ _id: "home-translated", language: secondary }, withLocalePrefix(secondary, "/"), reads), true);
    assert.deepEqual(reads, [{ homepage: SINGLETON_IDS.homepage, id: "about" }], "the home path needs no read");
  });

  it("never reads for the default language, a language the site does not serve, or an empty URI", async () => {
    const reads: Read[] = [];

    assert.equal(await issue({ _id: "about", language: DEFAULT_LOCALE }, "/about", reads), true);
    assert.equal(await issue({ _id: "legacy" }, "/legacy", reads), true);
    assert.equal(await issue({ _id: "ghost", language: "zz" }, "/zz/home", reads), true);
    assert.equal(await issue({ _id: "home-translated", language: secondary }, "", reads), true);
    assert.deepEqual(reads, []);
  });

  it("never blocks publishing when the read fails", multiLocale, async (t) => {
    const logged = t.mock.method(console, "error", () => {});
    const failing = {
      document: { _id: "home-translated", _type: "page", language: secondary },
      getClient: () => ({
        fetch: async () => {
          throw new Error("offline");
        },
      }),
    };

    assert.equal(
      await homepageTranslationIssue({ _type: "slug", current: withLocalePrefix(secondary, "/x") }, failing as never),
      true
    );
    assert.equal(logged.mock.callCount(), 1);
  });
});
