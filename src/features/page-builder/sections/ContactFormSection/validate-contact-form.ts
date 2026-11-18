// The form in one language, for the markup and the endpoint. Server only: it loads every dictionary.
// The browser builds its rules from ./contact-form-rules.ts with the messages the section renders.

import { uiStrings } from "~/features/i18n/strings";
import { contactFormMessages, contactFormRules, labelledOptions } from "./contact-form-rules";

export type { ContactFormValues } from "./contact-form-rules";

/** The Turnstile action the form mints its token for, and the only one its endpoint accepts. */
export const CONTACT_FORM_TURNSTILE_ACTION = "contact-form";

/** The rules are the same in every language; only the messages they report are the page's. */
export function contactForm(locale: string) {
  return contactFormRules(contactFormMessages(uiStrings(locale).contactForm.validation));
}

/** What the choice fields render, labelled in the page's language. */
export function contactFormOptions(locale: string) {
  return labelledOptions(uiStrings(locale).contactForm.options);
}
