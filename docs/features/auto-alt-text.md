# Automatic alt text

Images uploaded to the media library are described by Sanity AI (Agent Actions) and the result is
stored as the asset's **alternative text**. Because alt text lives on the asset rather than on each
image field, one description covers every document that uses that image, and the image fragments
already read it, in the page's language (`localizedAssetText("altText")`).
- **Turn it on:** Studio, **Settings** singleton, **Agents** tab, **Automatic alt text**.
- **Trigger:** a listener in the Studio itself, not a webhook. Nothing to configure outside this repo.
- **Backfill:** the button in that same panel, or `POST /api/agents/image-alt-text`.
- **Edit by hand:** the media browser. Editors always win; nothing overwrites existing alt text.
- **Flagged:** a media image still without alt text in the document's language shows a warning on its field ([Search and accessibility guardrails](../sanity/schema-and-content-model.md#search-and-accessibility-guardrails)).

## End-to-end flow

```
Upload in the media browser
            │
            ▼
  sanity.imageAsset created
            │  Studio listener: *[_type == "sanity.imageAsset" && !defined(altText)]
            │  (transition "appear", queued one at a time)
            ▼
┌──────────────────────────────────────────────────────────────┐
│ POST /api/agents/image-alt-text   { _id }                    │
│  0. refuse a malformed asset _id (400, no Sanity read)       │
│  1. read the Settings toggle (off -> 200, skipped)           │
│  2. work out the languages the asset still lacks             │
│  3. reserve 1 AI request in the daily ledger (refused at the │
│     day's limit), then agent.action.transform                │
│     (image-description, noWrite), once per missing           │
│     language, in order, while time is left                   │
│  4. after each one: re-read the asset, then patch that       │
│     language if it is still missing                          │
│     (sanity.imageAsset.altText)                              │
└──────────────────────────────────────────────────────────────┘
            │
            ▼
  asset->altText  ──────────▶  every document rendering that image
```

