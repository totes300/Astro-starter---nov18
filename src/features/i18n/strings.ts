import { italian } from "~/features/i18n/dictionaries/it";
import { DEFAULT_LOCALE } from "~/sanity/i18n";
import { counted, joinList } from "./grammar";

// Every UI string the CMS does not own: `en` here, each other language in `dictionaries/`. Keyed by plain
// string rather than `Locale`, so the dictionary of a language switched off stays dormant until it is back on.

const en = {
  home: "Home",
  notFound: "Not Found",
  languageNav: "Language",

  landmark: {
    primary: "Primary",
    footer: "Footer",
  },

  footer: {
    site: "Site",
    legal: "Legal",
    contact: "Contact",
  },

  control: {
    close: "Close",
    menu: "Menu",
    closeAuthor: "Close author",
    dismissAnnouncement: "Dismiss announcement",
    playVideo: "Play video",
    pauseVideo: "Pause video",
    filterBy: (label: string) => `Filter by ${label}`,
    removeFilter: (label: string) => `Remove filter: ${label}`,
  },

  list: {
    articleCount: counted("en", "article", "articles"),
    /** `results` is an `articleCount`, `names` a `formatList` of the selected categories. */
    matching: (results: string, names: string) => `${results} matching ${names}`,
    filterByCategory: "Filter by category",
    noArticles: "No articles published yet.",
    noMatchingArticles: "No articles match the selected categories.",
    byline: (names: string) => `By ${names}`,
  },

  article: {
    minRead: (minutes: number) => `${minutes} min read`,
  },

  author: {
    backTo: (title: string) => `Back to ${title}`,
    articles: "Articles",
  },

  blog: {
    /** For a blog index with no `title` of its own. */
    fallbackTitle: "Blog",
  },

  feed: {
    rss: "RSS",
    description: (title: string) => `The latest from ${title}.`,
    untitled: "Untitled",
  },

  form: {
    sending: "Sending",
    done: "Done",
    error: "Something went wrong. Please try again.",
    closed: "The form cannot be sent right now. Please try again in a moment.",
    submitUnconfirmed: "We may have received this already. Please wait a moment before sending it again.",
    submitFailed: "Failed to submit form. Please try again later.",
    needsJavaScript: "This form needs JavaScript to send.",
    dialCode: (label: string) => `${label} dial code`,
    humanCheckFailed: "We could not confirm you are a person. Please try again.",
  },

  contactForm: {
    /** Keyed by the schema's field names. */
    labels: {
      firstName: "First Name",
      lastName: "Last Name",
      email: "Email",
      phone: "Phone",
      topic: "Topic",
      startDate: "Preferred start date",
      budget: "Budget",
      services: "Services",
      message: "Message",
      consent: "I agree to the processing of my data as described in the privacy policy",
    },
    /** Keyed by the submitted value, which stays the same in every language. */
    options: {
      topic: { general: "General inquiry", project: "New project", support: "Support" },
      budget: { "under-10k": "Under $10k", "10k-50k": "$10k to $50k", "over-50k": "Over $50k" },
      services: { design: "Design", development: "Development", content: "Content", seo: "SEO" },
    },
    send: "Send Message",
    sent: "Message sent",
    success: "Thank you! Your message has been sent successfully.",
    validation: {
      firstNameRequired: "First name is required",
      firstNameTooLong: (max: number) => `First name must be ${max} characters or fewer`,
      lastNameRequired: "Last name is required",
      lastNameTooLong: (max: number) => `Last name must be ${max} characters or fewer`,
      emailRequired: "Email is required",
      emailTooLong: (max: number) => `Email must be ${max} characters or fewer`,
      emailInvalid: "Invalid email address",
      dialCodeInvalid: "Choose a dial code",
      phoneInvalid: "Phone can only contain digits and separators",
      phoneTooLong: (max: number) => `Phone must be ${max} characters or fewer`,
      topicRequired: "Choose a topic",
      dateInvalid: "Enter a valid date",
      servicesRequired: "Pick at least one service",
      servicesDuplicate: "Pick each service once",
      messageRequired: "Message is required",
      messageTooShort: (min: number) => `Message must be at least ${min} characters`,
      messageTooLong: (max: number) => `Message must be ${max} characters or fewer`,
      consentRequired: "Accept the privacy policy to continue",
    },
  },
};

export type UiStrings = typeof en;

const UI_STRINGS: Record<string, UiStrings> = {
  en,
  it: italian,
};

export const UI_STRING_LOCALES = Object.keys(UI_STRINGS);

export function hasUiStrings(locale: string | null | undefined): locale is string {
  return typeof locale === "string" && Object.hasOwn(UI_STRINGS, locale);
}

/** The default dictionary stands in for a locale without one, and for a page rendered outside locale routing. */
export function uiStrings(locale: string | null | undefined): UiStrings {
  return hasUiStrings(locale) ? UI_STRINGS[locale] : UI_STRINGS[DEFAULT_LOCALE];
}

/** Joins in the dictionary's own language, by its bare id rather than `getIntlLocale`, so English keeps its serial comma. */
export function formatList(locale: string | null | undefined, items: readonly string[]): string {
  return joinList(hasUiStrings(locale) ? locale : DEFAULT_LOCALE, items);
}
