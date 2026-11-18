// The search-facing rules the Studio warns on before publish, pure so `seo-rules.test.ts` runs them without a Studio.

export const SEO_TITLE_LENGTH = { min: 10, max: 70 };
export const SEO_DESCRIPTION_LENGTH = { min: 50, max: 160 };

type Length = { min: number; max: number };

/** What search results show: the field's own text, else the fallback the route renders in its place. */
export function effectiveText(own: unknown, fallback: unknown): string {
  for (const value of [own, fallback]) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

export function lengthIssue(text: string, { min, max }: Length, label: string): string | null {
  if (!text) {
    return null;
  }

  if (text.length < min) {
    return `${label} is ${text.length} characters. Search results read best between ${min} and ${max}.`;
  }

  if (text.length > max) {
    return `${label} is ${text.length} characters. Search engines cut it after about ${max}.`;
  }

  return null;
}

/** sanity-plugin-media stores a localized asset field as one string, or as one string per language. */
export function hasAltText(altText: unknown, language: string, defaultLanguage: string): boolean {
  if (typeof altText === "string") {
    return altText.trim() !== "";
  }

  if (altText && typeof altText === "object") {
    const byLanguage = altText as Record<string, unknown>;
    const text = byLanguage[language] ?? byLanguage[defaultLanguage];

    return typeof text === "string" && text.trim() !== "";
  }

  return false;
}

type Contact = { appLink?: { type?: string; external?: string } | null } | null;

/** The Organization JSON-LD lists the contacts that link off the site as its official profiles (`sameAs`). */
export function hasSocialProfile(contacts: unknown): boolean {
  if (!Array.isArray(contacts)) {
    return false;
  }

  return (contacts as Contact[]).some((contact) => contact?.appLink?.type === "external" && Boolean(contact.appLink.external));
}
