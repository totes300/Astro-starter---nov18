// Server-side bookkeeping for "Translate with AI": leases, the daily AI request ledger alt text counts in too, and the
// paid result kept until it is written. Dotted documents, so only token reads see them; the caller passes the client.

import type { SanityClient } from "@sanity/client";
import { defineQuery } from "groq";
import { FUNCTION_CAP_MS } from "~/lib/function-cap";
import { readTranslationSettings } from "~/sanity/ai-translation/style-guide";
import {
  AI_TRANSLATION_LEASE_TYPE,
  AI_TRANSLATION_LEDGER_TYPE,
  AI_TRANSLATION_RESULT_TYPE,
  aiTranslationDocumentId,
  SANITY_SINGLETON_SITE_SETTINGS_ID,
} from "~/sanity/constants";
import { fetchSanity } from "../../sanity/lib/fetch";

export const AiTranslationLeaseQuery = defineQuery(
  `*[_type == "${AI_TRANSLATION_LEASE_TYPE}" && _id == $id][0]{ _id, _rev, token, expiresAt, owner }`
);

export const AiTranslationLedgerQuery = defineQuery(
  `*[_type == "${AI_TRANSLATION_LEDGER_TYPE}" && _id == $id][0]{ _id, _rev, day, count }`
);

export const AiTranslationResultQuery = defineQuery(
  `*[_type == "${AI_TRANSLATION_RESULT_TYPE}" && _id == $id][0]{ _id, sourceId, language, savedAt, meta, result }`
);

export const AiTranslationSavedResultsQuery = defineQuery(
  `*[_type == "${AI_TRANSLATION_RESULT_TYPE}"] | order(savedAt desc){ _id, sourceId, language, savedAt, meta }`
);

export const AiCreditLimitQuery = defineQuery(
  `*[_type == "${SANITY_SINGLETON_SITE_SETTINGS_ID}" && _id == "${SANITY_SINGLETON_SITE_SETTINGS_ID}"][0].translations.defaults.maxCreditsPerDay`
);

/** No request outlives the function cap; the 30 s on top cover clock drift between instances. */
export const AI_TRANSLATION_LEASE_TTL_MS = FUNCTION_CAP_MS + 30_000;

/** One ledger for the project: it keeps today's UTC count and resets itself when the day changes, so none pile up. */
export const AI_TRANSLATION_LEDGER_ID = AI_TRANSLATION_LEDGER_TYPE;

/** A reservation that loses a race re-reads and tries again; past this, the ledger is too contended to trust. */
const LEDGER_ATTEMPTS = 8;

type Stored = { _id: string; _rev: string };

type StoredLease = Stored & { token?: string; expiresAt?: string; owner?: string };

type StoredLedger = Stored & { day?: string; count?: number };

/** Sanity answers 409 to a create on an existing id and to a stale `ifRevisionId`. */
export function isConflict(error: unknown): boolean {
  return (error as { statusCode?: unknown } | null)?.statusCode === 409;
}

/** The UTC day a ledger counts, `YYYY-MM-DD`. */
export function ledgerDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The ledger's count for `day`: a count left from an earlier day is that day's, not this one's. */
function countOn(ledger: StoredLedger | null, day: string): number {
  return ledger?.day === day ? (ledger.count ?? 0) : 0;
}

export type Pair = { sourceId: string; language: string };

export type Lease = Pair & { id: string; token: string; rev: string; expiresAt: string };

export type LeaseClaim = { acquired: true; lease: Lease } | { acquired: false; expiresAt: string | null };

function isLive(expiresAt: string | undefined, now: Date): boolean {
  const time = Date.parse(expiresAt ?? "");

  // An unreadable expiry never holds a pair forever.
  return Number.isFinite(time) && time > now.getTime();
}

