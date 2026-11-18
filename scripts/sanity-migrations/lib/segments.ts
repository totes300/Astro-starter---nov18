// Planners behind `sanity:migrate-segments`: which section URIs a renamed word moves, and the 301s that keep the old
// URLs working. Pure, so the plan is tested without a dataset.

import { randomBytes } from "node:crypto";
import { isLocale, splitLocalePrefix } from "../../../sanity/i18n";
import { localizeDocumentPath, SECTION_TYPES, type SectionTypes, sectionOfType } from "../../../sanity/sections";
import { publishedIdOf } from "../../trim-features/language-removal";
import { documentLanguage, type LanguageCopy, statedLanguages } from "./language";
import { type Release, releaseLock } from "./releases";

export type UriChange = { id: string; type: string; rev?: string; from: string; to: string };

export type RedirectItem = { _key: string; _type: "redirect"; from: string; to: string; statusCode: 301 };

/** A `siteSettings.redirects` item; `ref` is set when it points at a redirect document instead of holding one. */
export type ExistingRedirect = { _key?: string | null; from?: string | null; to?: string | null; ref?: string | null };

export type SettingsCopy = { _id: string; _rev?: string; redirects?: readonly ExistingRedirect[] | null };

export type SettingsPatch = { id: string; rev?: string; add: RedirectItem[]; retarget: { key: string; to: string }[] };

export type Finding = { id: string; reason: string };

export type SegmentPlan = {
  changes: UriChange[];
  /** Section documents with no slug under a word: moving them would be a guess. */
  unplaced: LanguageCopy[];
  /** Moves that would land on a URL a document or an existing redirect already answers. */
  collisions: Finding[];
  locked: Finding[];
  /** One 301 per public URL that moves; `settings` says which copy gains which. */
  redirects: RedirectItem[];
  settings: SettingsPatch[];
  /** Redirects stored as references, which point at a moved URL and are edited by hand. */
  manual: ExistingRedirect[];
};

const typesOf = (section: string) => (SECTION_TYPES as Record<string, SectionTypes>)[section] as SectionTypes;

