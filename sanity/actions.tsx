import { useDeleteTranslationAction } from "@sanity/document-internationalization";
import { LaunchIcon } from "@sanity/icons/Launch";
import { MasterDetailIcon } from "@sanity/icons/MasterDetail";
import { PresentationIcon } from "@sanity/icons/Presentation";
import { createPreviewSecret } from "@sanity/preview-url-secret/create-secret";
import { useToast } from "@sanity/ui/toast";
import type { DocumentActionComponent, DocumentActionProps, DocumentActionsContext } from "sanity";
import { getPublishedId } from "sanity";
import { useRouter } from "sanity/router";
import { createTranslateWithAiAction } from "./ai-translation/translate-action";
import { sanityConfig } from "./config";
import {
  AGENT_SCRATCH_DOCUMENTS,
  API_ONLY_DOCUMENTS,
  I18N_DOCUMENT_TYPES,
  LOCALIZED_FIELDS,
  SANITY_PAGE_DOCUMENT_TYPE,
  SINGLETON_IDS,
} from "./constants";
import { IS_I18N_ENABLED } from "./i18n";
import { isHomepageDocument, offersDeleteTranslation } from "./utils";

/** The draft-mode routes only redirect to a path starting with `/`, and a slug may be stored without one. */
function toSitePath(uri: string) {
  return uri.startsWith("/") ? uri : `/${uri}`;
}

function createOpenPublishedPageAction(_: DocumentActionsContext) {
  const openPublishedPageAction: DocumentActionComponent = (props) => {
    const uri = (props.published as { uri?: { current?: string } } | undefined)?.uri?.current;

    if (!uri) {
      return null;
    }

    const url = new URL(`${sanityConfig.appUrl}${sanityConfig.endpoints.draftModeDisable}`);
    url.searchParams.set("redirectTo", toSitePath(uri));

    return {
      label: "Open live page",
      icon: LaunchIcon,
      onHandle: () => {
        window.open(url.toString(), "_blank", "noreferrer");
      },
    };
  };

  return openPublishedPageAction;
}

function createOpenPreviewPageAction({ getClient, currentUser }: DocumentActionsContext) {
  const client = getClient({ apiVersion: sanityConfig.apiVersion });

  const openPreviewPageAction: DocumentActionComponent = (props) => {
    const draftUri = (props.draft as { uri?: { current?: string } } | undefined)?.uri?.current;
    const publishedUri = (props.published as { uri?: { current?: string } } | undefined)?.uri?.current;
    const uri = draftUri ?? publishedUri;

    if (!uri) {
      return null;
    }

    return {
      label: "Open draft page",
      icon: LaunchIcon,
      onHandle: async () => {
        try {
          // Private and expiring (1 hour), unlike Presentation's shared secret, which never expires.
          const { secret } = await createPreviewSecret(client, "open-draft-page", window.location.href, currentUser?.id);
          const url = new URL(`${sanityConfig.appUrl}${sanityConfig.endpoints.draftModeEnable}`);
          url.searchParams.set("sanity-preview-secret", secret);
          url.searchParams.set("sanity-preview-pathname", toSitePath(uri));
          url.searchParams.set("sanity-preview-perspective", "drafts");
          window.open(url.toString(), "_blank", "noreferrer");
        } catch (e) {
          console.error("Failed to open preview page:", e);
          alert("Failed to open preview page. See console for details.");
        }
      },
    };
  };

  return openPreviewPageAction;
}

function createOpenPresentationAction(_: DocumentActionsContext) {
  const openPresentationAction: DocumentActionComponent = (props) => {
    const { navigateIntent } = useRouter();
    const draftUri = (props.draft as { uri?: { current?: string } } | undefined)?.uri?.current;
    const publishedUri = (props.published as { uri?: { current?: string } } | undefined)?.uri?.current;
    const uri = draftUri ?? publishedUri;

    if (!uri) {
      return null;
    }

    const documentId = getPublishedId(props.id);
    const documentType = props.type;
    const basePath = sanityConfig.studioBasePath.replace(/\/$/, "");
    const isPresentationMode = typeof window !== "undefined" && window.location.pathname.startsWith(`${basePath}/presentation`);

    if (!documentId || !documentType || isPresentationMode) {
      return null;
    }

    return {
      label: "Open in presentation",
      icon: PresentationIcon,
      onHandle: () => {
        navigateIntent("edit", {
          id: documentId,
          type: documentType,
          mode: "presentation",
          presentation: "presentation",
          preview: uri,
        });
      },
    };
  };

  return openPresentationAction;
}

function createOpenStructureAction(_: DocumentActionsContext) {
  const openStructureAction: DocumentActionComponent = (props) => {
    const { navigateIntent } = useRouter();
    const documentId = getPublishedId(props.id);
    const documentType = props.type;
    const language = (props.version ?? props.draft ?? props.published)?.language;
    const basePath = sanityConfig.studioBasePath.replace(/\/$/, "");
    const isPresentationMode = typeof window !== "undefined" && window.location.pathname.startsWith(`${basePath}/presentation`);

    if (!documentId || !documentType || !isPresentationMode) {
      return null;
    }

    return {
      label: "Open in Structure",
      icon: MasterDetailIcon,
      onHandle: () => {
        // The language picks that language's folder; without it the first folder of the type claims the document.
        navigateIntent("edit", {
          id: documentId,
          type: documentType,
          mode: "structure",
          ...(typeof language === "string" ? { language } : {}),
        });
      },
    };
  };

  return openStructureAction;
}

