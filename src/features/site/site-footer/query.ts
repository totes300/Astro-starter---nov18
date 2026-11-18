import { defineQuery } from "groq";
import { LocaleField, LocaleFirstOrder, LocaleOrDefaultFilter } from "~/features/i18n/fragment";
import { LinkFn, link } from "~/features/sanity/link/fragment";
import { SANITY_SINGLETON_SITE_ID } from "~/sanity/constants";

export const SiteFooterQ = defineQuery(`${LinkFn}
(*[_type == "${SANITY_SINGLETON_SITE_ID}" && ${LocaleOrDefaultFilter}] | ${LocaleFirstOrder})[0]{
  ${LocaleField},
  name,
  footer{
    tagline,
    links[]{"key": _key, ...${link("@")}},
    legalLinks[]{"key": _key, ...${link("@")}}
  },
  "contacts": contacts[]{"key": _key, name, "link": ${link("appLink")}}
}`);
