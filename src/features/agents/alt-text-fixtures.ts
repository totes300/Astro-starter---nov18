// Shared by the alt text tests: an image asset and a Content Lake whose Transform answers in the language asked for.

import type { RequestHandler } from "@sanity/client";
import { getLocaleTitle, LOCALE_IDS, type Locale } from "~/sanity/i18n";
import { agentActionOf } from "~/sanity/test-support/agent-actions";
import { createFakeContentLake } from "~/sanity/test-support/fake-content-lake";
import type { StoredAltText } from "./alt-text";

export const ASSET_ID = "image-abc123-10x10-jpg";

export function imageAsset(_id = ASSET_ID, altText?: StoredAltText) {
  return {
    _id,
    _type: "sanity.imageAsset",
    url: `https://cdn.sanity.io/images/p/d/${_id}.jpg`,
    extension: "jpg",
    originalFilename: "bicycle.jpg",
    ...(altText === undefined ? {} : { altText }),
  };
}

/** A lake whose Transform answers in the language it was asked for, after `takes` ms on the test clock. */
export function describingLake(assets: ReturnType<typeof imageAsset>[], takes = 0) {
  const lake = createFakeContentLake({ documents: assets });
  const inner = lake.client.config().requestHandler as RequestHandler;
  const clock = { now: 0 };
  const calls: { locale: Locale | undefined; asset: StoredAltText; timeout: unknown }[] = [];
  const transform: RequestHandler = async (request, next) => {
    if (agentActionOf(request.url) !== "transform") {
      return inner(request, next);
    }

    const title = (request.body as { instructionParams: { language: { value: string } } }).instructionParams.language.value;
    const locale = LOCALE_IDS.find((id) => getLocaleTitle(id) === title);

    calls.push({ locale, asset: lake.get(ASSET_ID)?.altText as StoredAltText, timeout: request.timeout });
    clock.now += takes;

    return { altText: `A red bicycle (${locale})` };
  };

  return { lake, clock, calls, client: lake.client.withConfig({ requestHandler: transform }) };
}
