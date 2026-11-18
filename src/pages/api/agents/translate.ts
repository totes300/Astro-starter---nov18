import type { APIRoute } from "astro";
import { createAgentClient } from "~/features/agents/agent-client";
import {
  answerAction,
  deployedSchemaCheck,
  isSwitchedOff,
  MAX_BODY_BYTES,
  parsePlanQuery,
  parseTranslateAction,
  readPlan,
  SWITCHED_OFF,
  type TranslateDeps,
} from "~/features/agents/translate";
import { authorizeStudioRequest } from "~/features/api/auth";
import { apiErrorResponse, internalErrorResponse, privateJson } from "~/features/api/errors";
import { PUBLIC_SANITY_STUDIO_BASE_PATH, PUBLIC_SITE_URL } from "~/lib/env";
import { FUNCTION_CAP_MS } from "~/lib/function-cap";
import { IS_I18N_ENABLED } from "~/sanity/i18n";
import { sanityEditClient } from "../../../sanity/lib/client";

// Studio-triggered "Translate with AI": a free plan (GET) and one action per POST, one billed call at most.
export const prerender = false;

/** The extract the deployed schema must match, loaded only when a plan or a pair checks it; as JSON, a build minifies it. */
// biome-ignore lint/style/noRestrictedImports: the generated extract sits at the root, which no alias reaches.
const loadLocalSchema = async (): Promise<unknown> => (await import("../../../../sanity-schema.json")).default;

const NOT_ENABLED = { error: "Translation needs a second language in LOCALES.", code: "i18n_disabled" };

/** Per Sanity call, so a stalled read or write fails the request instead of holding it to the function cap. */
const EDIT_CALL_TIMEOUT_MS = 10_000;

const client = sanityEditClient.withConfig({ timeout: EDIT_CALL_TIMEOUT_MS });

function agentDeps(request: Request, deadline: number): TranslateDeps {
  return {
    client,
    agentClient: createAgentClient(client),
    signal: request.signal,
    schemaCheck: () => deployedSchemaCheck(client, loadLocalSchema),
    siteUrl: PUBLIC_SITE_URL,
    deadline,
    studioPaths: [PUBLIC_SANITY_STUDIO_BASE_PATH],
  };
}

export const GET: APIRoute = async ({ request, url }) => {
  const denied = await authorizeStudioRequest(request);

  if (denied) {
    return denied;
  }

  if (!IS_I18N_ENABLED) {
    return apiErrorResponse(404, NOT_ENABLED);
  }

  const parsed = parsePlanQuery(url.searchParams);

  if (!parsed.ok) {
    return apiErrorResponse(400, { error: parsed.error, code: "bad_input" });
  }

  try {
    if (await isSwitchedOff(client)) {
      return apiErrorResponse(404, SWITCHED_OFF);
    }

    const plan = await readPlan(client, parsed.value, { loadLocalSchema });

    return privateJson(plan);
  } catch (error) {
    return internalErrorResponse(error, {
      error: "The translation plan could not be read. Try again in a moment.",
      code: "internal_error",
    });
  }
};

export const POST: APIRoute = async ({ request }) => {
  // Counted from here, not from the AI call: everything before and after it shares the one cap.
  const deadline = Date.now() + FUNCTION_CAP_MS;
  const denied = await authorizeStudioRequest(request);

  if (denied) {
    return denied;
  }

  if (!IS_I18N_ENABLED) {
    return apiErrorResponse(404, NOT_ENABLED);
  }

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return apiErrorResponse(400, { error: "The request body is too large.", code: "bad_input" });
  }

  const parsed = parseTranslateAction(await request.text().catch(() => ""));

  if (!parsed.ok) {
    return apiErrorResponse(400, { error: parsed.error, code: "bad_input" });
  }

  const answer = await answerAction(agentDeps(request, deadline), parsed.value);

  return privateJson(answer.body, { status: answer.status });
};
