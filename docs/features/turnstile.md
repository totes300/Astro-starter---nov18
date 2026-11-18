# Turnstile

Every form on the site proves the visitor is a person with [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) before anything is stored or sent. It is the forms' only spam check: there is no honeypot and no timing check. The public form endpoint (`/api/contact-form`) verifies the token on every post.

## How it works

1. **The script loads late.** `FormElement` (`src/features/forms/form-element.ts`) fetches Turnstile's script on the form's first focus, not with the page, so a page that nobody fills in never loads it (`loadTurnstile` in `src/features/turnstile/client.ts`).
2. **One token per submit.** When the form passes its own validation, `FormElement` renders a widget into the form's `[data-human-check]` slot, waits for the token and removes the widget. Tokens are single use and expire after five minutes, so a retry after a failed submit gets a fresh one. The token travels as `cf-turnstile-response` (`TURNSTILE_TOKEN_FIELD`), Turnstile's own field name, hyphenated so no form field can shadow it.
3. **Most visitors see nothing.** The widget runs in Managed mode with `appearance: "interaction-only"`: Cloudflare decides silently for almost everyone, and only a visitor it is unsure of gets a checkbox, in the slot above the consent and submit row, in the page's language. A check that neither answers nor asks within 15 seconds counts as failed, so a submit never hangs.
4. **The endpoint verifies before anything else.** `verifyTurnstile` (`src/features/turnstile/verify.ts`) sends the token, the secret and the visitor's IP to Cloudflare's siteverify API and accepts it only when Cloudflare confirms it **and** it was minted for this form's action (`contact-form`, `CONTACT_FORM_TURNSTILE_ACTION` in `validate-contact-form.ts`) on the host the post arrived at. A token from another site, another action or a replay is refused. Siteverify that does not answer within 5 seconds is a refusal too.
5. **No secret, no forms.** With `TURNSTILE_SECRET_KEY` unset the endpoint refuses every post as unavailable (`503`, `form.closed`) and logs why. A submission is never stored or mailed unchecked.

A visitor the check refuses sees `form.humanCheckFailed` in the page's language ("We could not confirm you are a person. Please try again."), rendered by the server into the form's `data-human-check-message`, so no dictionary ships to the browser. `src/features/forms/form-endpoints.test.ts` fails on a form endpoint that does not call `verifyTurnstile` after the request guard and before the body is validated or written, or that does not refuse every post while the secret is unset.

## Keys

| Variable | Where | Value |
| --- | --- | --- |
| `PUBLIC_TURNSTILE_SITE_KEY` | `.env` locally; the build's environment in production | The widget's site key. Public: it is in every form's markup. Required, so a build without it fails |
| `TURNSTILE_SECRET_KEY` | `.env` locally; a secret on the Worker (`npx wrangler secret put TURNSTILE_SECRET_KEY`) | The widget's secret key. Only the Worker reads it, at runtime |

Locally, `.env.example` ships Cloudflare's always-pass test keys (`1x00000000000000000000AA` and `1x0000000000000000000000000000000AA`). Cloudflare's test answers carry no action and no real hostname, so `verifyTurnstile` accepts a test secret on `success` alone; every other secret has to match the action and the host. Other [test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) force a failure or an interactive challenge, which is how to see the refusal and the checkbox locally.

The build reads the site key from the `.env` files, never the shell, so a production build by hand needs the real key in `.env.local` alongside the site URL (see [Deployment](../deployment.md)).

## The widget

One widget in the Cloudflare dashboard (Application security, Turnstile) serves the site. Name it `<brand>-prod-forms`, in Managed mode, and list every hostname the forms run on: the Worker's `workers.dev` address and the custom domain with its `www` twin. A hostname that is not on the list makes every check fail there, so a new domain goes on the widget **before** it is pointed at the Worker.

The CSP allows `https://challenges.cloudflare.com` in `script-src` and `frame-src` (`src/lib/security-headers.ts`), which is all Turnstile needs.

## Rate limiting

Turnstile decides whether a visitor is a person, not how often one may post. Every accepted contact form submission writes a Sanity document with the edit token and sends one email per configured recipient. Add a Cloudflare WAF rate limiting rule on the zone:

| Field     | Value                                                                    |
| --------- | ------------------------------------------------------------------------ |
| Condition | Request method is `POST` **and** request path ends with `contact-form`   |
| Action    | Rate limit, fixed window, keyed on IP, respond `429`                     |
| Limit     | 30 requests per 600 seconds                                              |

WAF rules apply without a redeploy. Size the limit from real use: a visitor who fixes a field and resends uses two or three. Add every form endpoint you add to the same rule, by the end of its path.

"Ends with" rather than "equals": the endpoint itself refuses every spelling of its path other than the exact `/api/contact-form` (`/api/contact-form/`, `/api//contact-form`, `/api/contact%2Dform`; see [Forms](./forms.md#the-endpoint)), but the URL parser resolves dot segments (also written `%2e`) and turns a backslash into a slash before the endpoint sees the path. So `/api/x/../contact-form` or `/api\contact-form` reaches the endpoint as the exact path, and an "equals" rule that reads the path as sent would never count it. Dot segments and backslashes can only come before the last segment of a path the endpoint accepts, so every post it reads ends with the literal `contact-form`, and the rule counts each one. A language prefix cannot be used to step around the rule either: `/it/api/contact-form` answers 404 rather than reaching the endpoint (see [Basic Authentication](./basic-auth.md)).

Never give a webhook path (`/api/revalidate`, `/api/cache-purge`) a rate limit of its own: a burst of publishes can exceed it, and a webhook answered with `429` leaves published content stale.

### Preview endpoints

`/api/draft-mode/enable` needs a rule of its own, which lives with draft mode (trimming the forms feature keeps it): see [Draft Mode and Visual Editing](../sanity/draft-mode-and-visual-editing.md#rate-limit-the-handshake).

## What the endpoint refuses

- A post without a token, with a token Cloudflare refuses, or with one minted for another action or host
- Every post while `TURNSTILE_SECRET_KEY` is unset
- A body that is not the multipart post the form sends, or a post to a spelling of the endpoint's path that does not resolve to the exact one ([Forms](./forms.md#the-endpoint))

A browser posts natively, without a token, when the element's script has not loaded yet or JavaScript is off, and the endpoint refuses that post. So the form never makes one: `SubmitButton` ships `disabled`, `FormElement` enables it when it upgrades, and a `<noscript>` line tells a no-JS visitor the form needs JavaScript (see [Forms](./forms.md#the-element)).

## Adding a form

A new form gets the check by extending `FormElement` and rendering the slot in its markup:

```astro
<div data-human-check data-site-key={PUBLIC_TURNSTILE_SITE_KEY} data-action="my-form" class="empty:hidden" />
```

with `data-human-check-message={strings.humanCheckFailed}` on the element. Its endpoint calls `verifyTurnstile` with the same action right after `readFormPost`, and refuses every post while the secret is unset.
