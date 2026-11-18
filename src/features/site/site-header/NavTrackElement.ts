import { CSS_EASING } from "~/lib/curves";
import { canHoverQuery, prefersReducedMotion } from "~/lib/utils";

const LABEL_MS = 300;

/** The item the outgoing track's pill sat on, for the incoming one to glide from; null when it was off screen. */
let departedIndex: number | null = null;

/** Where a link sits in its list. Rects, not offsets: label widths are fractional, and a rounded plate sits a pixel off. */
const measure = (link: HTMLElement) => {
  const box = link.getBoundingClientRect();
  const origin = link.closest("ul")?.getBoundingClientRect();

  return { left: box.left - (origin?.left ?? box.left), width: box.width };
};

/** Written as width and translate, since a scale would stretch the pill's ends. */
const place = (plate: HTMLElement, link: HTMLElement) => {
  const { left, width } = measure(link);

  plate.style.width = `${width}px`;
  plate.style.translate = `${left}px 0`;
};

/** Places a plate with no travel, for one that had nowhere to travel from. */
const seat = (plate: HTMLElement, link: HTMLElement) => {
  plate.dataset.still = "";
  place(plate, link);
  // Read layout so the jump lands before the transition comes back.
  void plate.offsetWidth;
  delete plate.dataset.still;
};

/** Keeps the ink plate on the current link, gliding it there on a navigation, and a white one under the pointer. */
export class NavTrackElement extends HTMLElement {
  #current: HTMLElement | null = null;
  #hover: HTMLElement | null = null;
  #observer: ResizeObserver | null = null;
  /** What the ink plate was last seated on, so a re-measure that finds nothing moved leaves a glide alone. */
  #seated = "";

  connectedCallback() {
    this.#current = this.querySelector<HTMLElement>("[data-current-plate]");
    this.#hover = this.querySelector<HTMLElement>("[data-hover-plate]");

    this.#sync();

    // A late font or a resize moves the links the plate was measured from.
    this.#observer = new ResizeObserver(this.#sync);
    this.#observer.observe(this);

    document.addEventListener("astro:before-swap", this.#onBeforeSwap);
    document.addEventListener("astro:after-swap", this.#onAfterSwap);

    // A tap fires pointerover with no leave to answer it, so touch gets no hover plate.
    if (canHoverQuery().matches) {
      this.addEventListener("pointerover", this.#onOver);
      this.addEventListener("pointerleave", this.#onLeave);
    }
  }

  disconnectedCallback() {
    this.#observer?.disconnect();
    this.#observer = null;
    document.removeEventListener("astro:before-swap", this.#onBeforeSwap);
    document.removeEventListener("astro:after-swap", this.#onAfterSwap);
    this.removeEventListener("pointerover", this.#onOver);
    this.removeEventListener("pointerleave", this.#onLeave);
    this.#current = null;
    this.#hover = null;
  }

  get #links() {
    return Array.from(this.querySelectorAll<HTMLElement>("a"));
  }

  get #currentLink() {
    return this.querySelector<HTMLElement>('a[aria-current="page"]');
  }

  // A track scrolled away, or hidden below `lg`, has no pill for the reader to follow.
  get #isOnScreen() {
    const box = this.getBoundingClientRect();

    return box.width > 0 && box.bottom > 0 && box.top < window.innerHeight;
  }

  #sync = () => {
    const plate = this.#current;
    const link = this.#currentLink;

    if (!plate) {
      return;
    }

    // No current page (a legal page, the not-found page): no plate.
    plate.hidden = !link;

    const at = link ? measure(link) : null;
    const measured = at ? `${at.left} ${at.width}` : "";

    if (link && measured !== this.#seated) {
      seat(plate, link);
    }

    this.#seated = measured;
    this.dataset.ready = "";
  };

  // The swap replaces this track, so the one that takes its place is told where the pill was.
  #onBeforeSwap = () => {
    const link = this.#currentLink;

    departedIndex = link && this.#isOnScreen ? this.#links.indexOf(link) : null;
  };

  // After the swap, not on connect: the router has scrolled the page by now, so on screen is what the reader sees.
  #onAfterSwap = () => {
    const from = departedIndex === null ? undefined : this.#links[departedIndex];
    const to = this.#currentLink;
    const plate = this.#current;

    departedIndex = null;

    if (!from || !to || !plate || from === to || !this.#isOnScreen) {
      return;
    }

    seat(plate, from);
    place(plate, to);

    if (prefersReducedMotion()) {
      return;
    }

    // Each label starts in the other's colour, so the two change in step with the pill's travel.
    const [arriving, leaving] = [getComputedStyle(to).color, getComputedStyle(from).color];

    from.animate([{ color: arriving }, { color: leaving }], { duration: LABEL_MS, easing: CSS_EASING });
    to.animate([{ color: leaving }, { color: arriving }], { duration: LABEL_MS, easing: CSS_EASING });
  };

  #onOver = (event: PointerEvent) => {
    const plate = this.#hover;
    const link = (event.target as Element | null)?.closest<HTMLElement>("a");

    if (!plate) {
      return;
    }

    if (!link || link.getAttribute("aria-current") === "page") {
      delete plate.dataset.on;
      return;
    }

    if (plate.dataset.on === undefined) {
      seat(plate, link);
    } else {
      place(plate, link);
    }

    plate.dataset.on = "";
  };

  #onLeave = () => {
    delete this.#hover?.dataset.on;
  };
}

if (!customElements.get("nav-track")) {
  customElements.define("nav-track", NavTrackElement);
}
