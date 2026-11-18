import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { formLocale, LOCALE_FIELD_NAME } from "~/features/forms/locale";
import { UI_STRING_LOCALES, uiStrings } from "~/features/i18n/strings";
import { DEFAULT_LOCALE, LOCALE_IDS } from "~/sanity/i18n";
import { contactFormMessages, contactFormRules } from "./contact-form-rules";
import { contactForm, contactFormOptions } from "./validate-contact-form";

const VALID = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  phoneDialCode: "+44",
  phone: "20 7946 0000",
  topic: "general",
  startDate: "2026-11-01",
  budget: "",
  services: ["design"],
  message: "Hello there, a valid message.",
  consent: "on",
};

function formData(values: Record<string, string | string[]>) {
  const data = new FormData();

  for (const [name, value] of Object.entries(values)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      data.append(name, entry);
    }
  }

  return data;
}

function errorsFor(values: Record<string, string | string[]>, locale: string = DEFAULT_LOCALE) {
  const result = contactForm(locale).check(formData(values));

  return result.ok ? {} : result.fieldErrors;
}

test("contact form: a real submission passes", () => {
  assert.equal(contactForm(DEFAULT_LOCALE).check(formData(VALID)).ok, true);
});

test("contact form: every free-text field is capped on the server", () => {
  assert.ok(errorsFor({ ...VALID, firstName: "a".repeat(101) }).firstName);
  assert.ok(errorsFor({ ...VALID, lastName: "a".repeat(101) }).lastName);
  assert.ok(errorsFor({ ...VALID, email: `${"a".repeat(250)}@example.com` }).email);
  assert.ok(errorsFor({ ...VALID, phone: "1".repeat(21) }).phone);
  assert.ok(errorsFor({ ...VALID, message: "a".repeat(1001) }).message);
});

test("contact form: the dial code is one FormPhone renders, or blank", () => {
  assert.ok(errorsFor({ ...VALID, phoneDialCode: "+1".padEnd(1_000_003, "1") }).phoneDialCode);
  assert.ok(errorsFor({ ...VALID, phoneDialCode: "+1\r\nBcc: victim@example.com" }).phoneDialCode);
  assert.equal(errorsFor({ ...VALID, phoneDialCode: "" }).phoneDialCode, undefined);
  assert.equal(errorsFor({ ...VALID, phoneDialCode: "+971" }).phoneDialCode, undefined);
});

