// Marks the field filled once its control holds a value, which the date placeholder and the select's ink read.
// Server-rendered values are read on connect, so a field that arrives filled never starts empty.
type FieldControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export class FormFieldElement extends HTMLElement {
  #control: FieldControl | null = null;
  #form: HTMLFormElement | null = null;

  #onInput = () => {
    this.#syncFilled();
  };

  // A reset clears the control after the event dispatches, so the read waits for the next task.
  #onReset = () => {
    window.setTimeout(this.#onInput);
  };

  connectedCallback() {
    this.#control = this.querySelector<FieldControl>("[data-field-control]");
    this.#form = this.closest("form");

    this.#control?.addEventListener("input", this.#onInput);
    this.#form?.addEventListener("reset", this.#onReset);

    this.#syncFilled();
  }

  disconnectedCallback() {
    this.#control?.removeEventListener("input", this.#onInput);
    this.#form?.removeEventListener("reset", this.#onReset);
  }

  #syncFilled() {
    this.toggleAttribute("data-filled", Boolean(this.#control?.value));
  }
}

if (!customElements.get("form-field")) {
  customElements.define("form-field", FormFieldElement);
}
