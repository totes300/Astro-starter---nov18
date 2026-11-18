import type { LanguageLink } from "~/features/i18n/language-links";
import { safeHref } from "~/features/sanity/link/safe-href";

export type LanguageMenu = {
  links: LanguageLink[];
  /** What the trigger names: the page's own language, else the first row. */
  current: LanguageLink;
};

/** The switcher's rows. A stored URI is CMS data, so one that fails the href allowlist drops out; `null` below two rows. */
export function languageMenu(links: readonly LanguageLink[]): LanguageMenu | null {
  const safe = links.flatMap((link) => {
    const href = safeHref(link.href);

    return href ? [{ ...link, href }] : [];
  });

  const [first] = safe;

  if (!first || safe.length < 2) {
    return null;
  }

  return { links: safe, current: safe.find((link) => link.isCurrent) ?? first };
}
