import type { SanityClient } from "@sanity/client";
import { AGENT_SCRATCH_DOCUMENTS, SANITY_AGENT_SCHEMA_ID } from "~/sanity/constants";
import { DEFAULT_LOCALE, getLocaleTitle, IS_I18N_ENABLED, LOCALE_IDS, type Locale } from "~/sanity/i18n";
import type { AltTextAssetQueryResult } from "~/sanity/types";
import { fetchSanity } from "../../sanity/lib/fetch";
import { agentCallBudget, createAgentClient } from "./agent-client";
import { AltTextAssetQuery } from "./query";

/** The scratch document and field the description is generated into. See the `imageAltText` schema. */
const SOURCE_DOCUMENT_ID = AGENT_SCRATCH_DOCUMENTS.imageAltText;
const SOURCE_DOCUMENT_TYPE = AGENT_SCRATCH_DOCUMENTS.imageAltText;
const TARGET_PATH = "altText";

/** Catches a runaway response: screen readers announce alt text unpunctuated, so a pasted paragraph is worse than a short line. */
export const MAX_ALT_TEXT_LENGTH = 125;

/** Extensions the pipeline cannot rasterize: an SVG is served verbatim, so the model would get markup. */
const UNDESCRIBABLE_EXTENSIONS = new Set(["svg"]);

const ALT_TEXT_INSTRUCTION = `Write the alternative text for this image, in $language. It will be announced by a screen reader in place of the image, on a company website.

Carry the same information the image carries, and nothing else.

RULES
- One line, sentence case, no trailing period. Output only the alt text: no quotes, no label, no explanation.
- Aim for 5 to 15 words. Never exceed ${MAX_ALT_TEXT_LENGTH} characters.
- Lead with the subject. Never open with "Image of", "Photo of", "Picture of", "This image shows", or the file name.
- Name what is visible and what matters: the subject, what it is doing, and only the details that change the meaning.
- When legible text carries the meaning (a headline, a certificate, a UI label), quote that text instead of describing how it looks.
- For a screenshot or interface, say which interface it is and what state it is in.
- Leave out decoration: colour palettes, lighting, mood, composition, camera angle, and any adjective that adds no information.
- No marketing language, no interpretation, no guessing at brands, people, or dates that are not legible in the image.

The original file name is $filename. Use it only to disambiguate what you already see; never quote it and never trust it over the image.

Editor guidance, which overrides the stylistic rules above unless it is "(none)": $guidance`;

/** Openers that restate the medium. The instruction forbids them; this is the safety net. */
const REDUNDANT_OPENERS = [
  /^(?:an?\s+)?(?:image|photo|photograph|picture)\s+(?:of|showing|depicting)\s+/i,
  /^(?:this|the)\s+(?:image|photo|photograph|picture)\s+(?:shows|depicts|displays|features|is)\s+/i,
];

/** Only a matched pair around the whole line: stripping quotes anywhere would eat a description that quotes legible text. */
const QUOTE_PAIRS = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["`", "`"],
] as const;

function stripWrappingQuotes(value: string) {
  for (const [open, close] of QUOTE_PAIRS) {
    if (value.length >= open.length + close.length && value.startsWith(open) && value.endsWith(close)) {
      return value.slice(open.length, -close.length).trim();
    }
  }

  return value;
}

export type DescribableAsset = {
  _id: string;
  url?: string;
  extension?: string;
  filename?: string;
};

/** A plain string before the media library stored one arm per language, an object after; typegen only knows the string. */
export type StoredAltText = string | Record<string, unknown> | null | undefined;

export type AltTextArms = Partial<Record<Locale, string>>;

