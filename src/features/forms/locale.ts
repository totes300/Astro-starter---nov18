import { DEFAULT_LOCALE, isLocale, type Locale } from "~/sanity/i18n";

/** Underscored, so it can never shadow a field a form defines. */
export const LOCALE_FIELD_NAME = "_locale";

/** The page's locale, posted by the form because an endpoint runs outside locale routing; anything else reads as the default. */
export function formLocale(formData: FormData): Locale {
  const locale = formData.get(LOCALE_FIELD_NAME);

  return isLocale(locale) ? locale : DEFAULT_LOCALE;
}
