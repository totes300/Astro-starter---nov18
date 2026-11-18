import { TranslateIcon } from "@sanity/icons/Translate";
import * as React from "react";
import type { DocumentActionComponent, DocumentActionsContext } from "sanity";
import { getPublishedId, useDocumentPairPermissions } from "sanity";
import { LOCALIZED_FIELDS } from "../constants";
import { DEFAULT_LOCALE } from "../i18n";
import { documentProgress, translateActionState } from "./dialog-model";
import { isInPlaceDocumentType } from "./in-place";
import { fieldTitlesOf } from "./present";
import { useTranslationRun } from "./run-store";
import { useTranslateSwitchedOff } from "./translate-ui";

// Loaded on first open: the action shows on every translated document, the dialog only when asked for.
const TranslateDialog = React.lazy(() => import("./translate-dialog").then((module) => ({ default: module.TranslateDialog })));

/** How `sanity/actions.test.ts` finds it: like the other custom actions it has no built-in `action` name. */
export const TRANSLATE_WITH_AI_ACTION = "TranslateWithAiAction";

type LocalizedType = keyof typeof LOCALIZED_FIELDS;

/** "Translate with AI" on a translated document type, or on a type that translates fields in place (a category, a person). */
export function createTranslateWithAiAction({ schemaType, schema }: DocumentActionsContext): DocumentActionComponent {
  const type = schema.get(schemaType);
  const isCategory = Object.hasOwn(LOCALIZED_FIELDS, schemaType);
  const categoryField = isCategory ? LOCALIZED_FIELDS[schemaType as LocalizedType][0] : undefined;
  const titles = fieldTitlesOf(type as unknown as Parameters<typeof fieldTitlesOf>[0]);

  const translateWithAiAction: DocumentActionComponent = (props) => {
    const [isOpen, setIsOpen] = React.useState(false);
    const run = useTranslationRun();
    const documentId = getPublishedId(props.id);
    const document = (props.draft ?? props.published) as Record<string, unknown> | null;
    const isOff = useTranslateSwitchedOff();
    // The route refuses a Contributor anyway; asking here spares the wait for a plan.
    const [permission] = useDocumentPairPermissions({ id: documentId, type: props.type, permission: "publish" });
    const state = translateActionState({
      hasDocument: Boolean(document),
      isVersion: Boolean(props.version),
      isCategory,
      language: document?.language,
      defaultLocale: DEFAULT_LOCALE,
      progress: documentProgress(run, documentId),
      isOff,
      ...(permission ? { canPublish: permission.granted } : {}),
    });

    if (state.hidden) {
      return null;
    }

    return {
      label: state.label,
      icon: TranslateIcon,
      disabled: state.disabled,
      title: state.title,
      onHandle: () => setIsOpen(true),
      dialog: isOpen
        ? {
            type: "custom",
            component: (
              <React.Suspense fallback={null}>
                <TranslateDialog
                  documentId={documentId}
                  documentType={props.type}
                  isCategory={isCategory}
                  isInPlaceDocument={isInPlaceDocumentType(schemaType)}
                  categoryField={categoryField}
                  published={(props.published as Record<string, unknown> | null) ?? null}
                  draft={(props.draft as Record<string, unknown> | null) ?? null}
                  titles={titles}
                  onClose={() => setIsOpen(false)}
                />
              </React.Suspense>
            ),
          }
        : null,
    };
  };

  translateWithAiAction.displayName = TRANSLATE_WITH_AI_ACTION;

  return translateWithAiAction;
}
