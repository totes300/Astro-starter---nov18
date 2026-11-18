/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />
/// <reference types="@sanity/astro/module" />

interface ImportMetaEnv {
  readonly PUBLIC_SITE_URL: string;
  readonly PUBLIC_SANITY_PROJECT_ID: string;
  readonly PUBLIC_SANITY_DATASET: string;
  readonly PUBLIC_SANITY_API_VERSION: string;
  readonly PUBLIC_SANITY_STUDIO_BASE_PATH: string;
  readonly PUBLIC_TURNSTILE_SITE_KEY: string;
}

declare namespace App {
  interface Locals {
    /** Set by `src/middleware.ts`: true only for a request carrying a valid signed `__draft_session`. */
    draftSession?: boolean;
    /** Set by `localeRouting` in `src/middleware.ts`; the locale the request renders in. */
    locale: import("~/sanity/i18n").Locale;
    /** The public path, prefix included: what Sanity stores in `uri.current`, so routes query by it. */
    path: string;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "animated-text": import("~/components/AnimatedText/AnimatedTextElement").AnimatedTextElement;
    "reading-text": import("~/components/ReadingText/ReadingTextElement").ReadingTextElement;
    "modal-dialog": import("~/components/Dialog/DialogElement").DialogElement;
    "author-dialog": import("./features/blog/author/AuthorDialogElement").AuthorDialogElement;
    "lenis-scroll": import("~/components/Lenis/LenisElement").LenisElement;
    "marquee-line": import("~/components/Marquee/MarqueeElement").MarqueeElement;
    "form-field": import("~/components/Form/FormFieldElement").FormFieldElement;
    "site-announcement": import("./features/site/site-announcement/SiteAnnouncementElement").SiteAnnouncementElement;
    "language-switcher": import("./features/site/LanguageSwitcher/LanguageSwitcherElement").LanguageSwitcherElement;
    "mobile-menu": import("./features/site/site-header/MobileMenuElement").MobileMenuElement;
    "nav-track": import("./features/site/site-header/NavTrackElement").NavTrackElement;
    "inner-parallax": import("~/components/InnerParallax/InnerParallaxElement") | null;
    "contact-form": import("./features/page-builder/sections/ContactFormSection/ContactFormElement").ContactFormElement;
    "rive-canvas": import("./sanity/media/RiveElement") | null;
    "video-player": import("./sanity/media/VideoPlayerElement").VideoPlayerElement;
    "sanity-image": import("./sanity/media/SanityImageElement").SanityImageElement;
  }
}
