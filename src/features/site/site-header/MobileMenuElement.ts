import type { LenisElement } from "~/components/Lenis/LenisElement";
import { setPageScrollLock } from "~/lib/scroll-lock";
import { desktopQuery } from "~/lib/utils";

/** Whether the outgoing page left with its menu open. */
let departedOpen = false;

/**
 * Fades a panel in under the header with the rest of the page inert and locked. A navigation leaves it open: its
 * links fade out with the page (`data-page-out`), its ground holds over the old page, and the next page arrives closed.
 */
export class MobileMenuElement extends HTMLElement {
  #trigger: HTMLButtonElement | null = null;
  #panel: HTMLElement | null = null;
  #wide: MediaQueryList | null = null;
  #outside: HTMLElement[] = [];
  /** The scroll driver it stopped, kept by reference: at a swap the incoming one is in the document before it upgrades. */
  #lenis: LenisElement | null = null;
  #isOpen = false;

  connectedCallback() {
    this.#trigger = this.querySelector<HTMLButtonElement>("[data-menu-trigger]");
    this.#panel = this.querySelector<HTMLElement>("[data-menu-panel]");
    this.#wide = desktopQuery();

    this.#trigger?.addEventListener("click", this.#onTriggerClick);
    this.#wide.addEventListener("change", this.#onWideChange);
    window.addEventListener("keydown", this.#onKeyDown);
    // On the window, capturing: a same-page hash link is scrolled by a document listener, which a locked page ignores.
    window.addEventListener("click", this.#onClickCapture, { capture: true });
    document.addEventListener("astro:before-swap", this.#onBeforeSwap);
    document.addEventListener("astro:after-swap", this.#onAfterSwap);

    // The bar was under the open menu, so it fades in with the page rather than appearing as the menu goes.
    if (departedOpen) {
      document.querySelector("site-announcement")?.setAttribute("data-page-in", "fade");
    }

    departedOpen = false;
  }

  disconnectedCallback() {
    this.#trigger?.removeEventListener("click", this.#onTriggerClick);
    this.#wide?.removeEventListener("change", this.#onWideChange);
    window.removeEventListener("keydown", this.#onKeyDown);
    window.removeEventListener("click", this.#onClickCapture, { capture: true });
    document.removeEventListener("astro:before-swap", this.#onBeforeSwap);
    document.removeEventListener("astro:after-swap", this.#onAfterSwap);

    // The lock is on <html> and the inert siblings can outlive this element.
    this.#release();

    this.#trigger = null;
    this.#panel = null;
    this.#wide = null;
  }

  #open() {
    const header = this.closest("header");
    const panel = this.#panel;

    if (!header || !panel || this.#isOpen) {
      return;
    }

    // The header scrolls with the page, so the panel's content starts wherever its foot is right now.
    panel.style.setProperty("--menu-top", `${Math.max(header.getBoundingClientRect().bottom, 0)}px`);
    panel.scrollTo(0, 0);
    panel.inert = false;
    panel.dataset.open = "";
    this.#trigger?.setAttribute("aria-expanded", "true");

    // Everything but the header leaves the tab order and the accessibility tree, as it would behind a dialog.
    this.#outside = Array.from(header.parentElement?.children ?? []).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== header && !element.inert
    );

    for (const element of this.#outside) {
      element.inert = true;
    }

    this.#lenis = document.querySelector<LenisElement>("lenis-scroll");
    this.#lenis?.stop();
    setPageScrollLock(true);
    this.#isOpen = true;
  }

  #close() {
    const panel = this.#panel;

    if (!panel || !this.#isOpen) {
      return;
    }

    // Focus cannot stay in a panel that is about to go inert.
    if (panel.contains(document.activeElement)) {
      this.#trigger?.focus();
    }

    panel.inert = true;
    delete panel.dataset.open;
    this.#trigger?.setAttribute("aria-expanded", "false");
    this.#release();
  }

  #release() {
    if (!this.#isOpen) {
      return;
    }

    for (const element of this.#outside) {
      element.inert = false;
    }

    this.#outside = [];
    this.#lenis?.start();
    this.#lenis = null;
    setPageScrollLock(false);
    this.#isOpen = false;
  }

  #onTriggerClick = () => {
    if (this.#isOpen) {
      this.#close();
      return;
    }

    this.#open();
  };

  #onWideChange = (event: MediaQueryListEvent) => {
    if (event.matches) {
      this.#close();
    }
  };

  #onKeyDown = (event: KeyboardEvent) => {
    // An open popover inside the panel (the language menu) takes Escape first.
    if (event.key !== "Escape" || !this.#isOpen || this.#panel?.querySelector(":popover-open")) {
      return;
    }

    this.#trigger?.focus();
    this.#close();
  };

  // A tap on a link leaves the menu open until the next page is in; one to the page already showing navigates nowhere.
  #onClickCapture = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;

    if (link && this.#panel?.contains(link) && link.origin === location.origin && link.pathname === location.pathname) {
      this.#close();
    }
  };

  // The swap replaces the header, so the incoming one is told the page left from an open menu.
  #onBeforeSwap = () => {
    departedOpen = this.#isOpen;
  };

  // Still connected after a swap means an in-place navigation kept this header, and the page it answered is in.
  #onAfterSwap = () => {
    departedOpen = false;
    this.#close();
  };
}

if (!customElements.get("mobile-menu")) {
  customElements.define("mobile-menu", MobileMenuElement);
}
