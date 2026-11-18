import { EyeClosedIcon } from "@sanity/icons/EyeClosed";
import { Card, Stack, Text } from "@sanity/ui";
import * as changeCase from "change-case";
import type { StructureBuilder, StructureResolverContext } from "sanity/structure";
import { sanityConfig } from "./config";
import { API_ONLY_DOCUMENTS, I18N_DOCUMENT_TYPES, SINGLETON_IDS, TEMPLATE_IDS } from "./constants";
import { DEFAULT_LOCALE, homeUris, IS_I18N_ENABLED, LOCALE_IDS, LOCALES, withLocalePrefix } from "./i18n";
import {
  CONFIGURED_LANGUAGE_FILTER,
  grouped,
  type TranslationEntry,
  translationIdsByLanguage,
  UNSERVED_LANGUAGE_FILTER,
  unservedLanguageList,
  unservedLanguages,
} from "./structure-groups";

type LocaleGroupedListOptions = { id: string; title: string; schemaType: string; filter?: string };

/** One child per language, so an editor sees them side by side. A single locale gets one list of its own language. */
function localeGroupedList(S: StructureBuilder, { id, title, schemaType, filter }: LocaleGroupedListOptions) {
  const documentList = (language?: string) => {
    const languageFilter = language ? `coalesce(language, "${DEFAULT_LOCALE}") == "${language}"` : CONFIGURED_LANGUAGE_FILTER;

    // A type list, not a bare document list, so it keeps the type's sort menu and create button.
    const list = S.documentTypeList(schemaType)
      .id(language ? `${id}-${language}-list` : `${id}-list`)
      .title(language ? `${title} (${language.toUpperCase()})` : title)
      .apiVersion(sanityConfig.apiVersion)
      .filter(["_type == $type", filter, languageFilter].filter(Boolean).join(" && "));

    if (!language || !I18N_DOCUMENT_TYPES.includes(schemaType)) {
      return list;
    }

    const handles = list.getCanHandleIntent();

    // The default only matches the type, so an open folder of another language would claim the document.
    return (
      list
        .canHandleIntent(
          (intent, params, context) =>
            (params.language === undefined || params.language === language) && Boolean(handles?.(intent, params, context))
        )
        // The plugin's `<type>-<language>` template, so "+" in a folder creates in its language. Last: later setters re-infer.
        .initialValueTemplates([S.initialValueTemplateItem(`${schemaType}-${language}`)])
    );
  };

  if (!IS_I18N_ENABLED) {
    return documentList();
  }

  return S.list()
    .title(title)
    .id(`${id}-locales`)
    .items(
      LOCALES.map(({ id: language, title: languageTitle, flag }) =>
        S.listItem()
          .title(languageTitle)
          .id(`${id}-${language}`)
          .icon(() => <>{flag}</>)
          .child(documentList(language))
      )
    );
}

type SingletonOptions = {
  title: string;
  schemaType: string;
  documentId: string;
  icon?: () => React.ReactNode;
  /** Prefills the document on creation (e.g. homepage title; URI is set in the template). */
  initialValueTemplate?: { templateId: string; parameters?: Record<string, unknown> };
  /** The URI that also identifies it in a language, so one created outside the translation menu still opens there. */
  uriIn?: (language: string) => string;
};

/** The document pane for one singleton document. `documentId` is overridden to open a translation. */
function singletonDocument(S: StructureBuilder, { title, schemaType, documentId, initialValueTemplate }: SingletonOptions) {
  const doc = S.document().schemaType(schemaType).documentId(documentId).title(title);

  if (!initialValueTemplate) {
    return doc;
  }

  const { templateId, parameters } = initialValueTemplate;

  return doc.initialValueTemplate(templateId, parameters);
}

function singleton(S: StructureBuilder, options: SingletonOptions) {
  const { title, documentId, icon } = options;

  return S.listItem().title(title).id(documentId).icon(icon).child(singletonDocument(S, options));
}

/** Only the default locale keeps the fixed id; the rest are generated, so they are looked up through the metadata document. */
async function fetchTranslationIds(context: StructureResolverContext, { documentId, schemaType, uriIn }: SingletonOptions) {
  const client = context.getClient({ apiVersion: sanityConfig.apiVersion });
  const [entries, atUri] = await Promise.all([
    // `versionOf` also finds a translation that so far exists only as a draft or inside a release.
    client.fetch<TranslationEntry[]>(
      `*[_type == "translation.metadata" && $id in translations[].value._ref].translations[]{
        "id": value._ref,
        "language": coalesce(value->language, *[sanity::versionOf(^.value._ref)][0].language, "${DEFAULT_LOCALE}")
      }`,
      { id: documentId }
    ),
    uriIn
      ? client.fetch<TranslationEntry[]>(
          `*[_type == $type && uri.current in $uris]{ "id": _id, "language": coalesce(language, "${DEFAULT_LOCALE}") }`,
          { type: schemaType, uris: LOCALE_IDS.map(uriIn) }
        )
      : [],
  ]);

  return translationIdsByLanguage(entries, atUri);
}

