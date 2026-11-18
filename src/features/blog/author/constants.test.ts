import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SANITY_AUTHOR_PATH_PREFIX, SANITY_PERSON_DOCUMENT_TYPE } from "~/sanity/constants";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS, withLocalePrefix } from "~/sanity/i18n";
import { localizeDocumentPath } from "~/sanity/sections";
import { authorPartialPath, authorPathPrefix, isAuthorPath } from "./constants";

// Fixtures derive from `sanity/i18n.ts` and `sanity/sections.ts`, so they hold whatever the section words are.
const secondary = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;
const author = `${SANITY_AUTHOR_PATH_PREFIX}/jane-doe`;

describe("isAuthorPath", () => {
  it("recognises one author's own URL", () => {
    assert.equal(isAuthorPath(author), true);
  });

  it("refuses the prefix, the partial below an author and an unrelated path", () => {
    assert.equal(isAuthorPath(SANITY_AUTHOR_PATH_PREFIX), false);
    assert.equal(isAuthorPath(`${SANITY_AUTHOR_PATH_PREFIX}/`), false);
    assert.equal(isAuthorPath(authorPartialPath(author)), false);
    assert.equal(isAuthorPath("/about"), false);
  });

  it("refuses the default locale's redundant prefix, which only redirects", () => {
    assert.equal(isAuthorPath(`/${DEFAULT_LOCALE}${author}`), false);
  });

  it("recognises an author's URL under another locale's prefix", { skip: !IS_I18N_ENABLED }, () => {
    const localized = localizeDocumentPath(SANITY_PERSON_DOCUMENT_TYPE, secondary, author);

    assert.equal(isAuthorPath(localized), true);
    assert.equal(isAuthorPath(authorPartialPath(localized)), false);
  });

  it("refuses the default section word under a prefix when the locale names its own", { skip: !IS_I18N_ENABLED }, () => {
    const defaultWord = withLocalePrefix(secondary, author);
    const localized = localizeDocumentPath(SANITY_PERSON_DOCUMENT_TYPE, secondary, author);

    assert.equal(isAuthorPath(defaultWord), defaultWord === localized);
  });
});

describe("authorPathPrefix", () => {
  it("is the stored prefix in the default locale", () => {
    assert.equal(authorPathPrefix(DEFAULT_LOCALE), SANITY_AUTHOR_PATH_PREFIX);
  });

  it("holds every author URL of its locale", { skip: !IS_I18N_ENABLED }, () => {
    const localized = localizeDocumentPath(SANITY_PERSON_DOCUMENT_TYPE, secondary, author);

    assert.ok(localized.startsWith(`${authorPathPrefix(secondary)}/`));
  });
});
