import { FormElement } from "~/features/forms/form-element";

export class ContactFormElement extends FormElement {
  connectedCallback() {
    this.successMessage = this.dataset.successMessage ?? "";

    super.connectedCallback();
  }

  // The messages arrive rendered in the page's language, so no dictionary ships to the browser.
  protected async loadRules() {
    const { contactFormRules } = await import("./contact-form-rules");

    return contactFormRules(JSON.parse(this.dataset.validationMessages ?? ""));
  }
}

if (!customElements.get("contact-form")) {
  customElements.define("contact-form", ContactFormElement);
}