/** A legacy plain string is the default language's arm; an empty string is a deliberate value, so it counts as present. */
export function altTextArms(value: StoredAltText): AltTextArms {
  if (typeof value === "string") {
    return { [DEFAULT_LOCALE]: value };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const arms: AltTextArms = {};

  for (const locale of LOCALE_IDS) {
    const arm = value[locale];

    if (typeof arm === "string") {
      arms[locale] = arm;
    }
  }

  return arms;
}

/** What generation still owes: every language for a new asset, the new one after a language is added, none once complete. */
export function missingAltTextLocales(value: StoredAltText): Locale[] {
  const arms = altTextArms(value);

  return LOCALE_IDS.filter((locale) => arms[locale] === undefined);
}

/** Kept back from the function cap after a description, for its save and the answer. */
export const DESCRIBE_RESERVE_MS = 15_000;

/** No description starts with less time than this: one cut off by its timeout may still be billed. */
export const MIN_DESCRIBE_MS = 15_000;

/** A description's timeout at `now`; 0 when too little is left before `deadline`. */
export function describeTimeout(deadline: number, now: number): number {
  const budget = agentCallBudget(deadline, DESCRIBE_RESERVE_MS, now);

  return budget >= MIN_DESCRIBE_MS ? budget : 0;
}

/** `deadline`: when the request must have answered, its arrival plus `FUNCTION_CAP_MS`. */
export type DescribeLimits = { deadline: number; now?: () => number; signal?: AbortSignal };

/** A description that never started: too little time left, or a daily AI request limit, with the reason it gave. */
export type DescribeStop = { stop: "out_of_time" } | { stop: "daily_cap"; reason: string };

/** One description's billed Transform, made with the client it is handed (its timeout is the time left). */
type DescribeCall = (agent: SanityClient) => Promise<string>;

/** How a description is paid for: Translate with AI's daily ledger (`ledgerCredit`), or `directCredit`. */
export type DescribeCredit = (
  call: DescribeCall,
  context: { agentClient: SanityClient; label: string; budget: () => number }
) => Promise<string | DescribeStop>;

/** No ledger: one call with the time left, none below the minimum; a failed language stays missing for the next run. */
export const directCredit: DescribeCredit = async (call, { agentClient, label, budget }) => {
  const timeout = budget();

  if (timeout < MIN_DESCRIBE_MS) {
    return { stop: "out_of_time" };
  }

  return call(agentClient.withConfig({ timeout })).catch((error: unknown) => {
    console.error(`[alt-text] ${label}:`, error);

    return "";
  });
};

export type DescribeRun = {
  /** Saved on the asset, each before the next description started. */
  written: AltTextArms;
  described: number;
  /** The deadline, an abort or the daily credit limit ended the run before every language was tried. */
  stopped: boolean;
  /** The reason the day's AI request limit gave, when it ended the run. */
  capped?: string;
};

/** Saves each language before describing the next, so a run cut short keeps what it paid for. */
export async function describeLanguages(
  locales: readonly Locale[],
  steps: {
    describe: (locale: Locale) => Promise<string | DescribeStop>;
    save: (locale: Locale, text: string) => Promise<boolean>;
  },
  { deadline, now = Date.now, signal }: DescribeLimits
): Promise<DescribeRun> {
  const written: AltTextArms = {};
  let described = 0;

  for (const locale of locales) {
    if (signal?.aborted || describeTimeout(deadline, now()) === 0) {
      return { written, described, stopped: true };
    }

    const text = await steps.describe(locale);

    if (typeof text !== "string") {
      return { written, described, stopped: true, ...(text.stop === "daily_cap" ? { capped: text.reason } : {}) };
    }

    if (!text) {
      continue;
    }

    described += 1;

    if (await steps.save(locale, text)) {
      written[locale] = text;
    }
  }

  return { written, described, stopped: false };
}

/** The described arms `stored` still lacks: text an editor wrote while the descriptions ran wins over them. */
export function unclaimedArms(stored: StoredAltText, described: AltTextArms): AltTextArms {
  const missing = missingAltTextLocales(stored);

  return Object.fromEntries(Object.entries(described).filter(([locale]) => missing.some((id) => id === locale)));
}

export type AltTextPatch = { operation: "set" | "setIfMissing"; fields: Record<string, unknown> };

/** Only the described arms of a stored object, so another language survives; unforced, it only fills what is still empty. */
export function altTextPatch(stored: StoredAltText, described: AltTextArms, force = false): AltTextPatch {
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const fields = Object.fromEntries(Object.entries(described).map(([locale, text]) => [`altText['${locale}']`, text]));

    return { operation: force ? "set" : "setIfMissing", fields };
  }

  // One language keeps the plain string the media library writes then; a legacy string becomes the default arm.
  const altText = IS_I18N_ENABLED ? { ...altTextArms(stored), ...described } : described[DEFAULT_LOCALE];

  // A value already there (a legacy string) can only be replaced; an empty field is filled only if it still is.
  return { operation: force || (stored !== null && stored !== undefined) ? "set" : "setIfMissing", fields: { altText } };
}

/** The write for a finished run, built on the asset as it is now; null when editors filled every language meanwhile. */
export function altTextWrite(
  current: StoredAltText,
  described: AltTextArms,
  force: boolean
): { owed: AltTextArms; patch: AltTextPatch } | null {
  const owed = force ? described : unclaimedArms(current, described);

  return Object.keys(owed).length > 0 ? { owed, patch: altTextPatch(current, owed, force) } : null;
}

/** Capped before the pattern runs; Sanity's own ids are well under it. */
const MAX_ASSET_ID_LENGTH = 200;

