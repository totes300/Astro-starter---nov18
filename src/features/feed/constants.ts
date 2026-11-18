import { DEFAULT_LOCALE } from "~/sanity/i18n";

export const FEED_PATH = "/feed.xml";

export const FEED_MIME = "application/rss+xml";

/** One feed, in the default language: a prefixed `/feed.xml` is a 404, so no other language's page advertises one. */
export const FEED_LANGUAGE = DEFAULT_LOCALE;

/** Readers only poll the head of a feed, so the archive past this stays on the blog index. */
export const FEED_ITEM_LIMIT = 50;

/** Whether a page in `locale` links the feed: only the default language's pages do, since the feed is theirs. */
export function hasFeed(locale: string | null | undefined): boolean {
  return (locale ?? DEFAULT_LOCALE) === FEED_LANGUAGE;
}