/** An always-empty list, so an untranslated language resolves to Sanity's empty state rather than misrepresenting another document. */
function untranslatedLocale(S: StructureBuilder, title: string) {
  return S.documentList().title(title).apiVersion(sanityConfig.apiVersion).filter("_id in $ids").params({ ids: [] });
}

/** Grouping is resolved on open, not at build: a translation's id only exists once the translation does. */
function localeGroupedSingleton(S: StructureBuilder, context: StructureResolverContext, options: SingletonOptions) {
  if (!IS_I18N_ENABLED) {
    return singleton(S, options);
  }

  const { title, documentId, icon } = options;

  return S.listItem()
    .title(title)
    .id(documentId)
    .icon(icon)
    .child(async () => {
      const translations = await fetchTranslationIds(context, options);

      return S.list()
        .title(title)
        .id(`${documentId}-locales`)
        .items(
          LOCALES.map(({ id: language, title: languageTitle, flag }) => {
            const translatedId = language === DEFAULT_LOCALE ? documentId : translations.get(language);

            return S.listItem()
              .title(languageTitle)
              .id(`${documentId}-${language}`)
              .icon(() => <>{flag}</>)
              .child(
                translatedId
                  ? singletonDocument(S, { ...options, documentId: translatedId })
                  : untranslatedLocale(S, `${title} (${languageTitle})`)
              );
          })
        );
    });
}

const UNSERVED_TITLE = "Other languages";

function UnservedLanguagesHelp() {
  return (
    <Card padding={4}>
      <Stack gap={4}>
        <Text size={1}>
          These documents are in a language that LOCALES in sanity/i18n.ts does not list, so the site never shows them.
        </Text>
        <Text size={1} muted>
          To delete them, ask a developer to run npm run trim, which offers every language the site no longer serves. To bring one
          back, they add it to LOCALES again.
        </Text>
        <Text size={1} muted>
          For a document with no language, ask a developer to run npm run sanity:migrate-backfill-language.
        </Text>
      </Stack>
    </Card>
  );
}

/** Read on open, drafts and release versions included, so a removed language is found before anyone purges it. */
async function fetchUnservedLanguages(context: StructureResolverContext) {
  try {
    const documents = await context
      .getClient({ apiVersion: sanityConfig.apiVersion })
      .fetch<{ _id: string; language?: unknown }[]>(
        `*[${UNSERVED_LANGUAGE_FILTER}]{ _id, language }`,
        { types: [...I18N_DOCUMENT_TYPES] },
        { perspective: "raw" }
      );

    return unservedLanguages(documents);
  } catch (error) {
    console.error("Could not group the documents in languages this site does not serve:", error);

    return [];
  }
}

/** Checked once on load: a language only stops being served when LOCALES changes, and that reloads the Studio. */
async function hasUnservedLanguages(context: StructureResolverContext) {
  try {
    return await context
      .getClient({ apiVersion: sanityConfig.apiVersion })
      .fetch<boolean>(
        `count(*[${UNSERVED_LANGUAGE_FILTER}][0...1]) > 0`,
        { types: [...I18N_DOCUMENT_TYPES] },
        { perspective: "raw" }
      );
  } catch {
    // An unreadable dataset keeps the item, so a ghost is never hidden by a failed check.
    return true;
  }
}

/** Shown only while some document is in a language the site does not serve: one list per language, which `npm run trim` deletes. */
function unservedLanguagesItem(S: StructureBuilder, context: StructureResolverContext) {
  const types = [...I18N_DOCUMENT_TYPES];

  return S.listItem()
    .title(UNSERVED_TITLE)
    .id("unserved-languages")
    .icon(EyeClosedIcon)
    .child(async () => {
      const groups = await fetchUnservedLanguages(context);

      // Live and ungrouped, so it still lists a document that turns up later, or every one when the read failed.
      if (!groups.length) {
        return S.documentList()
          .id("unserved-languages-none")
          .title(UNSERVED_TITLE)
          .apiVersion(sanityConfig.apiVersion)
          .filter(UNSERVED_LANGUAGE_FILTER)
          .params({ types })
          .initialValueTemplates([]);
      }

      return S.list()
        .title(UNSERVED_TITLE)
        .id("unserved-languages-list")
        .items([
          S.listItem()
            .title("How to remove them")
            .id("unserved-languages-help")
            .icon(() => <>💡</>)
            .child(S.component(UnservedLanguagesHelp).id("unserved-languages-help-pane").title("How to remove them")),
          S.divider(),
          ...groups.map((group, index) => {
            const { filter, params } = unservedLanguageList(group, types);

            return S.listItem()
              .title(group.label)
              .id(`unserved-languages-${index}`)
              .child(
                S.documentList()
                  .id(`unserved-languages-${index}-list`)
                  .title(group.label)
                  .apiVersion(sanityConfig.apiVersion)
                  .filter(filter)
                  .params(params)
                  .initialValueTemplates([])
              );
          }),
        ]);
    });
}