const IMAGE_ASSET_ID = /^image-[A-Za-z0-9_]+-\d+x\d+-[a-z0-9]+$/;

/** A Sanity image asset id (`image-<hash>-<w>x<h>-<ext>`), the only id a caller may hand the route to read and patch. */
export function isImageAssetId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ASSET_ID_LENGTH && IMAGE_ASSET_ID.test(value);
}

/** Assets the pipeline can hand to the vision model as a raster image. */
export function isDescribableAsset(asset: Pick<DescribableAsset, "url" | "extension">) {
  if (!asset.url?.startsWith("https://")) {
    return false;
  }

  return !UNDESCRIBABLE_EXTENSIONS.has((asset.extension ?? "").toLowerCase());
}

/** Capped at 1024px and re-encoded to JPEG, so a 3840px PNG does not travel to the model at full weight. */
export function buildDescriptionSourceUrl(assetUrl: string): `https://${string}` {
  const url = new URL(assetUrl);

  url.searchParams.set("w", "1024");
  url.searchParams.set("fit", "max");
  url.searchParams.set("fm", "jpg");
  url.searchParams.set("q", "80");

  return url.toString() as `https://${string}`;
}

/** Cut to the last word boundary rather than mid-word, dropping any punctuation left dangling. */
function truncateAtWord(value: string, max: number) {
  if (value.length <= max) {
    return value;
  }

  const clipped = value.slice(0, max);
  const lastSpace = clipped.lastIndexOf(" ");
  const cut = lastSpace > max * 0.6 ? clipped.slice(0, lastSpace) : clipped;

  return cut.trimEnd().replace(/[,;:.]+$/, "");
}

/** Models add a preamble, quote the answer, or restate the medium; none of that should be announced. */
export function normalizeAltText(raw: string) {
  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) {
    return "";
  }

  let value = stripWrappingQuotes(firstLine);

  for (const opener of REDUNDANT_OPENERS) {
    value = value.replace(opener, "");
  }

  value = value.replace(/\s+/g, " ").trim().replace(/[.]+$/, "");

  if (!value) {
    return "";
  }

  return truncateAtWord(value.charAt(0).toUpperCase() + value.slice(1), MAX_ALT_TEXT_LENGTH);
}

/** The document Transform runs against: created free, before a credit is reserved for the call. */
async function ensureScratchDocument(client: SanityClient) {
  await client.createIfNotExists({ _id: SOURCE_DOCUMENT_ID, _type: SOURCE_DOCUMENT_TYPE });
}

/** One billed Transform with `noWrite` on the scratch document; `agent` is the client a `DescribeCredit` hands. */
export async function generateAltText(
  agent: SanityClient,
  props: { imageUrl: `https://${string}`; filename?: string; guidance?: string; locale?: string }
) {
  const { imageUrl, filename, guidance, locale } = props;
  const result = await agent.agent.action.transform({
    schemaId: SANITY_AGENT_SCHEMA_ID,
    documentId: SOURCE_DOCUMENT_ID,
    noWrite: true,
    instruction: "Describe the target image. Follow the target's own instruction exactly.",
    instructionParams: {
      filename: { type: "constant", value: filename || "(unknown)" },
      guidance: { type: "constant", value: guidance || "(none)" },
      // The language's own name steers the model more reliably than its code.
      language: { type: "constant", value: getLocaleTitle(locale ?? DEFAULT_LOCALE) },
    },
    target: {
      path: [TARGET_PATH],
      operation: { type: "image-description", imageUrl },
      instruction: ALT_TEXT_INSTRUCTION,
    },
    temperature: 0.2,
  });

  const described = (result as Record<string, unknown> | undefined)?.[TARGET_PATH];

  return typeof described === "string" ? normalizeAltText(described) : "";
}

export type AltTextResult = {
  _id: string;
  /** `partial`: stopped early; the languages described are saved, the rest wait for the next run. */
  status: "described" | "partial" | "skipped" | "failed";
  altText?: string;
  reason?: string;
  /** `daily_cap`: the day's AI request limit stopped it, so nothing more is described today. */
  code?: "daily_cap";
};

const STOPPED_OUTCOME = {
  status: "partial",
  reason: "Stopped before every language was described; the rest are left for the next run.",
} as const;

