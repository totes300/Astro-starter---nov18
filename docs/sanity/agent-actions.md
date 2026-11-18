# Agent Actions (Sanity AI generation)

This project generates content with AI using **Sanity Agent Actions**, the developer API on `@sanity/client` (`client.agent.action.*`). The first use is the AI-drafted [`/llms.txt`](../features/llms-txt.md); [automatic alt text](../features/auto-alt-text.md) followed.
[Translate with AI](../features/ai-translation.md) uses it too.
This page documents the reusable pattern so you can add more AI-generated fields without re-deriving the wiring.

## Which Sanity AI surface this is

Sanity ships three AI surfaces; this repo uses the last one in code:

- **Content Agent**: the conversational assistant in the Sanity Dashboard. Project-wide, human-driven, not embeddable.
- **AI Assist** (`@sanity/assist`): a Studio plugin that adds inline AI and custom field actions. Requires the plugin and a paid plan, and field actions that write need a deployed `schemaId`.
- **Agent Actions**: the programmatic API. We call it from a server endpoint. This is what powers the Generate buttons in this codebase.

Within Agent Actions:

| Action      | Writes to a document?         | Needs `schemaId`? | Used here |
| ----------- | ----------------------------- | ----------------- | --------- |
| `generate`  | yes (structured fields)       | yes               | no        |
| `transform` | yes (rewrites fields)         | yes               | **yes** (image descriptions) |
| `prompt`    | no (returns a string or JSON) | no                | **yes**   |
| `translate` | yes (a translated document)   | yes               | **yes** (`noWrite`, see [Translate with AI](../features/ai-translation.md)) |

**Why `prompt`.** It returns Markdown text we fully control, needs no deployed schema, needs no extra plugin or plan tier beyond AI being enabled, and reuses the existing `SANITY_API_EDIT_TOKEN`. We perform the write ourselves with `onChange(set(...))`, which matches the established `SeoImageInput` precedent (custom input button calls a same-origin endpoint, then writes the result). It also keeps the GROQ context and output format in our code instead of in Studio configuration.

**Where `transform` comes in.** Describing an image (`operation: {type: "image-description"}`) is a Transform target operation, so [automatic alt text](../features/auto-alt-text.md) uses `transform` with `noWrite: true` against a scratch document and performs the asset patch itself. Transform is schema-aware, which is why that feature needs a deployed schema (`npm run sanity:schema-deploy`) while the `prompt`-based features do not.

## One client factory

Every Agent Actions client is built by `createAgentClient(sanityEditClient)`
(`src/features/agents/agent-client.ts`), never with `withConfig({ apiVersion: "vX" })` by hand. It
returns the route's client with two settings on top:

- **`apiVersion: "vX"`** (`SANITY_AGENT_API_VERSION`), the only channel Agent Actions are on.
- **A 55 s timeout** (`AGENT_TIMEOUT_MS`), under the 60 s function cap (`src/lib/function-cap.ts`), so a
  slow call answers a structured `timeout` instead of the host's 504 page. A route that works before and
  after its call shortens it to what the request has left: Translate with AI and automatic alt text
  (`describeTimeout()`) pass `agentCallBudget(deadline, reserve)` as the call's `timeout`, counted from
  when the request arrived.

Both make each AI call through `spendOneCredit` (`src/features/agents/translate/credit.ts`): an AI request
reserved in the daily ledger first (`src/features/agents/ai-ledger.ts`), refused at Settings >
Translations' **AI request limit per day**, refunded only when Sanity refused the call before doing any work.
A new route that calls Sanity AI should do the same, so "AI requests today" stays the whole project's count.

There is one path, the same in `astro dev` and in a build: every call reaches Sanity AI and uses
your Sanity organization's AI credits, so a local Studio counts toward its AI usage exactly as a deployment
does. Check usage in your organization settings. No test
reaches Sanity AI: `sanity/test-support/fake-content-lake.ts` answers the client in memory, the one
tripwire in `sanity/test-support/agent-actions.ts` throws on any `/agent/action/` request, and a test that
needs an answer stubs that one action (`agentActionOf()`).

## The pattern: button to endpoint to onChange

```
Custom input (Studio)            Server endpoint
┌──────────────────────┐  POST   ┌────────────────────────────────┐
│ field + Generate ────┼────────▶│ 1. authorizeStudioRequest(req) │
│                      │         │ 2. fetch context via GROQ      │
│ onChange(set(text)) ◀┼─────────┤    (edit token, published)     │
└──────────────────────┘ { text }│ 3. agent.action.prompt(...)    │
                                 └────────────────────────────────┘
```

Files for the llms.txt implementation, reuse them as the template:

| Role                               | File                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Custom input button                | [`sanity/inputs/generate-text-input.tsx`](../../sanity/inputs/generate-text-input.tsx) (`LlmsTxtInput`)                                                                |
| Endpoint path (config seam)        | [`sanity/config.ts`](../../sanity/config.ts), `endpoints.generateLlmsTxt`                                                                   |
| GROQ context query                 | [`src/features/agents/query.ts`](../../src/features/agents/query.ts), `LlmsTxtInventoryQuery`                                               |
| Server endpoint (the Agent Action) | [`src/pages/api/agents/llms-txt.ts`](../../src/pages/api/agents/llms-txt.ts), served at `/api/agents/llms-txt` |

