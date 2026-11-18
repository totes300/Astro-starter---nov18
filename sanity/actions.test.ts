import "./schemas/test-env";
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { DocumentActionComponent, DocumentActionProps, DocumentActionsContext } from "sanity";
import { I18N_DOCUMENT_TYPES, LOCALIZED_FIELDS, SANITY_PAGE_DOCUMENT_TYPE, SINGLETON_IDS } from "./constants";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS, withLocalePrefix } from "./i18n";

let createDocumentActions: typeof import("./actions").createDocumentActions;
let translateWithAi: string;

before(async () => {
  ({ createDocumentActions } = await import("./actions"));
  ({ TRANSLATE_WITH_AI_ACTION: translateWithAi } = await import("./ai-translation/translate-action"));
});

const BUILT_IN = ["publish", "unpublish", "delete", "duplicate", "discardChanges", "restore"];
const SINGLETON_ACTIONS = ["publish", "discardChanges", "restore"];

/** A stand-in for a built-in action: no hooks, so it can be called outside the Studio. */
function builtIn(name: string): DocumentActionComponent {
  const action: DocumentActionComponent = () => ({ label: name });

  action.action = name as DocumentActionComponent["action"];

  return action;
}

function actionsFor(schemaType: string, documentId: string, extra: DocumentActionComponent[] = []) {
  const context = { schemaType, documentId, schema: { get: () => undefined }, getClient: () => ({}) };

  return createDocumentActions([...BUILT_IN.map(builtIn), ...extra], context as unknown as DocumentActionsContext);
}

const named = (actions: readonly DocumentActionComponent[]) => actions.flatMap(({ action }) => (action ? [action] : []));

const displayed = (actions: readonly DocumentActionComponent[]) =>
  actions.map(({ action, displayName }) => action ?? displayName);

// `string`, so the fixtures stay valid when only the default locale is configured.
const secondary: string = LOCALE_IDS.find((locale) => locale !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;
const singletonTypes = Object.values(SINGLETON_IDS).filter((id) => I18N_DOCUMENT_TYPES.includes(id));

describe("createDocumentActions", () => {
  it("leaves a translation group nothing that deletes it or its documents, the singletons among them", () => {
    const deleteAll: DocumentActionComponent = () => ({ label: "Delete all translations" });
    const actions = actionsFor("translation.metadata", "metadata", [deleteAll]);

    assert.ok(!actions.includes(deleteAll));
    assert.deepEqual(named(actions), ["discardChanges", "restore"]);
  });

  it("leaves a singleton, in any language, only publish, discard and restore, and never Delete translation", () => {
    for (const type of singletonTypes) {
      for (const id of [type, "generated-id"]) {
        assert.deepEqual(named(actionsFor(type, id)), SINGLETON_ACTIONS, `${type} ${id}`);
      }
    }

    assert.deepEqual(named(actionsFor(SANITY_PAGE_DOCUMENT_TYPE, SINGLETON_IDS.homepage)), SINGLETON_ACTIONS);
  });

  it("offers Delete translation on another translated page only with a second language", () => {
    const expected = IS_I18N_ENABLED ? [...BUILT_IN, "deleteTranslation"] : BUILT_IN;

    assert.deepEqual(named(actionsFor(SANITY_PAGE_DOCUMENT_TYPE, "generated-id")), expected);
  });

  it("hides a page's destructive actions while any of its variants is a homepage", { skip: !IS_I18N_ENABLED }, () => {
    const actions = actionsFor(SANITY_PAGE_DOCUMENT_TYPE, "generated-id");
    const run = (name: string, props: Record<string, object>) =>
      actions.find(({ action }) => action === name)?.({
        id: "generated-id",
        type: "page",
        ...props,
      } as unknown as DocumentActionProps);
    const page = (uri: string, id = "generated-id") => ({ _id: id, _type: "page", uri: { current: uri } });
    const home = withLocalePrefix(secondary, "/");
    const moved = withLocalePrefix(secondary, "/moved");

    for (const name of ["delete", "unpublish", "duplicate"]) {
      assert.equal(run(name, { published: page(home), draft: page(moved, "drafts.generated-id") }), null, name);
      assert.equal(run(name, { published: page(moved), version: page(home, "versions.spring.generated-id") }), null, name);
      assert.deepEqual(run(name, { published: page(moved), draft: page(moved, "drafts.generated-id") }), { label: name }, name);
    }

    assert.deepEqual(run("publish", { published: page(home) }), { label: "publish" });
  });

  it("offers Translate with AI on every translated type and every category, only with a second language", () => {
    for (const type of [...I18N_DOCUMENT_TYPES, ...Object.keys(LOCALIZED_FIELDS)]) {
      for (const id of [type, "generated-id"]) {
        assert.equal(displayed(actionsFor(type, id)).includes(translateWithAi), IS_I18N_ENABLED, `${type} ${id}`);
      }
    }
  });

  it("never offers Translate with AI on Settings, a translation group or a type that is not translated", () => {
    for (const [type, id] of [
      [SINGLETON_IDS.siteSettings, SINGLETON_IDS.siteSettings],
      ["translation.metadata", "metadata"],
      ["redirect", "redirect-1"],
    ] as const) {
      assert.ok(!displayed(actionsFor(type, id)).includes(translateWithAi), type);
    }
  });

  it("puts Translate with AI after the open-page actions and before Delete translation", { skip: !IS_I18N_ENABLED }, () => {
    const order = displayed(actionsFor(SANITY_PAGE_DOCUMENT_TYPE, "generated-id"));

    // The open-page actions have neither an `action` nor a `displayName`.
    assert.ok(order.indexOf(translateWithAi) > order.lastIndexOf(undefined));
    assert.equal(order.indexOf(translateWithAi), order.indexOf("deleteTranslation") - 1);
  });
});