/** What a run comes to, given the languages it still owes once it is over. */
export function altTextOutcome(run: DescribeRun, owed: readonly Locale[]): Pick<AltTextResult, "status" | "reason" | "code"> {
  if (run.described === 0) {
    if (run.capped) {
      return { status: "failed", reason: run.capped, code: "daily_cap" };
    }

    return run.stopped ? STOPPED_OUTCOME : { status: "failed", reason: "Sanity AI could not describe this image." };
  }

  if (owed.length === 0) {
    return Object.keys(run.written).length > 0
      ? { status: "described" }
      : { status: "skipped", reason: "Alt text was added while this image was being described." };
  }

  if (run.capped) {
    return { status: "partial", reason: run.capped, code: "daily_cap" };
  }

  return run.stopped ? STOPPED_OUTCOME : { status: "failed", reason: "Some languages are still missing alt text." };
}

export type DescribeAssetOptions = DescribeLimits & {
  guidance: string;
  force: boolean;
  /** How each description is paid for; `directCredit` when left out. */
  credit?: DescribeCredit;
};

/** Describes every language the asset lacks (all of them when forced): alt text lives on the asset. Only the first read throws. */
export async function describeAsset(
  client: SanityClient,
  assetId: string,
  options: DescribeAssetOptions
): Promise<AltTextResult> {
  const { guidance, force, credit = directCredit, ...limits } = options;
  const readAsset = () => fetchSanity<AltTextAssetQueryResult>(client, AltTextAssetQuery, { assetId });
  const asset = await readAsset();

  if (!asset?.url) {
    return { _id: assetId, status: "skipped", reason: "Asset not found." };
  }

  // Re-checked here: two Studio tabs can observe one upload, and an editor's own correction must survive.
  const locales = force ? [...LOCALE_IDS] : missingAltTextLocales(asset.altText);

  if (locales.length === 0) {
    const reason = IS_I18N_ENABLED ? "Already has alt text in every language." : "Already has alt text.";

    return { _id: assetId, status: "skipped", reason };
  }

  if (!isDescribableAsset(asset)) {
    return { _id: assetId, status: "skipped", reason: `Cannot describe a ${asset.extension ?? "non-raster"} asset.` };
  }

  const imageUrl = buildDescriptionSourceUrl(asset.url);
  const filename = asset.filename ?? undefined;
  const agentClient = createAgentClient(client);
  const now = limits.now ?? Date.now;
  let lastRead: StoredAltText = asset.altText;
  let isGone = false;

  const describe = (locale: Locale) =>
    credit((agent) => generateAltText(agent, { imageUrl, filename, guidance, locale }), {
      agentClient,
      label: `alt text ${assetId} -> ${locale}`,
      budget: () => agentCallBudget(limits.deadline, DESCRIBE_RESERVE_MS, now()),
    });

  try {
    await ensureScratchDocument(client);

    const run = await describeLanguages(
      locales,
      {
        describe,
        // A fresh read per save: a description takes seconds, and text an editor wrote meanwhile wins.
        save: async (locale, text) => {
          const current = await readAsset();

          if (!current) {
            isGone = true;
            return false;
          }

          lastRead = current.altText;

          const write = altTextWrite(current.altText, { [locale]: text }, force);

          if (!write) {
            return false;
          }

          await client.patch(assetId)[write.patch.operation](write.patch.fields).commit();

          return true;
        },
      },
      limits
    );

    if (isGone) {
      return { _id: assetId, status: "skipped", reason: "Asset not found." };
    }

    const missingNow = missingAltTextLocales(lastRead);
    const owed = locales.filter((locale) => run.written[locale] === undefined && missingNow.includes(locale));
    const altText = run.written[DEFAULT_LOCALE] ?? Object.values(run.written)[0];

    return { _id: assetId, ...altTextOutcome(run, owed), ...(altText ? { altText } : {}) };
  } catch (error) {
    console.error(error);
    return { _id: assetId, status: "failed", reason: "The alt text could not be saved." };
  }
}

export type AltTextBatch = { results: AltTextResult[]; described: number; remaining: number };

/** One batch of the backlog, ended early by the deadline, an abort or the daily limit; the panel loops on `remaining`. */
export async function describeBacklog(
  client: SanityClient,
  backlog: readonly { _id: string }[],
  { limit, ...options }: DescribeAssetOptions & { limit: number }
): Promise<AltTextBatch> {
  const now = options.now ?? Date.now;
  const results: AltTextResult[] = [];

  for (const asset of backlog.slice(0, limit)) {
    if (options.signal?.aborted || describeTimeout(options.deadline, now()) === 0) {
      break;
    }

    const result = await describeAsset(client, asset._id, options);

    results.push(result);

    if (result.status === "partial" || result.code === "daily_cap") {
      break;
    }
  }

  return {
    results,
    // A partial image counts, so the panel keeps looping while batches make progress.
    described: results.filter((result) => result.altText !== undefined).length,
    remaining: Math.max(backlog.length - results.filter((result) => result.status === "described").length, 0),
  };
}
