// The one place an Agent Actions client is built, so every metered call shares its API version and its timeout.

import type { SanityClient } from "@sanity/client";
import { FUNCTION_CAP_MS } from "~/lib/function-cap";
import { SANITY_AGENT_API_VERSION } from "~/sanity/constants";

/** Under the function cap, so a slow call answers a structured timeout instead of the host's 504 page. */
export const AGENT_TIMEOUT_MS = FUNCTION_CAP_MS - 5_000;

/** Pass the route's write client (`sanityEditClient`). */
export function createAgentClient(base: SanityClient): SanityClient {
  return base.withConfig({ apiVersion: SANITY_AGENT_API_VERSION, timeout: AGENT_TIMEOUT_MS });
}

/** What one call may use when its request must answer by `deadline` and keep `reserveMs` for the work after it. */
export function agentCallBudget(deadline: number, reserveMs: number, now: number = Date.now()): number {
  return Math.min(AGENT_TIMEOUT_MS, deadline - now - reserveMs);
}
