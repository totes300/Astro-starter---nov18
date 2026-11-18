import type { APIRoute } from "astro";
import { authorizeStudioRequest } from "~/features/api/auth";
import { handleRedeploy } from "~/features/api/redeploy";
import { DEPLOY_GITHUB_TOKEN, DEPLOY_REPOSITORY } from "~/lib/env";

// The Studio's Redeploy site button: dispatches the deploy workflow, so redirect edits (read at build) go live.
export const prerender = false;

export const POST: APIRoute = ({ request }) =>
  handleRedeploy(request, {
    authorize: authorizeStudioRequest,
    repository: DEPLOY_REPOSITORY,
    token: DEPLOY_GITHUB_TOKEN,
    post: (url, init) => fetch(url, init),
  });