/** How the site matches a redirect: the path alone, without its anchor, query, letter case or a trailing `/`. */
export function pathKey(path: string): string {
  const end = path.search(/[?#]/);
  const bare = end === -1 ? path : path.slice(0, end);
  const trimmed = bare.length > 1 && bare.endsWith("/") ? bare.slice(0, -1) : bare;

  return trimmed.toLowerCase();
}

/** URIs missing their language's current section word; a slugless one is reported, a ghost or `""` one left alone. */
export function planSegmentChanges(
  documents: readonly LanguageCopy[],
  defaultLocale: string
): { changes: UriChange[]; unplaced: LanguageCopy[] } {
  const stated = statedLanguages(documents);
  const changes: UriChange[] = [];
  const unplaced: LanguageCopy[] = [];

  for (const document of documents) {
    const language = documentLanguage(document, stated, defaultLocale);
    const section = sectionOfType(document._type);

    if (!document.uri || !section || !language || !isLocale(language)) {
      continue;
    }

    const isRouted = typesOf(section).index !== document._type;

    if (isRouted && splitLocalePrefix(document.uri).pathname.split("/").filter(Boolean).length < 2) {
      unplaced.push(document);
      continue;
    }

    const to = localizeDocumentPath(document._type, language, document.uri);

    if (to !== document.uri) {
      changes.push({ id: document._id, type: document._type, rev: document._rev, from: document.uri, to });
    }
  }

  return { changes, unplaced };
}

/** URLs that answer once the moves land: every document that stays, and every move's target. */
function liveAfter(changes: readonly UriChange[], holders: readonly LanguageCopy[]): Set<string> {
  const moving = new Set(changes.map(({ id }) => id));
  const live = holders.flatMap(({ _id, uri }) => (uri && !moving.has(_id) ? [pathKey(uri)] : []));

  return new Set([...live, ...changes.map(({ to }) => pathKey(to))]);
}

/** A target another document holds, another move takes, or an existing redirect answers: two things at one URL. */
export function findTargetCollisions(
  changes: readonly UriChange[],
  holders: readonly LanguageCopy[],
  redirects: readonly ExistingRedirect[]
): Finding[] {
  const moving = new Set(changes.map(({ id }) => id));
  const owners = new Map<string, string>();
  const redirected = new Set(redirects.flatMap(({ from }) => (from ? [pathKey(from)] : [])));
  const collisions: Finding[] = [];

  for (const { _id, uri } of holders) {
    if (uri && !moving.has(_id)) {
      owners.set(pathKey(uri), publishedIdOf(_id));
    }
  }

  for (const { id, from, to } of changes) {
    const key = pathKey(to);
    const owner = owners.get(key);

    if (owner && owner !== publishedIdOf(id)) {
      collisions.push({ id, reason: `${from} → ${to}: ${owner} already answers there.` });
    } else if (redirected.has(key)) {
      collisions.push({ id, reason: `${from} → ${to}: a redirect from ${to} already exists and would hide the page.` });
    } else {
      owners.set(key, publishedIdOf(id));
    }
  }

  return collisions;
}

/** One 301 per public URL that moves, unless it is already redirected or answers again after the moves. */
export function planRedirects(
  changes: readonly UriChange[],
  existing: readonly ExistingRedirect[],
  live: ReadonlySet<string>
): RedirectItem[] {
  const taken = new Set(existing.flatMap(({ from }) => (from ? [pathKey(from)] : [])));
  const redirects: RedirectItem[] = [];

  for (const { id, from, to } of changes) {
    const key = pathKey(from);

    if (id !== publishedIdOf(id) || taken.has(key) || live.has(key)) {
      continue;
    }

    taken.add(key);
    redirects.push({ _key: randomBytes(12).toString("hex"), _type: "redirect", from, to, statusCode: 301 });
  }

  return redirects;
}

/** Redirects aimed at a moved URL, re-aimed at its new one with their anchor or query kept, so none chains. */
export function planRedirectRetargets(
  changes: readonly UriChange[],
  existing: readonly ExistingRedirect[]
): { retarget: { key: string; to: string }[]; manual: ExistingRedirect[] } {
  const moved = new Map(changes.filter(({ id }) => id === publishedIdOf(id)).map(({ from, to }) => [pathKey(from), to]));
  const retarget: { key: string; to: string }[] = [];
  const manual: ExistingRedirect[] = [];

  for (const redirect of existing) {
    const target = redirect.to ? moved.get(pathKey(redirect.to)) : undefined;

    if (!target || !redirect.to) {
      continue;
    }

    const end = redirect.to.search(/[?#]/);
    const to = end === -1 ? target : `${target}${redirect.to.slice(end)}`;

    if (redirect.ref || !redirect._key || !/^[A-Za-z0-9_-]+$/.test(redirect._key)) {
      manual.push(redirect);
    } else {
      retarget.push({ key: redirect._key, to });
    }
  }

  return { retarget, manual };
}

/** The whole migration: the moves, what stops them, and the redirects each copy of the settings document gains. */
export function planSegmentMigration(input: {
  documents: readonly LanguageCopy[];
  /** Every document with a URI, of any type: a move must not land on one. */
  holders: readonly LanguageCopy[];
  /** Every copy of the settings document: a draft published later must not drop the new redirects. */
  settings: readonly SettingsCopy[];
  settingsId: string;
  defaultLocale: string;
  releases?: readonly Release[];
}): SegmentPlan {
  const releases = input.releases ?? [];
  const planned = planSegmentChanges(input.documents, input.defaultLocale);
  const locked: Finding[] = [];
  const changes = planned.changes.filter(({ id }) => {
    const reason = releaseLock(id, releases);

    if (reason) {
      locked.push({ id, reason });
    }

    return !reason;
  });

  const published = input.settings.find(({ _id }) => _id === input.settingsId);
  const existing = published?.redirects ?? [];
  const collisions = findTargetCollisions(changes, input.holders, existing);
  const redirects = planRedirects(changes, existing, liveAfter(changes, input.holders));
  const settings: SettingsPatch[] = [];
  const manual: ExistingRedirect[] = [];

  for (const copy of input.settings) {
    if (publishedIdOf(copy._id) !== input.settingsId) {
      continue;
    }

    const reason = releaseLock(copy._id, releases);

    if (reason) {
      locked.push({ id: copy._id, reason });
      continue;
    }

    const own = copy.redirects ?? [];
    const froms = new Set(own.flatMap(({ from }) => (from ? [pathKey(from)] : [])));
    const add = redirects.filter(({ from }) => !froms.has(pathKey(from)));
    const retargets = planRedirectRetargets(changes, own);

    if (copy._id === input.settingsId) {
      manual.push(...retargets.manual);
    }

    if (add.length + retargets.retarget.length > 0) {
      settings.push({ id: copy._id, rev: copy._rev, add, retarget: retargets.retarget });
    }
  }

  return { changes, unplaced: planned.unplaced, collisions, locked, redirects, settings, manual };
}
