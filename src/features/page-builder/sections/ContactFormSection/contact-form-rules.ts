import { z } from "zod";
import { DIAL_CODES } from "~/components/Form/dial-codes";
import type { FormOption } from "~/components/Form/FormDropdown.astro";
import { defineForm } from "~/features/forms/validate";
import type { UiStrings } from "~/features/i18n/strings";

const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;
const MAX_PHONE_LENGTH = 20;
const MIN_MESSAGE_LENGTH = 10;
const MAX_MESSAGE_LENGTH = 1000;

// The submitted values, the same in every language; each one's label is the dictionary's (`contactForm.options`).
const TOPICS = ["general", "project", "support"] as const;
const BUDGETS = ["under-10k", "10k-50k", "over-50k"] as const;
const SERVICES = ["design", "development", "content", "seo"] as const;

const values = <T extends readonly { value: string }[]>(options: T) =>
  options.map(({ value }) => value) as [T[number]["value"], ...T[number]["value"][]];

const labelled = <Value extends string>(options: readonly Value[], labels: Record<Value, string>): FormOption[] =>
  options.map((value) => ({ value, label: labels[value] }));

type ValidationStrings = UiStrings["contactForm"]["validation"];

/** Each validation message as plain text: what the page renders for the browser to check with. */
export type ContactFormMessages = Record<keyof ValidationStrings, string>;

/** Resolves the messages that take a limit, with the limits these rules enforce. */
export function contactFormMessages(strings: ValidationStrings): ContactFormMessages {
  return {
    ...strings,
    firstNameTooLong: strings.firstNameTooLong(MAX_NAME_LENGTH),
    lastNameTooLong: strings.lastNameTooLong(MAX_NAME_LENGTH),
    emailTooLong: strings.emailTooLong(MAX_EMAIL_LENGTH),
    phoneTooLong: strings.phoneTooLong(MAX_PHONE_LENGTH),
    messageTooShort: strings.messageTooShort(MIN_MESSAGE_LENGTH),
    messageTooLong: strings.messageTooLong(MAX_MESSAGE_LENGTH),
  };
}

/** One field of every control type on purpose: this form is the worked example (see docs/features/forms.md). */
function contactFormSchema(messages: ContactFormMessages) {
  return z.object({
    firstName: z.string().trim().min(1, messages.firstNameRequired).max(MAX_NAME_LENGTH, messages.firstNameTooLong),
    lastName: z.string().trim().min(1, messages.lastNameRequired).max(MAX_NAME_LENGTH, messages.lastNameTooLong),
    email: z
      .string()
      .trim()
      .min(1, messages.emailRequired)
      .max(MAX_EMAIL_LENGTH, messages.emailTooLong)
      .pipe(z.email(messages.emailInvalid)),
    // FormPhone submits the number and its dial code as two fields, so nothing has to unpick one string.
    phoneDialCode: z.enum(values(DIAL_CODES), messages.dialCodeInvalid).or(z.literal("")),
    phone: z
      .string()
      .trim()
      .regex(/^[0-9 ()-]*$/, messages.phoneInvalid)
      .max(MAX_PHONE_LENGTH, messages.phoneTooLong),
    topic: z.enum(TOPICS, messages.topicRequired),
    startDate: z
      .string()
      .trim()
      .regex(/^$|^\d{4}-\d{2}-\d{2}$/, messages.dateInvalid),
    budget: z.enum(BUDGETS).or(z.literal("")),
    services: z
      .array(z.enum(SERVICES))
      .min(1, messages.servicesRequired)
      .max(SERVICES.length, messages.servicesDuplicate)
      .transform((services) => [...new Set(services)]),
    message: z
      .string()
      .trim()
      .min(1, messages.messageRequired)
      .pipe(z.string().min(MIN_MESSAGE_LENGTH, messages.messageTooShort).max(MAX_MESSAGE_LENGTH, messages.messageTooLong)),
    consent: z.literal("on", messages.consentRequired),
  });
}

export type ContactFormValues = z.output<ReturnType<typeof contactFormSchema>>;

/** The rules are the same in every language; only the messages they report change. */
export function contactFormRules(messages: ContactFormMessages) {
  return defineForm(contactFormSchema(messages));
}

/** What the choice fields render, each submitted value labelled from one dictionary. */
export function labelledOptions(labels: UiStrings["contactForm"]["options"]) {
  return {
    topic: labelled(TOPICS, labels.topic),
    budget: labelled(BUDGETS, labels.budget),
    services: labelled(SERVICES, labels.services),
  };
}
