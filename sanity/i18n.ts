/**
 * The site's locales and the prefix rule that turns one into a URL segment, in `sanity/` so the app, Studio and CLI
 * all read it. A new language also needs its UI dictionary: docs/features/internationalization.md
 */

/** BCP 47 identifiers, because each one is also the URL prefix and the `hreflang` value. The default locale stays first. */
export const LOCALES = [
  { id: "en", title: "English", region: "GB", flag: "🇬🇧" },
  { id: "it", title: "Italiano", region: "IT", flag: "🇮🇹" },
] as const;

export type Locale = (typeof LOCALES)[number]["id"];

/** A bare literal: typegen's evaluator only follows literals, so `satisfies` here breaks every query importing it. */
export const DEFAULT_LOCALE = "en";

export const LOCALE_IDS: readonly Locale[] = LOCALES.map(({ id }) => id);

/** The app's build defines it from LOCALES, so a build drops the branches it guards; scripts and tests have none. */
declare const __I18N_ENABLED__: boolean | undefined;

/** Off with a single locale: no prefixes, no hreflang, no switcher, no browser-language detection. */
export const IS_I18N_ENABLED: boolean = typeof __I18N_ENABLED__ === "boolean" ? __I18N_ENABLED__ : LOCALES.length > 1;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALE_IDS as readonly string[]).includes(value);
}

export function getLocaleTitle(locale: string): string {
  return LOCALES.find(({ id }) => id === locale)?.title ?? locale;
}

/** The Studio's name for a language: its flag beside its native title, so folders, menus and tabs read at a glance. */
export function getStudioLocaleTitle(locale: string): string {
  const entry: { title: string; flag?: string } | undefined = LOCALES.find(({ id }) => id === locale);

  if (!entry) {
    return locale;
  }

  return entry.flag ? `${entry.flag} ${entry.title}` : entry.title;
}

/** The tag `Intl` formats dates and numbers with (`en-GB`); an unknown locale formats as the default. */
export function getIntlLocale(locale: string): string {
  const entry: { id: string; region?: string } = LOCALES.find(({ id }) => id === locale) ?? LOCALES[0];

  return entry.region ? `${entry.id}-${entry.region}` : entry.id;
}

/** Open Graph's `ll_TT` form of `getIntlLocale`. */
export function getOgLocale(locale: string): string {
  return getIntlLocale(locale).replace("-", "_");
}

/** The URL segment a locale owns. The default locale owns none, so its URLs are never prefixed. */
export function localePrefix(locale: string): string {
  return locale === DEFAULT_LOCALE || !isLocale(locale) ? "" : `/${locale}`;
}

/** Builds the full public path for a locale. This is what a document's `uri` stores. */
export function withLocalePrefix(locale: string, pathname: string): string {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const prefix = localePrefix(locale);

  if (!prefix) {
    return path;
  }

  return path === "/" ? prefix : `${prefix}${path}`;
}

export type SplitPath = {
  /** The locale the path belongs to: the prefix when present, otherwise the default. */
  locale: Locale;
  /** The prefix that was actually in the path, or `null` when unprefixed. */
  localeInPath: Locale | null;
  /** The path with the locale segment removed, always leading-slashed. */
  pathname: string;
};

/** `localeInPath` reports the default locale too, which is how `/en/about` is recognised as the redundant form of `/about`. */
export function splitLocalePrefix(pathname: string): SplitPath {
  const segments = pathname.split("/").filter(Boolean);
  const [first, ...rest] = segments;
  const localeInPath = isLocale(first) ? first : null;
  const remaining = localeInPath ? rest : segments;

  return {
    locale: localeInPath ?? (DEFAULT_LOCALE as Locale),
    localeInPath,
    pathname: remaining.length ? `/${remaining.join("/")}` : "/",
  };
}

/** True for a locale's home path: `/` for the default locale, `/it` for the others. */
export function isHomeUri(uri: string): boolean {
  return splitLocalePrefix(uri).pathname === "/";
}

/** Every locale's home path, in locale order. */
export function homeUris(): string[] {
  return LOCALE_IDS.map((locale) => withLocalePrefix(locale, "/"));
}
