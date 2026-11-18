import type { APIRoute } from "astro";
import { defineQuery } from "groq";
import { Resend } from "resend";
import { readFormPost } from "~/features/forms/form-post";
import { formLocale } from "~/features/forms/locale";
import { formFailed, formOk, formUnavailable, formWriteFailed } from "~/features/forms/response";
import { uiStrings } from "~/features/i18n/strings";
import {
  formatSender,
  notificationEmails,
  notificationHtml,
  notificationSubject,
  pickRecipients,
  withTimeout,
} from "~/features/page-builder/sections/ContactFormSection/notification";
import {
  CONTACT_FORM_TURNSTILE_ACTION,
  type ContactFormValues,
  contactForm,
} from "~/features/page-builder/sections/ContactFormSection/validate-contact-form";
import { TURNSTILE_TOKEN_FIELD } from "~/features/turnstile/constants";
import { verifyTurnstile } from "~/features/turnstile/verify";
import { RESEND_API_KEY, RESEND_EMAIL_FROM, TURNSTILE_SECRET_KEY } from "~/lib/env";
import { API_ONLY_DOCUMENTS, apiOnlyDocumentId, SANITY_SINGLETON_SITE_SETTINGS_ID } from "~/sanity/constants";
import type { SiteNotificationEmailsQResult } from "~/sanity/types";
import { sanityEditClient, sanityPublishedClient } from "../../sanity/lib/client";
import { fetchSanity } from "../../sanity/lib/fetch";

// Public contact form submissions (page-builder contact form section); the form posts same-origin.
export const prerender = false;

/** Together they stay well inside the 30 seconds a Worker keeps `waitUntil` work alive after the response. */
const WRITE_TIMEOUT_MS = 8000;
const RECIPIENTS_TIMEOUT_MS = 2000;
const NOTIFICATION_TIMEOUT_MS = 5000;

// By `_id`: a second document of the type, created through the API, would otherwise redirect personal data.
const SiteNotificationEmailsQ = defineQuery(`*[_id == "${SANITY_SINGLETON_SITE_SETTINGS_ID}"][0]{
  contactFormNotificationEmails
}`);

/** What the endpoint stores and mails: the parsed values, with the two phone fields joined back up. */
function toSubmission({ phoneDialCode, phone, consent, ...values }: ContactFormValues) {
  return {
    ...values,
    phone: phone ? `${phoneDialCode} ${phone}`.trim() : "",
    // The value is the checkbox's fixed "on"; what matters for the record is that it was given.
    consent: consent === "on",
  };
}

type Submission = ReturnType<typeof toSubmission>;

async function sendNotification(submission: Submission) {
  if (!RESEND_API_KEY || !RESEND_EMAIL_FROM) {
    return;
  }

  const from = formatSender(RESEND_EMAIL_FROM);

  if (!from) {
    console.error("Contact form notification skipped: RESEND_EMAIL_FROM is not `name@domain` or `Name <name@domain>`.");
    return;
  }

  const site = await fetchSanity<SiteNotificationEmailsQResult>(
    sanityPublishedClient,
    SiteNotificationEmailsQ,
    {},
    { signal: AbortSignal.timeout(RECIPIENTS_TIMEOUT_MS) }
  );
  const to = pickRecipients(site?.contactFormNotificationEmails);

  if (to.length === 0) {
    return;
  }

  const html = notificationHtml(
    [
      ["Name", `${submission.firstName} ${submission.lastName}`],
      ["Email", submission.email],
      ["Phone", submission.phone],
      ["Topic", submission.topic],
      ["Preferred start date", submission.startDate],
      ["Budget", submission.budget],
      ["Services", submission.services.join(", ")],
    ],
    submission.message
  );

  const subject = notificationSubject(submission.firstName, submission.lastName);
  const { error } = await withTimeout(
    new Resend(RESEND_API_KEY).batch.send(notificationEmails(from, to, subject, html)),
    NOTIFICATION_TIMEOUT_MS,
    "Contact form notification"
  );

  if (error) {
    console.error("Resend notification email failed:", error);
  }
}

export const POST: APIRoute = async (context) => {
  const formData = await readFormPost(context);

  if (formData instanceof Response) {
    return formData;
  }

  // The visitor reads every answer in the page's language; the notification below stays in the default one.
  const locale = formLocale(formData);

  // No secret means no check, and a submission is never stored or mailed unchecked.
  if (!TURNSTILE_SECRET_KEY) {
    console.error("TURNSTILE_SECRET_KEY is not set, so every form submission is refused. See docs/features/turnstile.md.");

    return formUnavailable(locale);
  }

  const human = await verifyTurnstile({
    token: formData.get(TURNSTILE_TOKEN_FIELD),
    secret: TURNSTILE_SECRET_KEY,
    action: CONTACT_FORM_TURNSTILE_ACTION,
    hostname: new URL(context.request.url).hostname,
    ip: context.clientAddress,
  });

  if (!human) {
    return formFailed(400, { error: uiStrings(locale).form.humanCheckFailed });
  }

  // Same rules the form already ran; a bypassed client lands here instead of in the CMS.
  const validation = contactForm(locale).check(formData);

  if (!validation.ok) {
    return formFailed(400, { fieldErrors: validation.fieldErrors, error: validation.formError });
  }

  const submission = toSubmission(validation.data);

  try {
    // No retries: a timed-out write may still land, and a retry would store the submission twice.
    await sanityEditClient.withConfig({ maxRetries: 0 }).create(
      {
        ...submission,
        locale,
        _id: apiOnlyDocumentId(API_ONLY_DOCUMENTS.contactFormSubmission),
        _type: API_ONLY_DOCUMENTS.contactFormSubmission,
      },
      { autoGenerateArrayKeys: true, signal: AbortSignal.timeout(WRITE_TIMEOUT_MS) }
    );
  } catch (error) {
    console.error("Failed to submit contact form:", error);

    return formWriteFailed(error, locale);
  }

  // Off the response: a slow or failing Resend never holds the visitor, and the submission is already stored.
  context.locals.cfContext.waitUntil(
    sendNotification(submission).catch((error: unknown) => {
      console.error("Resend notification failed:", error);
    })
  );

  return formOk();
};
