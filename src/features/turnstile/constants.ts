/** The field a form posts its token in: Turnstile's own name for it, hyphenated so no form field shadows it. */
export const TURNSTILE_TOKEN_FIELD = "cf-turnstile-response";

/** Cloudflare's published always-pass keys: what `.env.example` ships for local runs. */
export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
export const TURNSTILE_TEST_SECRET_KEY = "1x0000000000000000000000000000000AA";