/** Publish as usual, then remind the editor that the stored agent Markdown is not regenerated on its own. */
function withAgentMarkdownReminder(publishAction: DocumentActionComponent) {
  const action: DocumentActionComponent = (props) => {
    const description = publishAction(props);
    const toast = useToast();

    if (!description) {
      return null;
    }

    const isServing = (props.draft as { agentMarkdown?: { enabled?: boolean } } | null)?.agentMarkdown?.enabled !== false;

    return {
      ...description,
      onHandle: () => {
        description.onHandle?.();

        if (isServing) {
          toast.push({
            status: "info",
            title: "Agent Markdown may be out of date",
            description: "If this page's content changed, open the Agents tab, click Generate, then publish again.",
            closable: true,
            duration: 12_000,
          });
        }
      },
    };
  };

  action.action = publishAction.action;
  action.displayName = publishAction.displayName;

  return action;
}

const singletonIds: string[] = Object.values(SINGLETON_IDS);
const apiOnlyTypes: string[] = Object.values(API_ONLY_DOCUMENTS);
const scratchTypes: string[] = Object.values(AGENT_SCRATCH_DOCUMENTS);
const SINGLETON_ACTIONS: string[] = ["publish", "discardChanges", "restore"];
/** The translation plugin's own type, whose "Delete all translations" deletes every document in a group, singletons included. */
const TRANSLATION_METADATA_TYPE = "translation.metadata";
// Deleting the group itself would hide the Site, Blog Index and Homepage translations, which the desk finds through it.
const TRANSLATION_METADATA_ACTIONS: string[] = ["discardChanges", "restore"];

/** Every variant an action can reach: a draft moved off the home path would otherwise delete the published homepage. */
function variantsOf({ version, draft, published }: DocumentActionProps) {
  return [version, draft, published];
}

/** Always calls the action, so its hooks run in the same order whether or not the document is a homepage. */
function hiddenOnHomepage(action: DocumentActionComponent): DocumentActionComponent {
  const guarded: DocumentActionComponent = (props) => {
    const description = action(props);

    return variantsOf(props).some(isHomepageDocument) ? null : description;
  };

  guarded.action = action.action;
  guarded.displayName = action.displayName;

  return guarded;
}

// The plugin types `action` as `string` while Sanity narrows it to built-in names, which a plugin action cannot satisfy.
const pluginDeleteTranslationAction = useDeleteTranslationAction as unknown as DocumentActionComponent;

/** Always calls the plugin's action, so its hooks run in the same order whether or not it is offered. */
function createDeleteTranslationAction({ schemaType, documentId }: DocumentActionsContext): DocumentActionComponent {
  const deleteTranslationAction: DocumentActionComponent = (props) => {
    const description = pluginDeleteTranslationAction(props);

    return offersDeleteTranslation(schemaType, documentId ?? props.id, variantsOf(props)) ? description : null;
  };

  deleteTranslationAction.action = pluginDeleteTranslationAction.action;
  deleteTranslationAction.displayName = pluginDeleteTranslationAction.displayName;

  return deleteTranslationAction;
}

export function createDocumentActions(prev: DocumentActionComponent[], ctx: DocumentActionsContext) {
  const { schemaType, documentId } = ctx;

  if (!schemaType || !documentId) {
    return prev;
  }

  if (schemaType === TRANSLATION_METADATA_TYPE) {
    return prev.filter(({ action }) => action && TRANSLATION_METADATA_ACTIONS.includes(action));
  }

  let builtInActions = prev;

  if (singletonIds.includes(schemaType) || singletonIds.includes(documentId)) {
    builtInActions = prev.filter(({ action }) => {
      return action && SINGLETON_ACTIONS.includes(action);
    });
  }

  // A translated homepage has a generated id, so only its URI (read at render) marks it as a singleton.
  if (IS_I18N_ENABLED && schemaType === SANITY_PAGE_DOCUMENT_TYPE && !singletonIds.includes(documentId)) {
    builtInActions = prev.map((action) =>
      action.action && SINGLETON_ACTIONS.includes(action.action) ? action : hiddenOnHomepage(action)
    );
  }

  if (apiOnlyTypes.includes(schemaType) || apiOnlyTypes.includes(documentId)) {
    builtInActions = prev.filter(({ action }) => {
      return action && ["delete", "discardChanges"].includes(action);
    });
  }

  if (scratchTypes.includes(schemaType) || scratchTypes.includes(documentId)) {
    builtInActions = prev.filter(({ action }) => {
      return action && ["delete", "discardChanges"].includes(action);
    });
  }

  const documentType = ctx.schema.get(schemaType);
  const hasAgentMarkdown = Boolean(
    documentType &&
      "fields" in documentType &&
      documentType.fields.some((field) => field.name === "agentMarkdown" && field.type.jsonType === "object")
  );

  if (hasAgentMarkdown) {
    builtInActions = builtInActions.map((action) => (action.action === "publish" ? withAgentMarkdownReminder(action) : action));
  }

  const openStructureAction = createOpenStructureAction(ctx);
  const openPreviewPageAction = createOpenPreviewPageAction(ctx);
  const openPresentationAction = createOpenPresentationAction(ctx);
  const openPublishedPageAction = createOpenPublishedPageAction(ctx);
  const customActions = [openPublishedPageAction, openPreviewPageAction, openPresentationAction, openStructureAction];

  if (IS_I18N_ENABLED && (I18N_DOCUMENT_TYPES.includes(schemaType) || Object.hasOwn(LOCALIZED_FIELDS, schemaType))) {
    customActions.push(createTranslateWithAiAction(ctx));
  }

  // Through the plugin, so `translation.metadata` drops its reference too. Never on a singleton, which it would delete outright.
  if (IS_I18N_ENABLED && offersDeleteTranslation(schemaType, documentId)) {
    customActions.push(createDeleteTranslationAction(ctx));
  }

  return [...builtInActions, ...customActions] as const satisfies DocumentActionComponent[];
}
