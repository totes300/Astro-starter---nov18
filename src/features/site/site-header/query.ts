import { defineQuery } from "groq";
import { LocaleField, LocaleFirstOrder, LocaleOrDefaultFilter } from "~/features/i18n/fragment";
import { LinkFn, link } from "~/features/sanity/link/fragment";
import { SANITY_SINGLETON_SITE_ID } from "~/sanity/constants";

export const SiteHeaderQ = defineQuery(`${LinkFn}
(*[_type == "${SANITY_SINGLETON_SITE_ID}" && ${LocaleOrDefaultFilter}] | ${LocaleFirstOrder})[0]{
  ${LocaleField},
  name,
  header{
    links[]{"key": _key, ...${link("@")}}
  },
  "contacts": contacts[]{"key": _key, name, "link": ${link("appLink")}}
}`);
