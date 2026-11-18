import type { SanityClient } from "@sanity/client";
import { isFilledNamesDraft } from "~/sanity/ai-translation/plan";
import { LOCALIZED_FIELDS } from "~/sanity/constants";
import { DEFAULT_LOCALE } from "~/sanity/i18n";
import { byPublishedId, readDocuments } from "./reads";

const FIELDS: Readonly<Record<string, readonly string[]>> = LOCALIZED_FIELDS;

/** Category drafts that only fill empty names, proved on the server: `publish` takes them at the revision read here. */
export async function provedLabelDrafts(
  client: SanityClient,
  ids: readonly string[],
  revs: Readonly<Record<string, string>> = {}
): Promise<Record<string, string>> {
  const unnamed = ids.filter((id) => !Object.hasOwn(revs, id));
  const copies = byPublishedId(unnamed.length > 0 ? await readDocuments(client, unnamed) : []);
  const proved = unnamed.flatMap((id): [string, string][] => {
    const { draft, published } = copies.get(id) ?? {};
    const fields = draft && Object.hasOwn(FIELDS, draft._type) ? FIELDS[draft._type] : undefined;

    return draft &&
      published &&
      fields &&
      typeof draft._rev === "string" &&
      isFilledNamesDraft(draft, published, fields, DEFAULT_LOCALE)
      ? [[id, draft._rev]]
      : [];
  });

  return { ...Object.fromEntries(proved), ...revs };
}
