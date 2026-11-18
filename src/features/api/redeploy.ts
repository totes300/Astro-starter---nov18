// The Studio's Redeploy site route: dispatches the deploy workflow on `main`. The gate and the call are injected so a
// test can prove the order. See docs/deployment.md#the-redeploy-site-button.

import { apiErrorResponse, internalErrorResponse, privateJson } from "~/features/api/errors";

const DISPATCH_TIMEOUT_MS = 10_000;

/** The deploy workflow only deploys `main`, so a dispatch always names it. */
const DISPATCH_REF = "main";

/** GitHub's `owner/repo` shape, so the value can only ever name a repository on `api.github.com`. */
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export type RedeploySteps = {
  authorize: (request: Request) => Promise<Response | null>;
  /** `owner/repo`, passed by the deploy workflow on every deploy. */
  repository: string | undefined;
  /** A fine-grained GitHub token that can run this repository's Actions. */
  token: string | undefined;
  post: (url: string, init: RequestInit) => Promise<Response>;
};

function isRepository(value: string): boolean {
  const name = value.split("/")[1];

  return REPOSITORY_PATTERN.test(value) && name !== "." && name !== "..";
}

export function dispatchUrl(repository: string): string {
  return `https://api.github.com/repos/${repository}/actions/workflows/deploy.yml/dispatches`;
}

/** The error's name and network code only: its message could quote the request. */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return "[redeploy] The workflow dispatch failed.";
  }

  const code: unknown = typeof error.cause === "object" && error.cause !== null ? Reflect.get(error.cause, "code") : undefined;

  return `[redeploy] The workflow dispatch failed: ${error.name}${typeof code === "string" ? ` (${code})` : ""}.`;
}

/** Reads no body, so nothing a caller sends can steer the dispatch. */
export async function handleRedeploy(request: Request, steps: RedeploySteps): Promise<Response> {
  const denied = await steps.authorize(request);

  if (denied) {
    return denied;
  }

  if (!steps.token || !steps.repository) {
    return apiErrorResponse(500, {
      error: "Redeploy is not configured.",
      code: "deploy_not_configured",
      hint: "Set DEPLOY_GITHUB_TOKEN on the Worker and deploy through the workflow, which passes DEPLOY_REPOSITORY.",
    });
  }

  if (!isRepository(steps.repository)) {
    console.error("[redeploy] DEPLOY_REPOSITORY is not an owner/repo name.");

    return apiErrorResponse(500, {
      error: "Redeploy is misconfigured.",
      code: "deploy_misconfigured",
      hint: "DEPLOY_REPOSITORY must be owner/repo, as the deploy workflow passes it.",
    });
  }

  try {
    const response = await steps.post(dispatchUrl(steps.repository), {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${steps.token}`,
        "content-type": "application/json",
        "user-agent": "redeploy-site",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ ref: DISPATCH_REF }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    await response.body?.cancel();

    if (!response.ok) {
      console.error(`[redeploy] GitHub answered the workflow dispatch with ${response.status}.`);

      return apiErrorResponse(502, {
        error: "GitHub refused to start the deploy.",
        code: "deploy_rejected",
        hint: "Check that DEPLOY_GITHUB_TOKEN has not expired and can still run this repository's Actions.",
      });
    }

    return privateJson({ ok: true });
  } catch (error) {
    return internalErrorResponse(
      describeFailure(error),
      { error: "Could not reach GitHub.", code: "deploy_unreachable", hint: "Try again in a moment." },
      502
    );
  }
}
