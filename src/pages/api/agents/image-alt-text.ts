import type { APIRoute } from "astro";
import {
  describeAsset,
  describeBacklog,
  isDescribableAsset,
  isImageAssetId,
  missingAltTextLocales,
} from "~/features/agents/alt-text";
import { AltTextAssetsQuery, AltTextSettingsQuery } from "~/features/agents/query";
import { ledgerCredit } from "~/features/agents/translate/alt-text-credit";
import { authorizeStudioRequest } from "~/features/api/auth";
import { apiErrorResponse, internalErrorResponse, privateJson } from "~/features/api/errors";
import { FUNCTION_CAP_MS } from "~/lib/function-cap";
import type { AltTextAssetsQueryResult, AltTextSettingsQueryResult } from "~/sanity/types";
import { sanityEditClient } from "../../../sanity/lib/client";
import { fetchSanity } from "../../../sanity/lib/fetch";

// Studio-triggered alt text generation.
export const prerender = false;

/** Images per request at most; the describe deadline can end a batch sooner, and the panel loops. */
const DEFAULT_BATCH_SIZE = 3;
const MAX_BATCH_SIZE = 8;

async function readSettings() {
  const settings = await fetchSanity<AltTextSettingsQueryResult>(sanityEditClient, AltTextSettingsQuery);

  return {
    enabled: settings?.enabled === true,
    guidance: settings?.guidance?.trim() ?? "",
  };
}

/** Missing in at least one configured language: `{}` or a partial object is outstanding, an empty arm is not. */
function isOutstanding(asset: AltTextAssetsQueryResult[number]) {
  return missingAltTextLocales(asset.altText).length > 0;
}

function clampBatchSize(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_BATCH_SIZE;
  }

  return Math.min(Math.max(Math.floor(value), 1), MAX_BATCH_SIZE);
}

/** Counts for the Studio backfill panel. "Missing" means missing in at least one language. */
export const GET: APIRoute = async ({ request }) => {
  const denied = await authorizeStudioRequest(request);

  if (denied) {
    return denied;
  }

  try {
    const [assets, { enabled }] = await Promise.all([
      fetchSanity<AltTextAssetsQueryResult>(sanityEditClient, AltTextAssetsQuery),
      readSettings(),
    ]);

    return privateJson({ total: assets.length, missing: assets.filter(isOutstanding).length, enabled });
  } catch (error) {
    return internalErrorResponse(error, { error: "Failed to read alt text stats.", code: "internal_error" });
  }
};

/** Two callers: the Studio upload listener posts `{ _id }` and is toggle-gated; `{ backfill: true }` loops a batch and is always allowed. */
export const POST: APIRoute = async ({ request }) => {
  const deadline = Date.now() + FUNCTION_CAP_MS;
  const denied = await authorizeStudioRequest(request);

  if (denied) {
    return denied;
  }

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const force = body.force === true;

    if (body.backfill === true) {
      const [{ guidance }, assets] = await Promise.all([
        readSettings(),
        fetchSanity<AltTextAssetsQueryResult>(sanityEditClient, AltTextAssetsQuery),
      ]);
      const describable = assets.filter((asset) => isDescribableAsset(asset));
      const backlog = force ? describable : describable.filter(isOutstanding);

      // Sequential and abortable: Agent Actions are metered, and the panel's Stop aborts this request mid-batch.
      return privateJson(
        await describeBacklog(sanityEditClient, backlog, {
          limit: clampBatchSize(body.limit),
          guidance,
          force,
          credit: ledgerCredit(sanityEditClient),
          deadline,
          signal: request.signal,
        })
      );
    }

    const assetId = body._id;

    // Shape first, so a malformed id costs no Sanity read and never reaches the patch.
    if (!isImageAssetId(assetId)) {
      return apiErrorResponse(400, { error: "Expected an image asset `_id`, or `backfill: true`.", code: "missing_asset_id" });
    }

    const { enabled, guidance } = await readSettings();

    if (!enabled && !force) {
      return privateJson({ _id: assetId, status: "skipped", reason: "Automatic alt text is off." });
    }

    return privateJson(
      await describeAsset(sanityEditClient, assetId, {
        guidance,
        force,
        credit: ledgerCredit(sanityEditClient),
        deadline,
        signal: request.signal,
      })
    );
  } catch (error) {
    return internalErrorResponse(error, {
      error: "Alt text generation failed: Sanity could not be read. Try again in a moment.",
      code: "internal_error",
    });
  }
};
