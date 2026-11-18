import { localized } from "~/features/i18n/fragment";
import { localizedRichText } from "~/features/rich-text/fragment";
import { link } from "~/features/sanity/link/fragment";
import { image } from "~/features/sanity/media/fragment";

/**
 * Everything `AuthorProfile.astro` draws, shared by the panel and the author's own page. Callers
 * interpolate `RichTextFunctions`, which carries the link and image functions this needs. One person serves
 * every language, so the role and bio are read in `$language`, falling back to the default's.
 */
export const AuthorFragment = `
  _id,
  _type,
  name,
  "role": ${localized("role")},
  "uri": coalesce(uri.current, ""),
  "image": ${image("image")},
  "bio": ${localizedRichText("bio")},
  "links": links[]{"key": _key, ...${link("@")}},
`;
