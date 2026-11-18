import { setFieldErrors } from "~/components/Form/field-errors";
import { SubmitState } from "~/features/forms/submit-state";
import { loadTurnstile, turnstileToken } from "~/features/turnstile/client";
import { TURNSTILE_TOKEN_FIELD } from "~/features/turnstile/constants";
import { LOCALE_FIELD_NAME } from "./locale";
import type { FormFailure, FormResponse } from "./response";
import type { FormValidation } from "./validate";

export type FormRules = { check(formData: FormData): FormValidation<unknown> };

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement;

const CONTROLS = "input, select, textarea, button";

/**
 * Everything a progressively enhanced form does, so a form only says which rules it runs and what it says
 * when they pass. The seams for more are `successMessage` and `onSuccess`.
 */
export abstract class FormElement extends HTMLElement {
  #form: HTMLFormElement | null = null;
  #message: HTMLElement | null = null;
  #submitState: SubmitState | null = null;
  #rules: Promise<FormRules | null> | null = null;
  #disabledBySubmit: FormControl[] = [];
  #humanCheck: HTMLElement | null = null;
  #submitting = false;
  #reported = false;

  /** Zod is heavy, so a form's schema is its own chunk, fetched by a submit and never with the page. */
  protected abstract loadRules(): Promise<FormRules>;

  /** Empty leaves the confirmation to the button. */
  protected successMessage = "";

  protected onSuccess() {}

  connectedCallback() {
    this.#form = this.querySelector<HTMLFormElement>("form");
    this.#message = this.querySelector<HTMLElement>("[data-form-message]");
    this.#humanCheck = this.querySelector<HTMLElement>("[data-human-check]");

    if (!this.#form) {
      return;
    }

    // Native bubbles cannot be styled and would pre-empt this handler; every `required` here comes from the schema.
    this.#form.noValidate = true;

    // Shipped disabled: a native post, sent before this upgrade or without JS, is one the endpoint refuses.
    this.#form.querySelectorAll<HTMLButtonElement>('button[type="submit"][data-submit-state]').forEach((button) => {
      button.disabled = false;
    });

    this.#submitState = new SubmitState(this.#form);
    this.#form.addEventListener("submit", this.#onSubmit);
    this.#form.addEventListener("input", this.#onInput);
    this.#form.addEventListener("focusin", this.#warmUp, { once: true });
  }

  disconnectedCallback() {
    this.#form?.removeEventListener("submit", this.#onSubmit);
    this.#form?.removeEventListener("input", this.#onInput);
    this.#form?.removeEventListener("focusin", this.#warmUp);
    this.#submitState?.destroy();
  }

  // Fetched while the visitor types, so the check at submit does not wait on the download.
  #warmUp = () => {
    if (this.#humanCheck) {
      loadTurnstile().catch(() => {});
    }
  };

  // Errors are only ever raised by a submit, but once raised they have to clear as they are fixed.
  #onInput = () => {
    if (this.#reported) {
      void this.#report();
    }
  };

  #onSubmit = async (event: SubmitEvent) => {
    event.preventDefault();

    const form = this.#form;

    // Set before the first await, or a second click during the schema fetch gets all the way through to its own POST.
    if (!form || this.#submitting) {
      return;
    }

    this.#submitting = true;
    this.#reported = true;

    try {
      if (!(await this.#report({ focus: true }))) {
        return;
      }

      const formData = new FormData(form);

      formData.set(LOCALE_FIELD_NAME, document.documentElement.lang);

      this.#setPending(true);

      const token = await this.#confirmHuman();

      if (token === null) {
        this.#setPending(false);
        this.#setMessage(this.dataset.humanCheckMessage || this.#fallbackError(), true);

        return;
      }

      if (token) {
        formData.set(TURNSTILE_TOKEN_FIELD, token);
      }

      const response = await fetch(form.action, { method: "POST", body: formData });
      const result = (await response.json()) as FormResponse;

      // Settling first: a control the request disabled cannot take the focus a rejection wants to give it.
      this.#setPending(false, result.ok ? "done" : "idle");

      if (result.ok) {
        this.#reset(form);
        this.onSuccess();
      } else {
        this.#reject(form, result);
      }
    } catch {
      this.#setPending(false);
      this.#setMessage(this.#fallbackError(), true);
    } finally {
      this.#submitting = false;
    }
  };

  // A token per submit, since each is single use. A form without the check posts none, and its endpoint refuses that.
  async #confirmHuman(): Promise<string | null | undefined> {
    const container = this.#humanCheck;

    if (!container) {
      return undefined;
    }

    try {
      return await turnstileToken({
        container,
        siteKey: container.dataset.siteKey ?? "",
        action: container.dataset.action ?? "",
        language: document.documentElement.lang || "auto",
      });
    } catch {
      return null;
    }
  }

  // A failed load is not cached, so a submit after a dropped connection can still pick the rules up.
  #loadRules() {
    this.#rules ??= this.loadRules().catch(() => {
      this.#rules = null;

      return null;
    });

    return this.#rules;
  }

  /** Paints the schema's verdict across the form and answers whether it may be sent. */
  async #report({ focus = false } = {}) {
    const form = this.#form;
    const rules = await this.#loadRules();

    // With no rules in the browser the endpoint is the only judge, and it answers with the same map.
    if (!form || !rules) {
      return true;
    }

    const validation = rules.check(new FormData(form));
    const firstInvalid = setFieldErrors(form, validation.ok ? {} : validation.fieldErrors);

    this.#setMessage(validation.ok ? "" : (validation.formError ?? ""), true);

    if (focus) {
      firstInvalid?.focus();
    }

    return validation.ok;
  }

  // Nothing painted means nothing to look at, so the failure falls back to the message line.
  #reject(form: HTMLFormElement, failure: FormFailure) {
    const firstInvalid = failure.fieldErrors ? setFieldErrors(form, failure.fieldErrors) : null;

    if (!firstInvalid) {
      this.#setMessage(failure.error || this.#fallbackError(), true);

      return;
    }

    this.#setMessage(failure.error ?? "", true);
    firstInvalid.focus();
  }

  // Rendered in the page's language by the server, so no dictionary ships to the browser.
  #fallbackError() {
    return this.dataset.errorMessage ?? "";
  }

  #reset(form: HTMLFormElement) {
    form.reset();
    setFieldErrors(form, {});

    this.#reported = false;

    this.#setMessage(this.successMessage, false);
  }

  #setMessage(text: string, isError: boolean) {
    if (!this.#message) {
      return;
    }

    this.#message.textContent = text;
    this.#message.classList.toggle("text-danger", isError);
    this.#message.classList.toggle("text-ink-body", !isError);
  }

  // Success holds "done" in the button for a beat, so the outcome is read where the action was taken.
  #setPending(pending: boolean, settled: "idle" | "done" = "idle") {
    if (pending) {
      // Only what this submit disables is re-enabled after it; a control the markup shipped disabled stays so.
      this.#disabledBySubmit = Array.from(this.#form?.querySelectorAll<FormControl>(CONTROLS) ?? []).filter(
        (control) => !control.disabled
      );
    }

    for (const control of this.#disabledBySubmit) {
      control.disabled = pending;
    }

    if (!pending) {
      this.#disabledBySubmit = [];
    }

    if (pending) {
      this.#submitState?.pending();
    } else if (settled === "done") {
      this.#submitState?.done();
    } else {
      this.#submitState?.idle();
    }
  }
}
