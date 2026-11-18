// PLOP: Add Import
import type { PortableTextProps } from "astro-portabletext/types";
import { LinkFn, link } from "~/features/sanity/link/fragment";
import { MediaFunctions, media } from "~/features/sanity/media/fragment";
import { DEFAULT_LOCALE } from "~/sanity/i18n";
import { MediaBlockFragment } from "./blocks/media-block/fragment";

export const RichTextFn = `fn frag::richText($value) = $value[]{
  ...,
  ${MediaBlockFragment},
  // PLOP: Add Export
  markDefs[] {
    ...,
    _type == "linkField" => ${link("@")},
  },
  children[] {
    ...,
    _type == "inlineMediaField" => {
      "media": ${media("media")},
    },
  }
};`;

export const richText = (path: string) => `frag::richText(${path})`;

/** Portable text translated in place, in `$language` else the default's; a pre-translation array (its `[0]` defined) as it is. */
export const localizedRichText = (path: string) =>
  `select(defined(${path}[0]) => frag::richText(${path}), defined(${path}[$language]) => frag::richText(${path}[$language]), frag::richText(${path}.${DEFAULT_LOCALE}))`;

/** Interpolate once at the head of any query calling `richText`. */
export const RichTextFunctions = `${LinkFn}\n${MediaFunctions}\n${RichTextFn}`;

export type RichTextFragmentResult = PortableTextProps["value"];

/** `localizedRichText`'s result: typegen reads `[$language]` as a filter and adds the arms object, but it is always blocks. */
export function localizedBlocks(value: readonly unknown[] | null | undefined): RichTextFragmentResult {
  return (value ?? []).filter(
    (item): item is Extract<RichTextFragmentResult, readonly unknown[]>[number] =>
      typeof (item as { _type?: unknown } | null)?._type === "string"
  );
}

type RichTextBlock = Extract<RichTextFragmentResult, readonly unknown[]>[number];

/** A leading `h4` is the section's eyebrow: lifted out so it can sit in the label column. */
export function splitEyebrow(value: RichTextFragmentResult | null | undefined): {
  eyebrow: RichTextFragmentResult | null;
  body: RichTextFragmentResult | null | undefined;
} {
  const blocks = Array.isArray(value) ? (value as readonly RichTextBlock[]) : null;
  const first = blocks?.[0] as { _type?: string; style?: string } | undefined;

  if (!blocks || first?._type !== "block" || first.style !== "h4") {
    return { eyebrow: null, body: value };
  }

  return { eyebrow: [blocks[0]] as RichTextFragmentResult, body: blocks.slice(1) as RichTextFragmentResult };
}