test("contact form: services are capped to the options and deduplicated", () => {
  const form = contactForm(DEFAULT_LOCALE);

  assert.ok(errorsFor({ ...VALID, services: Array.from({ length: 50_000 }, () => "design") }).services);
  assert.equal(form.check(formData({ ...VALID, services: ["design", "not-a-service"] })).ok, false);

  const result = form.check(formData({ ...VALID, services: ["design", "design", "seo"] }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.data.services, ["design", "seo"]);
});

test("contact form: unknown keys never reach the stored document", () => {
  const result = contactForm(DEFAULT_LOCALE).check(formData({ ...VALID, _id: "siteSettings", _type: "siteSettings" }));

  assert.equal(result.ok, true);
  assert.equal(result.ok && "_id" in result.data, false);
  assert.equal(result.ok && "_type" in result.data, false);
});

test("contact form: the caps leave the derived required flags as they were", () => {
  const { field } = contactForm(DEFAULT_LOCALE);

  assert.equal(field("services").required, true);
  assert.equal(field("email").required, true);
  assert.equal(field("phoneDialCode").required, false);
  assert.equal(field("phone").required, false);
  assert.equal(field("budget").required, false);
});

test("contact form: the rules are the same in every language, and only the messages change", () => {
  const invalid = {
    ...VALID,
    firstName: "",
    lastName: "a".repeat(101),
    email: "not an email",
    phone: "abc",
    topic: "",
    startDate: "tomorrow",
    services: [],
    message: "short",
    consent: "",
  };
  const fields = Object.keys(errorsFor(invalid)).sort();

  for (const locale of UI_STRING_LOCALES) {
    const { field } = contactForm(locale);
    const errors = errorsFor(invalid, locale);
    const messages = uiStrings(locale).contactForm.validation;

    assert.deepEqual(Object.keys(errors).sort(), fields, locale);
    assert.equal(errors.firstName, messages.firstNameRequired, locale);
    assert.equal(errors.lastName, messages.lastNameTooLong(100), locale);
    assert.equal(errors.email, messages.emailInvalid, locale);
    assert.equal(errors.phone, messages.phoneInvalid, locale);
    assert.equal(errors.topic, messages.topicRequired, locale);
    assert.equal(errors.startDate, messages.dateInvalid, locale);
    assert.equal(errors.services, messages.servicesRequired, locale);
    assert.equal(errors.message, messages.messageTooShort(10), locale);
    assert.equal(errors.consent, messages.consentRequired, locale);
    assert.equal(contactForm(locale).check(formData(VALID)).ok, true, locale);

    for (const name of ["firstName", "email", "topic", "services", "consent", "phone", "budget"] as const) {
      assert.equal(field(name).required, contactForm(DEFAULT_LOCALE).field(name).required, `${locale} ${name}`);
    }
  }
});

test("contact form: the browser's rules, built from the messages the section renders, report what the server's do", () => {
  const invalid = { ...VALID, firstName: "a".repeat(101), email: "", phone: "1".repeat(21), message: "short", consent: "" };

  for (const locale of UI_STRING_LOCALES) {
    const rendered: unknown = JSON.parse(JSON.stringify(contactFormMessages(uiStrings(locale).contactForm.validation)));
    const browser = contactFormRules(rendered as Parameters<typeof contactFormRules>[0]);
    const server = contactForm(locale);

    for (const [key, message] of Object.entries(rendered as Record<string, unknown>)) {
      assert.ok(typeof message === "string" && message.trim(), `${locale} ${key}`);
    }

    assert.deepEqual(browser.check(formData(invalid)), server.check(formData(invalid)), locale);
    assert.equal(browser.check(formData(VALID)).ok, true, locale);

    for (const name of ["firstName", "email", "topic", "services", "consent", "phone", "budget"] as const) {
      assert.equal(browser.field(name).required, server.field(name).required, `${locale} ${name}`);
    }
  }
});

test("contact form: the section hands the element its messages, so the browser never loads a dictionary", () => {
  const section = readFileSync(join(import.meta.dirname, "ContactForm.astro"), "utf8");
  const element = readFileSync(join(import.meta.dirname, "ContactFormElement.ts"), "utf8");

  assert.match(section, /const validationMessages = JSON\.stringify\(contactFormMessages\(strings\.validation\)\);/);
  assert.match(section, /data-validation-messages=\{validationMessages\}/);
  assert.match(section, /data-error-message=\{formStrings\.error\}/);
  assert.match(element, /import\("\.\/contact-form-rules"\)/);
  assert.match(element, /this\.dataset\.validationMessages/);
});

test("contact form: a language with no copy reports in the default one", () => {
  assert.deepEqual(errorsFor({ ...VALID, firstName: "" }, "zz"), errorsFor({ ...VALID, firstName: "" }));
});

test("contact form: every option the form submits has a label in every language, and every label an option", () => {
  for (const locale of UI_STRING_LOCALES) {
    const options = contactFormOptions(locale);
    const labels = uiStrings(locale).contactForm.options;

    for (const name of ["topic", "budget", "services"] as const) {
      const submitted = options[name].map(({ value }) => value);

      assert.deepEqual(Object.keys(labels[name]).sort(), submitted.sort(), `${locale} ${name}`);

      for (const { value, label } of options[name]) {
        assert.ok(label.trim(), `${locale} ${name}.${value}`);
        assert.equal(label, (labels[name] as Record<string, string>)[value], `${locale} ${name}.${value}`);
      }
    }
  }
});

test("contact form: every option it renders is one it accepts", () => {
  const options = contactFormOptions(DEFAULT_LOCALE);
  const form = contactForm(DEFAULT_LOCALE);

  for (const { value } of options.topic) {
    assert.equal(form.check(formData({ ...VALID, topic: value })).ok, true, value);
  }

  for (const { value } of options.budget) {
    assert.equal(form.check(formData({ ...VALID, budget: value })).ok, true, value);
  }

  assert.equal(form.check(formData({ ...VALID, services: options.services.map(({ value }) => value) })).ok, true);
});

test("contact form: a post from a page in any language is checked and answered in that language", () => {
  for (const locale of LOCALE_IDS) {
    const posted = formData({ ...VALID, firstName: "", [LOCALE_FIELD_NAME]: locale });
    const result = contactForm(formLocale(posted)).check(posted);

    assert.equal(result.ok, false, locale);
    assert.equal(!result.ok && result.fieldErrors.firstName, uiStrings(locale).contactForm.validation.firstNameRequired, locale);
  }
});

test("contact form: the endpoint reads the posted language once and answers, checks and stores in it", () => {
  const endpoint = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "pages", "api", "contact-form.ts"), "utf8");

  assert.equal(endpoint.match(/formLocale\(formData\)/g)?.length, 1);
  assert.match(endpoint, /formUnavailable\(locale\)/);
  assert.match(endpoint, /uiStrings\(locale\)\.form\.humanCheckFailed/);
  assert.match(endpoint, /contactForm\(locale\)\.check\(formData\)/);
  assert.match(endpoint, /formWriteFailed\(error, locale\)/);
  assert.match(endpoint, /\.\.\.submission,\s+locale,/);
});