export async function buildStructure(S: StructureBuilder, context: StructureResolverContext) {
  const items = [
    // Homepage
    localeGroupedSingleton(S, context, {
      title: "Homepage",
      schemaType: "page",
      documentId: SINGLETON_IDS.homepage,
      icon: () => <>🏠</>,
      initialValueTemplate: {
        templateId: TEMPLATE_IDS.pageSingleton,
        parameters: { title: "Homepage" },
      },
      // Pages leaves every home URI out, so a homepage the translation menu did not make would otherwise be listed nowhere.
      uriIn: (language) => withLocalePrefix(language, "/"),
    }),

    // Singletons by id, and every homepage by URI: a translated homepage has a generated id.
    S.listItem()
      .title("Pages")
      .icon(() => <>📑</>)
      .child(
        localeGroupedList(S, {
          id: "pages",
          title: "Pages",
          schemaType: "page",
          filter: `!(uri.current in [${homeUris()
            .map((uri) => `'${uri}'`)
            .join(",")}]) && !(_id in [${Object.values(SINGLETON_IDS)
            .map((id) => `'${id}'`)
            .join(",")}])`,
        })
      ),

    // Legal pages are routed by the same catch-all as a page, so they sit beside Pages rather than under their own route.
    S.listItem()
      .title("Legal")
      .icon(() => <>⚖️</>)
      .child(localeGroupedList(S, { id: "legal-pages", title: "Legal", schemaType: "legalPage" })),

    // PLOP: Add Structure

    S.divider(),

    // Blog: the index singleton (the article list is rendered by the route) plus its articles.
    S.listItem()
      .title("Blog")
      .icon(() => <>📰</>)
      .child(
        S.list()
          .title("Blog")
          .items([
            localeGroupedSingleton(S, context, {
              title: "Index",
              schemaType: "blog",
              documentId: SINGLETON_IDS.blog,
              icon: () => <>🗞</>,
            }),
            S.listItem()
              .title("Articles")
              .icon(() => <>📖</>)
              .child(localeGroupedList(S, { id: "articles", title: "Articles", schemaType: "article" })),
            // Shared by every language: one person, their role, bio and SEO translated in place.
            S.listItem()
              .title("Authors")
              .icon(() => <>👤</>)
              .child(S.documentTypeList("person").title("Authors")),
            // Shared by every language; only its name is translated, in place.
            S.listItem()
              .title("Article Categories")
              .icon(() => <>🔍</>)
              .child(S.documentTypeList("articleCategory").title("Article Categories")),
          ])
      ),

    S.divider(),

    // Form Submissions (driven by API_ONLY_DOCUMENTS)
    S.listItem()
      .title("Form Submissions")
      .icon(() => <>📥</>)
      .child(
        S.list()
          .title("Form Submissions")
          .items(
            Object.values(API_ONLY_DOCUMENTS).map((schemaType) =>
              S.listItem()
                .title(changeCase.capitalCase(schemaType))
                .icon(() => <>📩</>)
                .child(S.documentTypeList(schemaType).title(changeCase.capitalCase(schemaType)))
            )
          )
      ),

    S.divider(),

    // Site is the copy that renders; its site-wide counterpart is configuration, so it sits next to it rather than inside it.
    localeGroupedSingleton(S, context, {
      title: "Site",
      schemaType: "site",
      documentId: SINGLETON_IDS.site,
      icon: () => <>🎫</>,
    }),

    singleton(S, {
      title: "Settings",
      schemaType: "siteSettings",
      documentId: SINGLETON_IDS.siteSettings,
      icon: () => <>⚙️</>,
    }),
  ];

  if (await hasUnservedLanguages(context)) {
    items.push(S.divider(), unservedLanguagesItem(S, context));
  }

  return S.list().title("The Content Architecture").items(grouped(items));
}
