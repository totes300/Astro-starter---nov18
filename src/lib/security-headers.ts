// The headers every response carries, built once from config. Each origin and why it is listed:
// docs/features/security-headers.md

export type SecurityHeaderConfig = {
  siteUrl: string;
  sanityProjectId: string | undefined;
  isDev: boolean;
};

export type SecurityHeaders = {
  /** Sent on every route, the Studio included. */
  always: [string, string][];
  /** The Report-Only policy, for every route but the Studio. */
  reportOnly: string;
};

/** `'self'` plus the site's apex and `www` twin, so a Studio browsed on one previews pages served from the other. */
export function frameAncestors(siteUrl: string): string {
  const { protocol, host } = new URL(siteUrl);
  const apex = host.replace(/^www\./, "");

  return ["'self'", `${protocol}//${apex}`, `${protocol}//www.${apex}`].join(" ");
}

function serializePolicy(policy: Record<string, string[]>): string {
  return Object.entries(policy)
    .map(([directive, sources]) => [directive, ...new Set(sources)].join(" "))
    .join("; ");
}

export function reportOnlyPolicy({ sanityProjectId, isDev }: SecurityHeaderConfig): string {
  const sanityApi = sanityProjectId
    ? [
        `https://${sanityProjectId}.api.sanity.io`,
        `https://${sanityProjectId}.apicdn.sanity.io`,
        `wss://${sanityProjectId}.api.sanity.io`,
      ]
    : [];

  return serializePolicy({
    "default-src": ["'self'"],
    // Turnstile's script and its challenge frame, which every form loads at its first focus.
    "script-src": [
      "'self'",
      "'unsafe-inline'",
      "'wasm-unsafe-eval'",
      "https://challenges.cloudflare.com",
      "https://cloud.umami.is",
    ],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https://cdn.sanity.io", "https://image.mux.com"],
    "font-src": ["'self'", "data:"],
    "media-src": ["'self'", "blob:", "https:"],
    "connect-src": [
      "'self'",
      "https://cloud.umami.is",
      "https://gateway.umami.is",
      "https://cdn.sanity.io",
      ...sanityApi,
      "https://api.sanity.io",
      "https://www.sanity.io",
      "https://stream.mux.com",
      "https://*.mux.com",
      "https://*.litix.io",
      "https://unpkg.com",
      "https://cdn.jsdelivr.net",
      ...(isDev ? ["ws:"] : []),
    ],
    "frame-src": ["'self'", "https://challenges.cloudflare.com"],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
  });
}

export function securityHeaders(config: SecurityHeaderConfig): SecurityHeaders {
  return {
    always: [
      ["X-Content-Type-Options", "nosniff"],
      ["Referrer-Policy", "strict-origin-when-cross-origin"],
      ["Permissions-Policy", "camera=(), microphone=(), geolocation=()"],
      ["X-Frame-Options", "SAMEORIGIN"],
      ["Content-Security-Policy", `frame-ancestors ${frameAncestors(config.siteUrl)}`],
    ],
    reportOnly: reportOnlyPolicy(config),
  };
}
