/** The `lang` for copy read in another language than the page (a singleton falling back to the default), or none. */
export function fallbackLang(
  contentLanguage: string | null | undefined,
  pageLocale: string | null | undefined
): string | undefined {
  return contentLanguage && pageLocale && contentLanguage !== pageLocale ? contentLanguage : undefined;
}