The other Agent Actions routes are `/api/agents/image-alt-text` (`transform`) and `/api/agents/translate` (`translate` and `prompt`).

## Requirements

- **Sanity AI / Agent Actions enabled** on the project. It uses your Sanity organization's AI credits. If it is off, the endpoint answers a fixed error (Sanity's message goes to the server log) and the editor can author the field by hand.
- **`SANITY_API_EDIT_TOKEN`** (see `src/lib/env.ts` / `.env.example`). The endpoint uses it server-side; the read-only `SANITY_API_VIEW_TOKEN` cannot run Agent Actions.
- **API version `vX`.** Agent Actions are only available on the experimental `vX` channel, so the agent client is created with `apiVersion: "vX"` even though the rest of the app uses a dated version.

## Add a new AI-generated field (recipe)

Using the llms.txt feature as the reference:

1. **Schema field.** Add the field and attach a custom input with `components: { input: MyInput }`. Group it sensibly on its document (the llms.txt field is the `llms` object on the Agents tab of the Settings singleton, `siteSettings`). See [Schema and Content Model](./schema-and-content-model.md).
2. **Custom input.** Configure a new input with `createGenerateTextInput` in `sanity/inputs/generate-text-input.tsx`. It renders `props.renderDefault(props)` plus a button, POSTs to the endpoint, and writes the result with `onChange(set(text))`. Read sibling fields with `useFormValue([...])` if the prompt needs them.
3. **Endpoint path.** Add it to `endpoints` in `sanity/config.ts` (the Studio reads endpoints from there for portability; do not hardcode `/api/...` in the input).
4. **Context query.** Write a `defineQuery` in `src/features/<feature>/query.ts` that returns exactly what the model needs. Keep projections small. Run `npm run sanity:typegen` so the result type exists.
5. **Server endpoint.** Copy `src/pages/api/agents/llms-txt.ts` to a new file under `src/pages/api/`; Astro's file-based routing registers it automatically:
   - Guard with `const denied = await authorizeStudioRequest(request); if (denied) return denied;` from `~/features/api/auth`, and call it from the input with `useStudioFetch()` (`sanity/lib/studio-fetch.ts`). See [Studio API auth](../features/studio-api-auth.md).
   - Read and write through `sanityEditClient` from `src/sanity/lib/client.ts` (edit token, live API, published perspective unless a call overrides it); never build a second client in app code (see [Fetching, GROQ, and Types](./fetching-groq-and-types.md#sanity-client-policy)).
   - Fetch context with `.withConfig({ perspective: 'published' })` when the output becomes public (llms.txt does), so drafts and draft-only `noIndex` or password flags never shape it. Use `drafts` only when the result stays private until an editor reviews it against the same draft.
   - Build any URLs or IDs in code and pass them as `instructionParams` (type `constant`), so the model cannot invent them.
   - Build the agent client with `createAgentClient(sanityEditClient)` (see [One client factory](#one-client-factory)), then call `agentClient.agent.action.prompt({ instruction, instructionParams, temperature })`.
   - Return `privateJson({ text })`, and errors with `apiErrorResponse(status, { error, code })` or, in the `catch`, `internalErrorResponse(error, { error, code })` (all from `~/features/api/errors`). Both send `cache-control: private, no-store`; the internal one logs the original error and answers fixed text, so upstream details never reach the browser.
6. **Verify.** Run `npm run sanity:typegen`, then `npm run check`.

## Instruction tips

- Pass data as `instructionParams` referenced with `$name` in the instruction. Supported types: `constant`, `field`, `document`, and `groq` (see the [Sanity instructions docs](https://www.sanity.io/docs/agent-actions/instructions)). This repo prefers building a `constant` payload in code for full control.
- Keep instructions and context within model limits; trim large bodies before sending.
- Use a low `temperature` (the llms.txt endpoint uses `0.2`) for predictable, format-stable output.
- For `prompt`, set `format: "json"` and include the word "JSON" plus an example shape when you need structured output instead of text.

## Pitfalls

- **Always guard the endpoint.** Without `authorizeStudioRequest`, anonymous callers can spend AI credits. Never gate on `Origin` or `Referer`: they are request headers any script sets.
- **Never trust model URLs or IDs.** Construct them in code and pass them in.
- **`prompt` is an experimental Sanity API.** Keep each call isolated in one endpoint so a future shape change is contained.
- **Drafts vs published.** Generating under the `drafts` perspective reflects unpublished edits, which can list URLs that are not live yet and evaluates `noIndex` and password flags on draft values. Anything that ends up public (llms.txt) generates from `published`; both its generate and serve endpoints read published only.
- **Never return upstream error text.** Agent Action and client errors can carry request details. Log them and answer a fixed message.

## Related

- [llms.txt and AI agents](../features/llms-txt.md): the first feature built on this pattern.
- [Fetching, GROQ, and Types](./fetching-groq-and-types.md): query and typegen conventions.
- [Revalidation and Caching](./revalidation-and-caching.md): how the served output reaches the live site.
- Sanity docs: [Agent Actions](https://www.sanity.io/docs/agent-actions), [Prompt quick start](https://www.sanity.io/docs/agent-actions/prompt-quickstart).
