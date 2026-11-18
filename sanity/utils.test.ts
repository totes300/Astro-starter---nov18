import assert from "node:assert/strict";
import { test } from "node:test";
import type { Rule } from "sanity";
import { I18N_DOCUMENT_TYPES, SANITY_PAGE_DOCUMENT_TYPE, SINGLETON_IDS, TRANSLATION_EXCLUDED_FIELDS } from "./constants";
import { DEFAULT_LOCALE, homeUris, LOCALE_IDS, withLocalePrefix } from "./i18n";
import {
  composeValidation,
  isEmptyObjectValue,
  isHomepageDocument,
  offersDeleteTranslation,
  requireTypeWhenObjectHasValue,
  withTranslationExclusions,
} from "./utils";

/** Captures the callback passed to `Rule.custom` so tests can invoke it directly. */
type ValidationContext = { parent?: unknown };

function captureCustom(builder: (rule: unknown) => unknown): (value: unknown, context?: ValidationContext) => true | string {
  let captured: ((value: unknown, context: ValidationContext) => true | string) | undefined;
  builder({
    custom(fn: (value: unknown, context: ValidationContext) => true | string) {
      captured = fn;
      return this;
    },
  });

  assert.ok(captured, "validation builder never called Rule.custom");
  const fn = captured;
  return (value, context = {}) => fn(value, context);
}

test("isEmptyObjectValue: true only for objects whose values are all nullish", () => {
  assert.equal(isEmptyObjectValue({}), true);
  assert.equal(isEmptyObjectValue({ type: null, image: undefined }), true);
  assert.equal(isEmptyObjectValue({ type: "image" }), false);
  assert.equal(isEmptyObjectValue(null), false);
  assert.equal(isEmptyObjectValue([1]), false);
  assert.equal(isEmptyObjectValue("x"), false);
});

test("requireTypeWhenObjectHasValue: the contract used by createMediaField/createLinkField", () => {
  const validate = captureCustom(requireTypeWhenObjectHasValue("Select a media type."));

  // No value or stale all-null object: valid (editors cleared the field).
  assert.equal(validate(undefined), true);
  assert.equal(validate({ type: null, image: null }), true);

  // Meaningful content without a type: invalid.
  assert.equal(validate({ type: undefined, image: "asset-ref" }), "Select a media type.");

  // Type present: valid.
  assert.equal(validate({ type: "image", image: "asset-ref" }), true);
});

test("requireTypeWhenObjectHasValue: a hidden field never blocks saving on initial-value residue", () => {
  // A hidden object holds non-null residue with no `type`, which `isEmptyObjectValue` alone does not catch.
  const residue = { canDownload: true, openInNewTab: false, paramsHref: "?modal=contact" };
  assert.equal(isEmptyObjectValue(residue), false);

  const hidden = ({ parent }: { parent: { [key: string]: unknown } }) => parent.type !== "agency";
  const validate = captureCustom(requireTypeWhenObjectHasValue("Select a link type.", hidden));

  assert.equal(validate(residue, { parent: { type: "freelance" } }), true);
  assert.equal(validate(residue, { parent: { type: "agency" } }), "Select a link type.");
  assert.equal(validate({ type: "external" }, { parent: { type: "agency" } }), true);
});

test("composeValidation: base alone passes through; external results are combined with base", () => {
  const rule = {} as Rule;
  const base = () => "base";
  const external = () => "external";

  assert.equal(composeValidation(base)(rule), "base");
  assert.deepEqual(composeValidation(base, external)(rule), ["external", "base"]);
  assert.deepEqual(composeValidation(base, () => ["e1", "e2"])(rule), ["e1", "e2", "base"]);
});

