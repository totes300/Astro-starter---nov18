// Automatic alt text counted in Translate with AI's daily ledger, so "AI requests today" counts both.
// The alt text route passes it to the describers; without it each description is one direct call: docs/features/auto-alt-text.md

import type { SanityClient } from "@sanity/client";
import { readDailyCreditLimit } from "~/features/agents/ai-ledger";
import { type DescribeCredit, MIN_DESCRIBE_MS } from "~/features/agents/alt-text";
import { IS_I18N_ENABLED } from "~/sanity/i18n";
import { spendOneCredit } from "./credit";

export const DAILY_CAP_REASON = "Today's AI request limit from Settings > Translations is reached; it resets at midnight UTC.";

/** Settings > Translations' daily limit; with one language that setting is hidden, so descriptions are counted, never capped. */
export async function altTextDailyLimit(client: SanityClient): Promise<number> {
  return IS_I18N_ENABLED ? readDailyCreditLimit(client) : Number.POSITIVE_INFINITY;
}

/** A credit reserved per description, refunded as a pair's is; the limit is read once, on the first description. */
export function ledgerCredit(client: SanityClient, readLimit = () => altTextDailyLimit(client)): DescribeCredit {
  let limit: Promise<number> | undefined;

  return async (call, { agentClient, label, budget }) => {
    try {
      limit ??= readLimit();

      const spend = await spendOneCredit(
        { client, agentClient },
        { maxCreditsPerDay: await limit, label, budget, minCallMs: MIN_DESCRIBE_MS },
        call
      );

      if (spend.ok) {
        return spend.value;
      }

      if (spend.reason === "daily_cap") {
        return { stop: "daily_cap", reason: DAILY_CAP_REASON };
      }

      return spend.reason === "out_of_time" ? { stop: "out_of_time" } : "";
    } catch (error) {
      console.error("[alt-text] The daily AI request ledger could not be read or written:", error);

      return "";
    }
  };
}
