import { uiStrings } from "~/features/i18n/strings";
import { FEED_LANGUAGE } from "./constants";

/** The channel's name, shared by the feed and the `<link rel="alternate">` that advertises it. */
export function feedTitle(siteName?: string | null, section?: string | null): string {
  return [siteName, section ?? uiStrings(FEED_LANGUAGE).blog.fallbackTitle].filter(Boolean).join(" ");
}