test("isHomepageDocument: the fixed id, and any language's home URI on a generated id", () => {
  assert.equal(isHomepageDocument({ _id: SINGLETON_IDS.homepage }), true);
  assert.equal(isHomepageDocument({ _id: `drafts.${SINGLETON_IDS.homepage}` }), true);
  // A release version carries no URI of its own to fall back on once an editor moves it.
  assert.equal(isHomepageDocument({ _id: `versions.spring.${SINGLETON_IDS.homepage}`, uri: { current: "/spring" } }), true);

  for (const uri of homeUris()) {
    assert.equal(isHomepageDocument({ _id: "drafts.generated-id", uri: { _type: "slug", current: uri } }), true, uri);
  }

  for (const locale of LOCALE_IDS) {
    const about = withLocalePrefix(locale, "/about");

    assert.equal(isHomepageDocument({ _id: "generated-id", uri: { _type: "slug", current: about } }), false, about);
  }

  assert.equal(isHomepageDocument({ _id: "generated-id", uri: { _type: "slug", current: `/${DEFAULT_LOCALE}` } }), false);
  assert.equal(isHomepageDocument({ _id: "generated-id" }), false);
  assert.equal(isHomepageDocument({ _id: "generated-id", uri: "/" }), false);
  assert.equal(isHomepageDocument(null), false);
});

test("withTranslationExclusions: flags the listed fields on translated types only", () => {
  const [excluded] = TRANSLATION_EXCLUDED_FIELDS;
  const [translated] = I18N_DOCUMENT_TYPES;

  assert.ok(excluded && translated, "both lists must name something for this test to mean anything");

  const fields = [
    { name: "title", type: "string" },
    { name: excluded, type: "object", options: { collapsed: false } },
  ];

  const flagged = withTranslationExclusions({ name: translated, type: "document", fields });

  assert.deepEqual(flagged.fields[0], fields[0]);
  assert.deepEqual(flagged.fields[1]?.options, { collapsed: false, documentInternationalization: { exclude: true } });
  assert.deepEqual(fields[1]?.options, { collapsed: false }, "the source definition is not mutated");

  const shared = { name: "sharedType", type: "document", fields };

  assert.equal(withTranslationExclusions(shared), shared);
  assert.equal(withTranslationExclusions(fields[0]), fields[0]);
});

const singletonIds: readonly string[] = Object.values(SINGLETON_IDS);

test("offersDeleteTranslation: never on a singleton, which the plugin would delete outright", () => {
  for (const id of singletonIds.filter((id) => I18N_DOCUMENT_TYPES.includes(id))) {
    // The fixed document, and a translation of it, which keeps the type but gets a generated id.
    assert.equal(offersDeleteTranslation(id, id, [{ _id: id }]), false, id);
    assert.equal(offersDeleteTranslation(id, "generated-id", [{ _id: "generated-id" }]), false, id);
  }

  assert.equal(offersDeleteTranslation(SANITY_PAGE_DOCUMENT_TYPE, SINGLETON_IDS.homepage), false);

  for (const uri of homeUris()) {
    const homepage = { _id: "generated-id", uri: { _type: "slug", current: uri } };
    const movedDraft = { _id: "drafts.generated-id", uri: { _type: "slug", current: `${uri}/moved`.replace("//", "/") } };

    assert.equal(offersDeleteTranslation(SANITY_PAGE_DOCUMENT_TYPE, "generated-id", [homepage]), false, uri);
    // The plugin deletes the published document too, so a draft that left the home path does not make it deletable.
    assert.equal(
      offersDeleteTranslation(SANITY_PAGE_DOCUMENT_TYPE, "generated-id", [undefined, movedDraft, homepage]),
      false,
      uri
    );
  }
});

test("offersDeleteTranslation: on any other translated document, and nothing untranslated", () => {
  const about = { _id: "generated-id", uri: { _type: "slug", current: "/about" } };

  assert.equal(offersDeleteTranslation(SANITY_PAGE_DOCUMENT_TYPE, "generated-id", [null, about, about]), true);
  // Before its URI is read: the action is then wired in, and decides at render.
  assert.equal(offersDeleteTranslation(SANITY_PAGE_DOCUMENT_TYPE, "generated-id"), true);

  for (const type of I18N_DOCUMENT_TYPES.filter((type) => !singletonIds.includes(type))) {
    assert.equal(offersDeleteTranslation(type, "generated-id", [{ _id: "generated-id" }]), true, type);
  }

  assert.equal(offersDeleteTranslation("articleCategory", "generated-id"), false);
  assert.equal(offersDeleteTranslation("sanity.imageAsset", "image-abc"), false);
});
