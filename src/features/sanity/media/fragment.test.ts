import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, parse } from "groq-js";
import { localeParams } from "~/features/i18n/fragment";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS } from "~/sanity/i18n";
import { assetText, image as imageFn, MediaFunctions, media } from "./fragment";

// Typed as a plain string: with one locale, `LOCALE_IDS` narrows to the default's literal.
const SECONDARY: string = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;

const IMAGE_ASSET = { _id: "image-asset", _type: "sanity.imageAsset", metadata: { dimensions: { aspectRatio: 1.5 } } };
const BARE_ASSET = { _id: "bare-asset", _type: "sanity.imageAsset" };
const BEACON = "1;position:fixed;inset:0;background:url(https://evil.example/beacon";

async function aspectRatioOf(value: Record<string, unknown>): Promise<unknown> {
  const query = `${MediaFunctions} *[_id == "doc"][0]{ "media": ${media("media")} }.media.aspectRatio`;
  const dataset = [IMAGE_ASSET, BARE_ASSET, { _id: "doc", _type: "doc", media: value }];

  return (await evaluate(parse(query), { dataset })).get();
}

const image = (aspectRatio: unknown, ref = IMAGE_ASSET._id) => ({ type: "image", image: { asset: { _ref: ref } }, aspectRatio });

test("a positive stored aspect ratio is passed through", async () => {
  assert.equal(await aspectRatioOf(image(16 / 9)), 16 / 9);
  assert.equal(await aspectRatioOf(image(0.5)), 0.5);
});

test("anything but a positive number falls back to the asset's own ratio", async () => {
  for (const stored of [BEACON, "16/9", "2", 0, -1, null, true, { x: 1 }]) {
    assert.equal(await aspectRatioOf(image(stored)), 1.5, String(stored));
  }
});

test("with no asset ratio to fall back to, a hostile value becomes null", async () => {
  for (const stored of [BEACON, "16/9", -1]) {
    assert.equal(await aspectRatioOf(image(stored, BARE_ASSET._id)), null, String(stored));
  }
});

// Parse-time params too, as the read seams bind them: unbound, `[$language]` reads as a filter.
async function altTextOf(altText: unknown, language?: string): Promise<unknown> {
  const query = `${MediaFunctions} *[_id == "doc"][0]{ "image": ${imageFn("image")} }.image.altText`;
  const dataset = [
    { ...IMAGE_ASSET, altText },
    { _id: "doc", _type: "doc", image: { asset: { _ref: IMAGE_ASSET._id } } },
  ];
  const params = localeParams(language ? { language } : {});

  return (await evaluate(parse(query, { params }), { dataset, params })).get();
}

test("localized asset text reads the requested language, then the default, then a plain string", async () => {
  assert.equal(await altTextOf({ [DEFAULT_LOCALE]: "A dog" }), "A dog");
  assert.equal(await altTextOf("A plain dog"), "A plain dog");
  assert.equal(await altTextOf("A plain dog", SECONDARY), "A plain dog");
  assert.equal(await altTextOf({ [DEFAULT_LOCALE]: "A dog" }, SECONDARY), "A dog");
});

test("localized asset text is never an object, so a cleared or empty field renders as no text", async () => {
  for (const stored of [{}, { zz: "Ghost" }, null, undefined, 42]) {
    assert.equal(await altTextOf(stored), null, JSON.stringify(stored));
  }
});

test("localized asset text reads a configured second language in its own words", { skip: !IS_I18N_ENABLED }, async () => {
  assert.equal(await altTextOf({ [DEFAULT_LOCALE]: "A dog", [SECONDARY]: "SECOND" }, SECONDARY), "SECOND");
  assert.equal(await altTextOf({ [DEFAULT_LOCALE]: "A dog", [SECONDARY]: "SECOND" }), "A dog");
});

test("assetText narrows what typegen types as a string or an array to the string", () => {
  assert.equal(assetText("Alt"), "Alt");
  assert.equal(assetText(["Alt"]), "Alt");
  assert.equal(assetText([]), undefined);
  assert.equal(assetText(null), undefined);
  assert.equal(assetText(undefined), undefined);
});