/** Claims the pair before anything is spent; a live claim answers `busy` for free, unless it carries this `owner`. */
export async function acquireLease(
  client: SanityClient,
  {
    sourceId,
    language,
    ttlMs = AI_TRANSLATION_LEASE_TTL_MS,
    now = new Date(),
    owner,
  }: Pair & {
    ttlMs?: number;
    now?: Date;
    /** Whoever may take a live lease back: a key only one request can hold at a time, such as a leased pair. */
    owner?: string;
  }
): Promise<LeaseClaim> {
  const id = aiTranslationDocumentId(AI_TRANSLATION_LEASE_TYPE, sourceId, language);
  const token = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const fields = { sourceId, language, token, acquiredAt: now.toISOString(), expiresAt, ...(owner ? { owner } : {}) };
  const claimed = (rev: string): LeaseClaim => ({ acquired: true, lease: { id, sourceId, language, token, rev, expiresAt } });

  try {
    const created = await client.create({ _id: id, _type: AI_TRANSLATION_LEASE_TYPE, ...fields });

    return claimed(created._rev);
  } catch (error) {
    if (!isConflict(error)) {
      throw error;
    }
  }

  const held = await fetchSanity<StoredLease | null>(client, AiTranslationLeaseQuery, { id });

  if (held && isLive(held.expiresAt, now) && !(owner && held.owner === owner)) {
    return { acquired: false, expiresAt: held.expiresAt ?? null };
  }

  try {
    const taken = held
      ? await client.patch(id).ifRevisionId(held._rev).set(fields).commit()
      : await client.create({ _id: id, _type: AI_TRANSLATION_LEASE_TYPE, ...fields });

    return claimed(taken._rev);
  } catch (error) {
    if (isConflict(error)) {
      return { acquired: false, expiresAt: null };
    }

    throw error;
  }
}

/** Deletes the lease only while it is still this one: a lease taken over after expiry belongs to someone else. */
export async function releaseLease(client: SanityClient, lease: Lease): Promise<boolean> {
  try {
    await client
      .transaction()
      .patch(lease.id, (patch) => patch.ifRevisionId(lease.rev).set({ releasedAt: new Date().toISOString() }))
      .delete(lease.id)
      .commit();

    return true;
  } catch (error) {
    // Gone or taken over: either way it is no longer this request's to delete.
    if (isConflict(error) || (error as { statusCode?: unknown } | null)?.statusCode === 404) {
      return false;
    }

    throw error;
  }
}

export type CreditReservation =
  | { reserved: true; day: string; used: number; max: number }
  | { reserved: false; reason: "daily_cap"; day: string; used: number; max: number };

/** Counts a call before it is made, never after: a timeout may still bill, so nothing waits on the outcome. */
export async function reserveCredit(
  client: SanityClient,
  { maxCreditsPerDay, now = new Date() }: { maxCreditsPerDay: number; now?: Date }
): Promise<CreditReservation> {
  const day = ledgerDay(now);
  const id = AI_TRANSLATION_LEDGER_ID;
  const max = Math.max(0, Math.floor(maxCreditsPerDay));

  for (let attempt = 0; attempt < LEDGER_ATTEMPTS; attempt++) {
    const ledger = await fetchSanity<StoredLedger | null>(client, AiTranslationLedgerQuery, { id });
    const used = countOn(ledger, day);

    if (used >= max) {
      return { reserved: false, reason: "daily_cap", day, used, max };
    }

    const fields = { day, count: used + 1, updatedAt: now.toISOString() };

    try {
      if (ledger) {
        await client.patch(id).ifRevisionId(ledger._rev).set(fields).commit();
      } else {
        await client.create({ _id: id, _type: AI_TRANSLATION_LEDGER_TYPE, ...fields });
      }

      return { reserved: true, day, used: used + 1, max };
    } catch (error) {
      if (!isConflict(error)) {
        throw error;
      }
    }
  }

  throw new Error("[ai-ledger] The daily AI request ledger kept changing; try again in a moment.");
}

/** Gives a request back for a call Sanity refused before any work (a rate limit, a bad request), never below zero. */
export async function refundCredit(client: SanityClient, { day }: { day: string }): Promise<number> {
  const id = AI_TRANSLATION_LEDGER_ID;

  for (let attempt = 0; attempt < LEDGER_ATTEMPTS; attempt++) {
    const ledger = await fetchSanity<StoredLedger | null>(client, AiTranslationLedgerQuery, { id });
    const used = countOn(ledger, day);

    // Nothing to give back: no ledger, a zero count, or a later day already reset the reservation away.
    if (!ledger || used <= 0) {
      return 0;
    }

    try {
      await client
        .patch(id)
        .ifRevisionId(ledger._rev)
        .set({ count: used - 1, updatedAt: new Date().toISOString() })
        .commit();

      return used - 1;
    } catch (error) {
      if (!isConflict(error)) {
        throw error;
      }
    }
  }

  throw new Error("[ai-ledger] The daily AI request ledger kept changing; try again in a moment.");
}

