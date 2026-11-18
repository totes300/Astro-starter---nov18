import { defineQuery } from "groq";
import { LocaleField, LocaleFirstOrder, LocaleOrDefaultFilter } from "~/features/i18n/fragment";
import { RichTextFunctions, richText } from "~/features/rich-text/fragment";
import { link } from "~/features/sanity/link/fragment";
import { SANITY_SINGLETON_SITE_ID } from "~/sanity/constants";

export const SiteErrorQ = defineQuery(`${RichTextFunctions}
(*[_type == "${SANITY_SINGLETON_SITE_ID}" && ${LocaleOrDefaultFilter}] | ${LocaleFirstOrder})[0]{
  ${LocaleField},
  notFound{
    "text": ${richText("appRichText")},
    "link": ${link("appLink")},
    "showHeader": coalesce(showHeader, true),
    "showFooter": coalesce(showFooter, true)
  }
}`);
