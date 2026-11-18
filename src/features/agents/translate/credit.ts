import type { SanityClient } from "@sanity/client";
import { AGENT_TIMEOUT_MS, agentCallBudget } from "~/features/agents/agent-client";
import { refundCredit, reserveCredit } from "~/features/agents/ai-ledger";
import { AGENT_ERROR_MESSAGES, type AgentError, agentErrorLog, classifyAgentError } from "~/sanity/ai-translation/agent-errors";
import type { CreditsToday } from "~/sanity/ai-translation/wire";
import { type TranslateDeps, WRITE_RESERVE_MS } from "./shared";

/** Below this for the AI call, the request answers `out_of_time` for free: a new one has the whole cap. */
export const MIN_AGENT_CALL_MS = 10_000;

/** `credits` counts this call while it is reserved, and leaves it out once refunded. */
export type CreditSpend<T> =
  | { ok: true; value: T; credits: CreditsToday }
  | { ok: false; reason: "out_of_time"; credits?: CreditsToday }
  | { ok: false; reason: "daily_cap"; credits: CreditsToday }
  | { ok: false; reason: "agent_error"; error: AgentError; credits: CreditsToday; ranMs: number };

type CreditDeps = Pick<TranslateDeps, "client" | "agentClient" | "deadline" | "now" | "onBilledCall">;

/** What the AI call may use now; without a deadline (a test, a script) the client's own timeout. */
function callBudget(deps: Pick<TranslateDeps, "deadline">): number {
  return deps.deadline === undefined ? AGENT_TIMEOUT_MS : agentCallBudget(deps.deadline, WRITE_RESERVE_MS);
}

async function giveBack(client: SanityClient, credits: CreditsToday): Promise<void> {
  await refundCredit(client, { day: credits.day }).catch((refundError: unknown) => console.error(refundError));
}

/** One billed call: its credit reserved first, refunded only when the call never started or did no work. */
export async function spendOneCredit<T>(
  deps: CreditDeps,
  options: {
    maxCreditsPerDay: number;
    label: string;
    /** A caller with its own reserve (alt text): what the call may use now, and the least it starts with. */
    budget?: () => number;
    minCallMs?: number;
  },
  call: (agent: SanityClient) => Promise<T>
): Promise<CreditSpend<T>> {
  const { client } = deps;
  const now = deps.now ?? (() => new Date());
  const budgetNow = options.budget ?? (() => callBudget(deps));
  const minCallMs = options.minCallMs ?? MIN_AGENT_CALL_MS;

  if (budgetNow() < minCallMs) {
    return { ok: false, reason: "out_of_time" };
  }

  const reservation = await reserveCredit(client, { maxCreditsPerDay: options.maxCreditsPerDay, now: now() });
  const credits = { day: reservation.day, used: reservation.used, max: reservation.max };

  if (!reservation.reserved) {
    return { ok: false, reason: "daily_cap", credits };
  }

  const budget = budgetNow();

  // The ledger can take a few contended rounds: re-checked, so a call is never started that the cap would cut off.
  if (budget < minCallMs) {
    await giveBack(client, credits);

    return { ok: false, reason: "out_of_time", credits: { ...credits, used: credits.used - 1 } };
  }

  const startedAt = now().getTime();

  try {
    deps.onBilledCall?.();

    return { ok: true, value: await call(deps.agentClient.withConfig({ timeout: budget })), credits };
  } catch (error) {
    const classified = classifyAgentError(error);

    console.error(`[ai-translate] ${options.label}: ${agentErrorLog(error, classified)}`);

    const refunded = !classified.creditMayBeSpent;

    if (refunded) {
      await giveBack(client, credits);
    }

    return {
      ok: false,
      reason: "agent_error",
      error: classified,
      credits: refunded ? { ...credits, used: credits.used - 1 } : credits,
      ranMs: now().getTime() - startedAt,
    };
  }
}

/** The fields a failed call answers with, for a pair and a labels batch alike. */
export function agentFailure(error: AgentError, credits: CreditsToday) {
  return {
    status: "failed" as const,
    code: error.code,
    error: AGENT_ERROR_MESSAGES[error.code],
    creditSpent: error.creditMayBeSpent,
    ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    ...(error.usage ? { usage: error.usage } : {}),
    credits,
  };
}