Step 0 is a format check (`isImageAssetId()` in `src/features/agents/alt-text.ts`), so a malformed `_id`
costs no Sanity read and never reaches the patch. Patching `altText` in step 4 drops the asset out of the listener's query, so the write cannot
re-trigger the listener. Step 2 repeats the check anyway, because two Studio tabs can both observe one
upload. Step 4 reads the asset again, because a description takes seconds and an editor may have
typed alt text in the meantime: that text wins (see [the patch](#one-description-per-language)).

## One description per language

With more than one language the media library stores alt text per language (`{ en, it }`, through
`mediaLocaleOptions` in `sanity/i18n-studio.ts`). The listener still only picks up an asset with no
`altText` at all: a fresh upload starts a description, and clearing one language's arm never does on
its own. Once called, the route fills **every** configured language the asset still lacks, the upload path
included:
- **What counts as missing** (`missingAltTextLocales` in `src/features/agents/alt-text.ts`): a language
  with no arm. `{}` or a partial object is outstanding. An empty arm counts as present, since an editor
  may have cleared it on purpose. A plain string written before translation is the default language's
  arm.
- **One Agent Action per missing language**, run in order by `describeLanguages`. Each run asks for the
  text "in" that language, by its name (`getLocaleTitle`, so "Italiano"). With two languages, a new image
  takes **two** descriptions, so two AI requests. Transform writes one description per target field, and the scratch
  document has one field, so each language is its own call.
- **The daily AI request ledger.** The route passes each describer a `credit`: `ledgerCredit`
  (`src/features/agents/translate/alt-text-credit.ts`) goes through `spendOneCredit`, the helper
  Translate with AI uses. An AI request is reserved in the day's ledger before the call, refunded when Sanity
  refused the call before doing any work (a rate limit, a bad request) and kept when it may have run (a
  timeout). Descriptions count in "AI requests today" and stop at Settings > Translations' **AI request
  limit per day** (`daily_cap`; at `0`, which switches only Translate with AI off, the default 100): the
  run ends, what was described is saved, and the asset reports the limit (`code: "daily_cap"`, `failed`
  when nothing was described, `partial` otherwise); a backfill batch stops there too. With one language
  that setting is hidden, so descriptions are counted but never capped (`altTextDailyLimit`). Without a
  `credit`, each description is one direct call (`directCredit`), which is what alt text does once
  Translate with AI is trimmed.
  See [AI usage](./ai-translation.md#ai-usage) for the ledger.
- **Each language is saved as soon as it is described**, before the next one starts, so a request that
  ends early (the host's cap, Stop, a closed tab) loses at most the description in flight, never one
  already made.
- **A time budget.** The route takes its deadline when the request arrives: the function cap
  (`FUNCTION_CAP_MS`, 60 seconds) out. Every description keeps 15 seconds of it back for the save after it
  and the answer (`DESCRIBE_RESERVE_MS` in `src/features/agents/alt-text.ts`), starts only with at least
  15 seconds to run (`MIN_DESCRIBE_MS`), checked before its AI request is reserved and again after, and gets the
  time it has as its client timeout, capped at the agent timeout (`describeTimeout`, through
  `agentCallBudget`; `spendOneCredit` takes both as its `budget` and `minCallMs`, and refunds a reservation the
  ledger's own time left too short to use). So a slow description ends at its own timeout
  and the route still answers, rather than the host killing the request. A call cut off that way may still
  count toward the organization's AI usage, which is why none starts with less time to run. The upload path and the backfill share the
  budget. A run the deadline (or an abort) stops is reported `partial`: what was described is saved, and
  the other languages are left for the next run.
- **The patch** (`altTextWrite` and `altTextPatch`) is built on a fresh read of the asset, taken after
  each description. A language an editor wrote meanwhile is dropped from it, and when every language
  was claimed that way the asset is reported `skipped`. It sets only the language owed (`altText['it']`)
  on an asset that stores an object, so an edit to another language survives. On a plain string or an
  empty field it writes the whole value: a plain string with one language, which is what the media
  library writes then, or an object with more, keeping a legacy string as the default language's arm.
  Unless forced it is a `setIfMissing`, so text that lands between that read and the patch is never
  overwritten either (a legacy string is the one value it replaces, since it becomes the default arm).
- **A failed language** stays missing for the next run. The languages already described are saved,
  since each one is a spent Agent Action, and the asset is reported `failed` with the text that was
  written.
- **The backfill panel** counts an image as missing when it lacks alt text in at least one language.

## Why the trigger lives in the Studio, not a webhook

Uploads are pinned to the media browser (`assetSources: () => [mediaAssetSource]` and
`directUploads: false` in `sanity.config.ts`), so an image cannot enter the dataset without a Studio
being open. That removes the usual reason to reach for a webhook, and keeping the trigger in
`sanity/auto-alt-text.tsx` buys back a lot:
- No dashboard step, and no config living outside the repository.
- No shared secret: a Studio call carries the editor's Sanity session, which `authorizeStudioRequest` verifies with Sanity (see [Studio API auth](./studio-api-auth.md)).
- It is versioned, reviewed, and deployed with everything else.

The cost is that it only covers uploads made through a Studio. Assets that arrive some other way (a
dataset import, `sanity dataset import`, a script) are the backfill panel's job. If you ever add such a
path and want it automatic too, a Sanity GROQ-powered webhook on
`_type == "sanity.imageAsset" && !defined(altText)` covers it, but not by posting to this endpoint: a
webhook cannot carry a Studio session, and this route accepts nothing else (see
[Studio API auth](./studio-api-auth.md)). Give the webhook its own route that verifies the Sanity
signature and its freshness the way `src/pages/api/revalidate.ts` does (`verifyWebhookDelivery` in
`src/features/api/webhook-signature.ts`), then runs the same describe step.

The listener queues descriptions one at a time, so dropping ten images into the media browser does not
fire ten concurrent Agent Actions. It does not read the toggle itself: the route is the single
authority on whether to call Sanity AI, so a stale Studio tab cannot act on a setting that has since
been switched off.

## Why a scratch document

Describing an image is `operation: { type: "image-description" }`, which is a **Transform target**
operation. Transform is schema-aware: it needs a `schemaId` and a source document whose type is in the
deployed schema. Alt text lives on `sanity.imageAsset`, a system type that is not in the workspace
schema, so the agent cannot write there directly.

So `src/features/agents/alt-text.ts` runs Transform against `imageAltText`, a one-field document type that
exists only to give the description a typed place to land
(`sanity/schemas/documents/image-alt-text.tsx`). It runs with `noWrite: true`, so nothing is stored in
it. The description comes back on the response and the route patches the asset itself.

`imageAltText` is registered in `AGENT_SCRATCH_DOCUMENTS` (`sanity/constants.ts`), which removes its
"create new" template, restricts its document actions, and keeps it out of the structure, so editors
never see it.

## Setup

Two steps, both in this repository. There is no dashboard configuration.

### 1. Deploy the schema

Agent Actions resolve field types against the **deployed** schema, not the local one.
`npm run sanity:typegen` only extracts locally, so deploy after any schema change or the agent works
from a stale copy:

```sh
npm run sanity:schema-deploy
```

The resulting schema id is `_.schemas.default` (this workspace is the unnamed default), which is what
`SANITY_AGENT_SCHEMA_ID` in `sanity/constants.ts` points at.

### 2. Turn the toggle on

**Settings -> Agents -> Automatic alt text -> Describe new uploads**, then publish. It is **off by
default**, because each description uses your Sanity organization's AI credits with nobody watching.
That holds in `astro dev` too: an image uploaded in a local Studio is described by Sanity AI, as on a
deployment. Check usage in your organization settings.

That is the whole setup. Upload an image in the media browser and it gains alt text within a few
seconds, with a toast showing what was written.

## Fields

| Field                                 | Type    | Purpose                                                                                                                                  |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Describe new uploads** (`enabled`)  | boolean | Gates the automatic path. Off by default. The backfill button ignores it, since that is an explicit action.                              |
| **Description guidance** (`guidance`) | text    | Optional steer: vocabulary to prefer, how much detail, what to leave out. Overrides the built-in style rules and is reused on every run. |

## What the AI is told

`ALT_TEXT_INSTRUCTION` in `src/features/agents/alt-text.ts` is the whole spec. In short: one line,
sentence case, no trailing period, 5 to 15 words, capped at 125 characters, lead with the subject,
quote legible text that carries the meaning, say what an interface is and what state it is in, and
leave out colour, lighting, mood, composition, and any adjective that adds no information. It never
opens with "Image of" or "This image shows".

The original file name is passed as a weak hint (disambiguation only, never quoted, never trusted over
the image). Editor guidance is passed as a parameter that overrides the stylistic rules.

`normalizeAltText` is the safety net, not the mechanism: it takes the first non-empty line, strips
wrapping quote pairs and any medium-restating opener that slipped through, drops the trailing period,
and truncates at a word boundary. A screen reader announces alt text in one breath, so a paragraph
pasted into that field is worse than a short sentence.

Two things keep the cost down: the source image is requested through the image pipeline at
`?w=1024&fit=max&fm=jpg&q=80`, so a full-size original does not travel at full weight, and SVGs are
excluded entirely (the pipeline serves them verbatim, so the model would receive markup rather than an
image).

## Backfill

The panel under the toggle shows how many images have no alt text (in at least one language, with
more than one) and describes them in batches, looping until the backlog is empty. It is batched
because each image is a round trip to the vision model per missing language, and one request would
outlive the function's time budget. A batch is at most 3 images (`limit`, up to 8), and the
[time budget](#one-description-per-language) ends it sooner: no image starts once too little time is
left, and an image the deadline stops ends the batch, with what it described saved and the rest left for
the next batch. Each answer carries `described`, the images that gained alt text (an image finished
across two batches counts in both), and `remaining`, the images still missing a language. **Stop** aborts
the batch request in flight, and the route checks the aborted request signal before each description, so
at most the description already running finishes. A failed batch stops the loop rather than retrying.

Straight from the API, for a bulk run or from a script:

```sh
# describe a batch (default 3, max 8); repeat while `remaining` > 0
curl -s -X POST https://<your-domain>/api/agents/image-alt-text \
  -H "content-type: application/json" \
  -H "authorization: Bearer $SANITY_USER_TOKEN" \
  -d '{"backfill": true, "limit": 5}'

# counts only
curl -s https://<your-domain>/api/agents/image-alt-text \
  -H "authorization: Bearer $SANITY_USER_TOKEN"
```

`SANITY_USER_TOKEN` is your own Sanity login (`npx sanity debug --secrets` prints it after
`npx sanity login`). The route accepts only a person with publish access to this project; an anonymous
call, a forged `Origin`, or an API (robot) token is refused. See [Studio API auth](./studio-api-auth.md).

Every answer is JSON with `cache-control: private, no-store`. Errors use the shared
`{ error, code, hint }` body with fixed text (`missing_asset_id` for a body with neither an image asset
`_id` nor `backfill`, `internal_error` when Sanity cannot be read: a POST answers "Alt text generation failed:
Sanity could not be read. Try again in a moment.", the stats GET "Failed to read alt text stats."). A
failed asset reports its `reason`: "Sanity AI could not describe this image." when no language was
described, "Some languages are still missing alt text." when only some were, and "The alt text could
not be saved." when a read or a patch after a description failed. An asset the time budget or an abort
stopped is `partial`, with "Stopped before every language was described; the rest are left for the next
run." and the text written so far; the upload listener shows it as a warning that points to Backfill.
An asset an editor described in every language while the run was in progress is `skipped` with "Alt
text was added while this image was being described.", and nothing is written. An asset the day's AI
request limit stopped carries `code: "daily_cap"` and "Today's AI request limit from Settings > Translations
is reached; it resets at midnight UTC.", and the batch stops; the panel shows it as a failed backfill. The original error from Sanity is logged on the server, never
returned.

`{"force": true}` re-describes every language of assets that already have alt text. It overwrites
editor-written descriptions, so it is opt-in and has no button.

## Manual verification

1. **Backfill:** open **Settings -> Agents**, confirm the panel reports the number of images without alt
   text, click **Backfill**, then check those assets in the media browser.
2. **Upload:** with the toggle on, drop an image into the media browser and confirm a toast appears
   with the description within a few seconds, and that the asset now carries it.
3. **Toggle off:** publish with the toggle off, upload again, and confirm no alt text appears (the
   route responds `200 {"status":"skipped"}`).
4. **No overwrite:** run the backfill twice; the second run reports nothing to backfill.

## Implementation reference

| Concern                                                               | Location                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CMS fields (Agents tab)                                               | `sanity/schemas/documents/site-settings.tsx`: `altText` object (`enabled`, `guidance`)                                                                                                                                                                                                                                                                                    |
| Upload listener (Studio plugin)                                       | `sanity/auto-alt-text.tsx`, registered in `sanity.config.ts`                                                                                                                                                                                                                                                                                                              |
| Backfill panel (Studio input)                                         | `sanity/inputs/alt-text-input.tsx`                                                                                                                                                                                                                                                                                                                                        |
| Scratch document type                                                 | `sanity/schemas/documents/image-alt-text.tsx`                                                                                                                                                                                                                                                                                                                             |
| Instruction, normalizer, agent call, languages, patch and time budget | `src/features/agents/alt-text.ts`: `generateAltText`, `missingAltTextLocales`, `describeLanguages`, `altTextPatch`, `describeTimeout`, `describeAsset`, `describeBacklog`, `directCredit`                                                                                                                                                                                 |
| The AI call and the daily ledger                                      | `ledgerCredit` and `altTextDailyLimit` in `src/features/agents/translate/alt-text-credit.ts`, over `spendOneCredit` in `translate/credit.ts`; the ledger and `readDailyCreditLimit` in `src/features/agents/ai-ledger.ts`                                                                                                                                                 |
| Tests                                                                 | `src/features/agents/alt-text.test.ts` (`npm test`): the helpers, and `describeAsset` and `describeBacklog` over an in-memory dataset with a test clock (a save after each language, the deadline, the timeouts); `translate/alt-text-credit.test.ts`: the daily ledger and its limit, and that both of the route's paths count in it; fixtures in `alt-text-fixtures.ts` |
| GROQ queries                                                          | `src/features/agents/query.ts`: `AltTextSettingsQuery`, `AltTextAssetQuery`, `AltTextAssetsQuery` (every non-SVG asset with its raw `altText`; the stats and the backlog are worked out from it in TypeScript)                                                                                                                                                            |
| Route (trigger + backfill)                                            | `src/pages/api/agents/image-alt-text.ts`                                                                                                                                                                                                                                                                                                                                  |
| Endpoint path (config seam)                                           | `sanity/config.ts`, `endpoints.imageAltText`                                                                                                                                                                                                                                                                                                                              |
| Agent API version and schema id                                       | `sanity/constants.ts`: `SANITY_AGENT_API_VERSION`, `SANITY_AGENT_SCHEMA_ID`                                                                                                                                                                                                                                                                                               |
| Agent client (API version, timeout, call budget)                      | `src/features/agents/agent-client.ts`: `createAgentClient`, `agentCallBudget` (see [Agent Actions](../sanity/agent-actions.md#one-client-factory)); the cap itself in `src/lib/function-cap.ts`                                                                                                                                                                           |
| Auth                                                                  | `src/features/api/auth.ts`: `authorizeStudioRequest` (see [Studio API auth](./studio-api-auth.md))                                                                                                                                                                                                                                                                        |
| Token                                                                 | `SANITY_API_EDIT_TOKEN` via `src/lib/env.ts` (reused; no new var)                                                                                                                                                                                                                                                                                                         |

## Troubleshooting

| Symptom                                                            | Cause and fix                                                                                                                                                                     |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Schema not found` or unknown type `imageAltText`                  | The deployed schema predates the type. Run `npm run sanity:schema-deploy`.                                                                                                        |
| Uploads are never described                                        | The toggle is off or unpublished, or the upload did not come from a Studio (an import or a script). Use Backfill.                                                                 |
| Backfill button says "Nothing to backfill" but images look bare    | Those assets already have alt text in every language (an empty arm counts), or they are SVGs, which are excluded.                                                                 |
| An image has alt text in one language only                         | The other language failed, or the image was described before that language was added. Run Backfill: it fills only the missing languages.                                          |
| Every description fails                                            | Agent Actions are not enabled for the project, or the organization's AI credits are used up (check usage in your organization settings). The server log has Sanity's own message. |
| "Today's AI request limit from Settings > Translations is reached" | Translations and alt text share one daily limit. Wait for midnight UTC, or raise **AI request limit per day** under Settings > Translations > Defaults and publish.               |
| A description is wrong or too wordy                                | Rewrite it in the media browser (it will not be overwritten), and add a **Description guidance** note so future runs behave.                                                      |