/** Settings > Translations' daily limit, as published, for a caller that reads no other translation setting. */
export async function readDailyCreditLimit(client: SanityClient): Promise<number> {
  const value = await fetchSanity<unknown>(client, AiCreditLimitQuery);

  return readTranslationSettings({ defaults: { maxCreditsPerDay: value } }).defaults.maxCreditsPerDay;
}

/** "AI requests today: N of M", for the plan. */
export async function readCreditsToday(
  client: SanityClient,
  { maxCreditsPerDay, now = new Date() }: { maxCreditsPerDay: number; now?: Date }
): Promise<{ day: string; used: number; max: number }> {
  const day = ledgerDay(now);
  const ledger = await fetchSanity<StoredLedger | null>(client, AiTranslationLedgerQuery, { id: AI_TRANSLATION_LEDGER_ID });

  return { day, used: countOn(ledger, day), max: Math.max(0, Math.floor(maxCreditsPerDay)) };
}

/** Plain values only: the meta sits on the document as it is, where a `_ref` would become a real reference. */
export type SavedResultMeta = Record<string, string | number | boolean | null>;

export type SavedResult<T> = Pair & { id: string; savedAt: string; meta: SavedResultMeta; result: T };

type StoredResult = {
  _id: string;
  sourceId?: string;
  language?: string;
  savedAt?: string;
  meta?: SavedResultMeta;
  result?: string;
};

/** Written right after a paid call, before anything else can fail. JSON text, so its references and keys stay inert. */
export async function saveResult(
  client: SanityClient,
  { sourceId, language, result, meta = {}, now = new Date() }: Pair & { result: unknown; meta?: SavedResultMeta; now?: Date }
): Promise<string> {
  const id = aiTranslationDocumentId(AI_TRANSLATION_RESULT_TYPE, sourceId, language);

  await client.createOrReplace({
    _id: id,
    _type: AI_TRANSLATION_RESULT_TYPE,
    sourceId,
    language,
    savedAt: now.toISOString(),
    meta,
    result: JSON.stringify(result),
  });

  return id;
}

export async function readResult<T = unknown>(
  client: SanityClient,
  { sourceId, language }: Pair
): Promise<SavedResult<T> | null> {
  const id = aiTranslationDocumentId(AI_TRANSLATION_RESULT_TYPE, sourceId, language);
  const stored = await fetchSanity<StoredResult | null>(client, AiTranslationResultQuery, { id });

  if (!stored || typeof stored.result !== "string") {
    return null;
  }

  try {
    return {
      id,
      sourceId,
      language,
      savedAt: stored.savedAt ?? "",
      meta: stored.meta ?? {},
      result: JSON.parse(stored.result) as T,
    };
  } catch {
    return null;
  }
}

/** Every pair with a paid result not yet written, newest first, for "Apply saved result (free)". */
export async function listSavedResults(
  client: SanityClient
): Promise<(Pair & { id: string; savedAt: string; meta: SavedResultMeta })[]> {
  const stored = await fetchSanity<StoredResult[] | null>(client, AiTranslationSavedResultsQuery);

  return (stored ?? []).flatMap((entry) =>
    typeof entry.sourceId === "string" && typeof entry.language === "string"
      ? [
          {
            id: entry._id,
            sourceId: entry.sourceId,
            language: entry.language,
            savedAt: entry.savedAt ?? "",
            meta: entry.meta ?? {},
          },
        ]
      : []
  );
}

export async function deleteResult(client: SanityClient, { sourceId, language }: Pair): Promise<void> {
  await client.delete(aiTranslationDocumentId(AI_TRANSLATION_RESULT_TYPE, sourceId, language));
}
