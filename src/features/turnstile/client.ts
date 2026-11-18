// Turnstile in the browser: the script loads on a form's first focus, never with the page, and each submit
// renders one widget for one single-use token, then removes it. See docs/features/turnstile.md

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** A check that never shows a challenge and never answers is a failure, so a submit never hangs. */
const SILENT_TIMEOUT_MS = 15_000;

type TurnstileOptions = {
  sitekey: string;
  action: string;
  language: string;
  theme: "light" | "dark";
  appearance: "interaction-only";
  size: "flexible";
  callback: (token: string) => void;
  "error-callback": () => void;
  "expired-callback": () => void;
  "timeout-callback": () => void;
  "before-interactive-callback": () => void;
};

type TurnstileApi = {
  render: (container: HTMLElement, options: TurnstileOptions) => string | undefined;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

/** Starts the download once; a failed one is forgotten, so the next submit tries again. */
export function loadTurnstile(): Promise<TurnstileApi> {
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");

    script.src = SCRIPT_URL;
    script.async = true;
    script.addEventListener("load", () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile"))));
    script.addEventListener("error", () => {
      loading = null;
      script.remove();
      reject(new Error("turnstile"));
    });
    document.head.append(script);
  });

  return loading;
}

export type TurnstileRequest = { container: HTMLElement; siteKey: string; action: string; language: string };

/** Resolves with a token, or rejects when the visitor could not be confirmed. */
export async function turnstileToken({ container, siteKey, action, language }: TurnstileRequest): Promise<string> {
  const api = await loadTurnstile();
  const theme = container.closest("[data-theme]")?.getAttribute("data-theme") === "dark" ? "dark" : "light";

  return new Promise<string>((resolve, reject) => {
    let widget: string | undefined;
    let timer = 0;

    const settle = (token: string | null) => {
      window.clearTimeout(timer);

      if (widget) {
        api.remove(widget);
      }

      if (token) {
        resolve(token);
      } else {
        reject(new Error("turnstile"));
      }
    };

    timer = window.setTimeout(() => settle(null), SILENT_TIMEOUT_MS);

    widget = api.render(container, {
      sitekey: siteKey,
      action,
      language,
      theme,
      // Most visitors never see it; one Cloudflare is unsure of gets a challenge in the form instead of a silent failure.
      appearance: "interaction-only",
      size: "flexible",
      callback: (token) => settle(token),
      "error-callback": () => settle(null),
      "expired-callback": () => settle(null),
      "timeout-callback": () => settle(null),
      "before-interactive-callback": () => window.clearTimeout(timer),
    });

    if (!widget) {
      settle(null);
    }
  });
}
