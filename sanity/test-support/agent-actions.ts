// The one guard every test client carries: an Agent Action spends real AI credits, so no test may send one.

import type { RequestHandler } from "@sanity/client";

/** `/v<version>/agent/action/<name>/<dataset>`: the path every Agent Action is sent to. */
const AGENT_ACTION_PATH = /\/agent\/action\/([^/?#]*)/;

/** The Agent Action a request URL calls (`translate`, `prompt`, `transform`), or null for any other request. */
export function agentActionOf(url: string | undefined): string | null {
  return AGENT_ACTION_PATH.exec(url ?? "")?.[1] ?? null;
}

/** Thrown for an Agent Action no test stubbed: sent, it would have billed. */
export class AgentActionTripwireError extends Error {
  constructor(url: string) {
    super(`Tripwire: a test reached a billed Agent Action (${url}).`);
    this.name = "AgentActionTripwireError";
  }
}

/** Give every test client this handler: any other request goes on to `next`, an Agent Action throws before it is sent. */
export const agentActionTripwire: RequestHandler = (request, next) => {
  const url = String((request as { url?: unknown; uri?: unknown }).url ?? (request as { uri?: unknown }).uri ?? "");

  if (agentActionOf(url) !== null) {
    return Promise.reject(new AgentActionTripwireError(url));
  }

  return next(request);
};
