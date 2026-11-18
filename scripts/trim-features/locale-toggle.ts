// The LOCALES toggle the comment-out must agree with, for the tests that prove it. A project from before
// i18n has no scripts/sanity-migrations, so it is loaded by a specifier no typecheck resolves.

const TOGGLE = "../sanity-migrations/lib/locales";

export type LocaleToggle = {
  disableLocales(source: string, keep: readonly string[]): { source: string; disabled: string[]; refused: unknown[] };
  enableCommentedLocales(source: string, ids?: readonly string[]): { source: string; enabled: string[] };
  listLocales(source: string): { active: string[]; commented: string[]; defaultLocale?: string } | undefined;
};

export async function loadLocaleToggle(): Promise<LocaleToggle | undefined> {
  try {
    return (await import(TOGGLE)) as LocaleToggle;
  } catch {
    return undefined;
  }
}
