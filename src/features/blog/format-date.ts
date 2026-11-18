import { getIntlLocale } from "~/sanity/i18n";

/** Day, short month and year in the page's locale, so the rendered date never depends on the runtime's own. */
export function formatDate(date: string, locale: string): string {
  // Force local midnight so the day does not shift by timezone.
  const parsed = new Date(`${date}T00:00:00`);

  return Number.isNaN(parsed.getTime())
    ? date
    : parsed.toLocaleDateString(getIntlLocale(locale), { day: "numeric", month: "short", year: "numeric" });
}
