import { LOCALE_COOKIE_MAX_AGE, LOCALE_COOKIE_NAME } from "~/features/i18n/locale";
import { setCookie } from "~/lib/cookies";
import { REVEAL_EASING } from "~/lib/curves";
import { prefersReducedMotion } from "~/lib/utils";

const RISE_MS = 250;

/** Remembers the choice for the homepage's language detection and animates the menu; the links work without it. */
export class LanguageSwitcherElement extends HTMLElement {
  #links: HTMLAnchorElement[] = [];
  #menu: HTMLElement | null = null;
  #rise: Animation | null = null;

  connectedCallback() {
    this.#links = [...this.querySelectorAll<HTMLAnchorElement>("a[data-locale]")];

    for (const link of this.#links) {
      link.addEventListener("click", this.#onClick);
    }

    this.#menu = this.querySelector<HTMLElement>("[popover]");
    this.#menu?.addEventListener("beforetoggle", this.#onBeforeToggle);
    this.addEventListener("keydown", this.#onKeyDown);
  }

  disconnectedCallback() {
    for (const link of this.#links) {
      link.removeEventListener("click", this.#onClick);
    }

    this.#links = [];
    this.#menu?.removeEventListener("beforetoggle", this.#onBeforeToggle);
    this.removeEventListener("keydown", this.#onKeyDown);
    this.#menu = null;
    this.#rise?.cancel();
    this.#rise = null;
  }

  // On `beforetoggle`: a CSS entry transition flashes in Chrome, and `toggle` lands a frame after the menu shows.
  #onBeforeToggle = (event: ToggleEvent) => {
    this.#rise?.cancel();
    this.#rise = null;

    if (event.newState !== "open" || prefersReducedMotion()) {
      return;
    }

    this.#rise =
      this.#menu?.animate(
        [
          { opacity: 0, translate: "0 4px" },
          { opacity: 1, translate: "0 0" },
        ],
        { duration: RISE_MS, easing: REVEAL_EASING }
      ) ?? null;
  };

  // A popover only closes on Escape or an outside click; tabbing past it would leave it open over the page.
  #onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Tab") {
      return;
    }

    requestAnimationFrame(() => {
      if (!this.contains(document.activeElement) && this.#menu?.matches(":popover-open")) {
        this.#menu.hidePopover();
      }
    });
  };

  #onClick = (event: MouseEvent) => {
    const locale = (event.currentTarget as HTMLAnchorElement).dataset.locale;

    if (!locale) {
      return;
    }

    setCookie(LOCALE_COOKIE_NAME, locale, LOCALE_COOKIE_MAX_AGE);
  };
}

if (!customElements.get("language-switcher")) {
  customElements.define("language-switcher", LanguageSwitcherElement);
}
