import type { SanityClient } from "@sanity/client";
import { AiTranslationOffQuery } from "~/features/agents/query";
import { TRANSLATE_MESSAGES, type TranslateAction } from "~/sanity/ai-translation/wire";
import { fetchSanity } from "../../../sanity/lib/fetch";
import { provedLabelDrafts } from "./ai-drafts";
import { translateLabels } from "./labels";
import { linkTranslation } from "./link";
import { applySavedResult, discardSavedResult, translatePair } from "./pair";
import { publishTranslations } from "./publish";
import { relinkReferences } from "./relink";
import type { TranslateDeps } from "./shared";
import { responseStatus } from "./status";

type Answer = { status: number; body: unknown };

export const SWITCHED_OFF = { error: TRANSLATE_MESSAGES.off, code: "off" } as const;

/** `0` AI requests a day in Settings > Translations: every action and the plan answer 404, as with one language. */
export async function isSwitchedOff(client: SanityClient): Promise<boolean> {
  return (await fetchSanity<boolean | null>(client, AiTranslationOffQuery)) === true;
}

function answered(result: { status: string; code?: string }): Answer {
  return { status: responseStatus(result), body: result };
}

/** One POST action, the switch read first; a throw before the billed call started is free, and says so. */
export async function answerAction(deps: TranslateDeps, action: TranslateAction): Promise<Answer> {
  let billed = false;
  const tracked: TranslateDeps = {
    ...deps,
    onBilledCall: () => {
      billed = true;
      deps.onBilledCall?.();
    },
  };
  const { client, siteUrl, deadline } = deps;

  try {
    if (await isSwitchedOff(client)) {
      return { status: 404, body: SWITCHED_OFF };
    }

    switch (action.action) {
      case "translate":
        return answered(await translatePair(tracked, action));
      case "apply":
        return answered(await applySavedResult(tracked, action));
      case "labels":
        return answered(await translateLabels(tracked, action));
      case "link":
        return answered(await linkTranslation(tracked, action));
      case "discard":
        return answered(await discardSavedResult(tracked, action));
      case "relink":
        return { status: 200, body: await relinkReferences(client, { publish: action.publish, siteUrl, deadline }) };
      case "publish": {
        const revs = await provedLabelDrafts(client, action.ids, action.revs);

        return { status: 200, body: await publishTranslations(client, action.ids, { revs, deadline }) };
      }
    }
  } catch (error) {
    // Nothing was billed yet: the Studio counts it free and may send it again.
    if (!billed) {
      console.error("[ai-translate] Sanity could not be read or written before the AI call:", error);

      return {
        status: 503,
        body: { error: TRANSLATE_MESSAGES.sanity_unavailable, code: "sanity_unavailable", creditSpent: false },
      };
    }

    console.error("[ai-translate] Sanity could not be read or written after the AI call:", error);

    return {
      status: 500,
      body: {
        error: "Translate with AI failed: Sanity could not be read or written. Try again in a moment.",
        code: "internal_error",
      },
    };
  }
}
