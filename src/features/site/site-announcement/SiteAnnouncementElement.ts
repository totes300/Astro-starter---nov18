import { hasCookie, setCookie } from "~/lib/cookies";
import { EXIT_EASING, SETTLE_EASING } from "~/lib/curves";
import { prefersReducedMotion } from "~/lib/utils";
import { ANNOUNCEMENT_COOKIE_MAX_AGE, ANNOUNCEMENT_COOKIE_NAME } from "./dismissal";

const FADE_MS = 200;
const FOLD_MS = 500;

/**
 * The announcement bar closes, and that is all: whether its line has to scroll is for the `Marquee`
 * its content sits in to decide.
 */
export class SiteAnnouncementElement extends HTMLElement {
  #closeButton: HTMLButtonElement | null = null;

  // The copy fades, then the bar folds to nothing, so the header and the page ride up in step.
  #onClose = () => {
    setCookie(ANNOUNCEMENT_COOKIE_NAME, "1", ANNOUNCEMENT_COOKIE_MAX_AGE);

    if (prefersReducedMotion()) {
      this.remove();
      return;
    }

    this.inert = true;

    for (const child of this.children) {
      child.animate([{ opacity: 0 }], { duration: FADE_MS, easing: EXIT_EASING, fill: "forwards" });
    }

    const fold = this.animate([{ height: `${this.offsetHeight}px` }, { height: "0px" }], {
      duration: FOLD_MS,
      easing: SETTLE_EASING,
      fill: "forwards",
    });

    void fold.finished.then(
      () => this.remove(),
      () => undefined
    );
  };

  connectedCallback() {
    // The inline guard in the markup already covers the first paint; this covers a client-side
    // navigation, where the bar is swapped back in after it was closed on the previous page.
    if (hasCookie(ANNOUNCEMENT_COOKIE_NAME)) {
      this.remove();
      return;
    }

    this.#closeButton = this.querySelector<HTMLButtonElement>("[data-announcement-close]");
    this.#closeButton?.addEventListener("click", this.#onClose);
  }

  disconnectedCallback() {
    this.#closeButton?.removeEventListener("click", this.#onClose);
    this.#closeButton = null;
  }
}

if (!customElements.get("site-announcement")) {
  customElements.define("site-announcement", SiteAnnouncementElement);
}
