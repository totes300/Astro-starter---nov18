import { defineQuery } from "groq";
import { LocaleField, LocaleFirstOrder, LocaleOrDefaultFilter } from "~/features/i18n/fragment";
import { LinkFn, link } from "~/features/sanity/link/fragment";
import { SANITY_SINGLETON_SITE_ID } from "~/sanity/constants";

export const SiteAnnouncementQ = defineQuery(`${LinkFn}
(*[_type == "${SANITY_SINGLETON_SITE_ID}" && ${LocaleOrDefaultFilter}] | ${LocaleFirstOrder})[0]{
  ${LocaleField},
  announcement{
    "enabled": coalesce(enabled, false),
    "theme": coalesce(theme, "dark"),
    text,
    "link": ${link("appLink")}
  }
}`);
