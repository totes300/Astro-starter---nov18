// The server half: Cloudflare confirms a token was minted for this action on this host. Tokens are single use.

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const VERIFY_TIMEOUT_MS = 5000;

/** Cloudflare's longest token is 2048 characters; anything bigger is not a token and is never sent on. */
const MAX_TOKEN_LENGTH = 2048;

type SiteverifyResult = { success: boolean; action?: string; hostname?: string; "error-codes"?: string[] };

export type TurnstileCheck = {
  token: FormDataEntryValue | null;
  secret: string;
  action: string;
  hostname: string;
  ip?: string;
  fetch?: typeof fetch;
};

/** Cloudflare's test secrets answer without an action or the real hostname, so only `success` is theirs to give. */
export const isTurnstileTestSecret = (secret: string) => /^[123]x0{20,}/.test(secret);

/** True only when Cloudflare confirms the token; every other outcome, a timeout included, is a refusal. */
export async function verifyTurnstile({ token, secret, action, hostname, ip, fetch: send = fetch }: TurnstileCheck) {
  if (typeof token !== "string" || token === "" || token.length > MAX_TOKEN_LENGTH) {
    console.warn("Turnstile refused: no token was posted.");

    return false;
  }

  const body = new FormData();

  body.append("secret", secret);
  body.append("response", token);

  if (ip) {
    body.append("remoteip", ip);
  }

  try {
    const response = await send(SITEVERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
    const result = (await response.json()) as SiteverifyResult;

    if (!result.success) {
      console.warn("Turnstile refused:", result["error-codes"] ?? []);

      return false;
    }

    if (isTurnstileTestSecret(secret)) {
      return true;
    }

    if (result.action !== action || result.hostname !== hostname) {
      console.warn("Turnstile refused: the token was minted for another action or host.", {
        action: result.action,
        hostname: result.hostname,
      });

      return false;
    }

    return true;
  } catch (error) {
    console.error("Turnstile could not be reached:", error);

    return false;
  }
}
