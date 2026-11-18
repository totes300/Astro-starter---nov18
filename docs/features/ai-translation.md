# Translate with AI

Sanity AI (the Agent Actions `translate` action) drafts a document's translation into another
language, `prompt` translates the category names, and `translate` aimed at a person's default-language
arms translates its fields in place. The server side is one Studio-backed route,
`/api/agents/translate` (`sanityConfig.endpoints.aiTranslate`): a free plan on `GET`, and one action per
`POST`, with at most one AI call per request.

It needs more than one language in `LOCALES`. With one language the route answers 404
(`i18n_disabled`) and the Settings > Translations tab is hidden. With languages but no budget for AI, set
the AI request limit per day to `0` in Settings > Translations: that switches Translate with AI off, and the
plan and every action answer 404 (`off`) before anything else is read.

Every translation is a real Sanity AI call, in `astro dev` exactly as on a deployment, and uses your
Sanity organization's AI credits. [AI usage](#ai-usage) covers what keeps a run within its limits.

A project that does not want it removes it with `npm run trim` ([Removing it](#removing-it)).

## Before the first run

1. **Deploy the schema.** `npm run sanity:schema-deploy`. The agent reads the deployed schema, and every
   translated type carries the `aiTranslation` record field. Until every translated type's fields in the
   deployed schema match the local extract, the plan reports `schema_drift` and runs are refused, with
   copy that asks a developer to run the deploy. A new section or rich text block is not part of that
   check: runs go on against a deployed schema without it. Run the deploy again after every schema
   change ([Deployment](../deployment.md#deploy-the-schema-with-schema-changes)). `npm run sanity:schema-check`
   runs the same field check over every document type without an editor: it exits 1 whenever a run
   would be refused (and on drift in other types too). Run it before deploying and after a schema change
   ([Checking the deployed schema](../deployment.md#checking-the-deployed-schema)).
   The plan always reads the deployed schema afresh; a run's pairs reuse a passing check for a minute per
   server instance, and never a failing one, so a deploy unblocks the next request.
2. **Check the AI request limits** in Settings > Translations > Defaults: **AI request limit per run**
   (`maxCreditsPerRun`, 25) and **AI request limit per day** (`maxCreditsPerDay`, 100; `0` switches the
   feature off). They apply to a local Studio too.
3. **Fill Settings > Translations** (optional): a style guide, protected phrases, a glossary, a note per
   language, and the run defaults below. Publish Settings: the route reads the published values.
4. **Filter the revalidate webhook**, if the site has one: `!(_id in path("aiTranslation.**"))`. A run
   writes a lease, a ledger entry and a saved result per pair, and `/api/revalidate` answers those at once
   without refreshing anything, but Sanity delivers one at a time, so unfiltered they queue ahead of the
   publishes that matter. The filter belongs on the webhook from the first deploy, before any run:
   automatic alt text writes the ledger with one language too ([AI usage](#ai-usage)). See
   [Revalidation and Caching](../sanity/revalidation-and-caching.md#the-webhook).

## The route

Every request starts with `authorizeStudioRequest` (see [Studio API auth](./studio-api-auth.md)), so an
anonymous call is refused before anything else runs. Answers are `privateJson`, with fixed copy: no
document text and no upstream error text ever reaches the response.

**`GET ?documentId=<published id>`** or **`GET ?scope=site`**, with optional `useDraft=1`,
`languages=it,de` and `policy=missing|refresh`, returns the free plan: each source's targets and their
status, the estimated AI requests, the AI requests made today, the schema drift check, the saved results, and
`blocked` (`schema_drift`) when runs are refused. It also carries each language's compiled style guide
length (`settings.styleGuideByLanguage`), so the run's own instructions can show how much room is left.
A target whose language already has an unlinked document where the new one would go carries its id as
`unlinkedId`, with its title as `unlinkedTitle` so an editor can confirm it before linking it, and is never
`bulk` ([Fixed paths and singletons](#fixed-paths-and-singletons)); a target held out of every whole-site
run carries `hold` ([Held out of bulk](#held-out-of-bulk)); a category name left for a hand fix carries
`handFix` and is in no `labelBatches`, and `plainLabels` lists the categories whose name is still a plain
string (`npm run sanity:migrate-localize-fields`). `plan.aiDrafts` lists every unpublished AI draft, whatever
run left it, for a lasting "Publish N AI drafts" ([Publishing drafts](#publishing-drafts)); a target whose
draft is one carries `aiDraft`. Saved results for a language no longer configured or a source since
deleted are not listed: they can never be applied.

**`POST`** takes one action as a JSON body (a declared `content-length` over 32 KiB is refused):

| Body | What it does | AI requests |
| --- | --- | --- |
| `{ action: "translate", sourceId, language, version?, overwrite?, slugs?, publish?, instructions? }` | One source into one language | one, none when skipped or a saved result waits |
| `{ action: "apply", sourceId, language, publish?, overwrite? }` | Writes a saved result, on purpose; over a translation changed by hand since, only with `overwrite` | none |
| `{ action: "discard", sourceId, language }` | Deletes a saved result nothing will apply | none |
| `{ action: "link", sourceId, language, targetId, preview? }` | Links a document already written in that language as the translation; `preview` only checks it and answers its `title` | none |
| `{ action: "labels", ids?, languages?, publish? }` | Category names, 50 per call; repeat while `remaining > 0` | one per call, none when it only writes a saved answer |
| `{ action: "relink", publish? }` | Re-points references to translations published since; repeat while `remaining > 0` | none |
| `{ action: "publish", ids, revs? }` | Publishes up to 50 drafts a run left ([Publishing drafts](#publishing-drafts)) | none |

`instructions` is at most 1,000 characters.

Outcomes `translated`, `skipped`, `busy`, `saved_result`, `linked`, `preview` and `discarded` answer 200. `busy` carries `code: "busy"`
(another request holds the lease) or `code: "out_of_time"` (this request had too little time left for the
AI call; nothing was spent and a new request may go at once). Everything else is
`{ error, code }`: 400 `bad_input`, `style_guide_too_long` or `not_a_source`; 404 `source_not_found`,
`no_saved_result`, `document_not_found`, `link_not_found` or `off` (the switch, for the plan too); 409
`schema_drift`, `missing_language`, `wrong_target_language`, `unlinked_translation` (with `unlinkedId`),
`in_release`, `two_groups`, `needs_overwrite`, `link_mismatch` or `link_taken`; 429 `daily_cap`, `rate_limited` (wait
`retryAfterSeconds`) or `budget_exceeded` (stop, `usage` says why); 500 `write_failed`; 503
`sanity_unavailable` (Sanity could not be read or written before the AI call: `creditSpent: false`, so the
Studio counts no AI request); 504 `timeout`, which still counts as an AI request made (`creditSpent: true`);
502 any other upstream failure. A failure after the AI call started stays a 500 `internal_error`, which the
Studio counts as possibly made. Each answer says whether an AI request was made (`creditSpent`). A write the route
may safely send twice (the paid result, its cleanup) is retried twice on a throttle, a gateway error or a
dropped connection, since `@sanity/client` retries only reads.

### Time

The route stops at the app's own budget in `src/lib/function-cap.ts` (60 s; a Worker has no
wall-clock cap of its own), so a `POST` counts its deadline from the moment it arrives, not from the AI call. The call
gets what is left minus `WRITE_RESERVE_MS` (10 s, kept for saving and writing the paid result), never more
than `AGENT_TIMEOUT_MS`; with less than `MIN_AGENT_CALL_MS` (10 s) for the call, the pair or the labels
batch answers `out_of_time` before the ledger is touched (or after a refund, when the ledger itself was
slow). Relink, the labels writes and `publish` stop starting items once they reach the reserve, and report
what they did not reach. Every Sanity read and write of the route gives up after 10 s.

## One pair, in order

`translatePair` in `src/features/agents/translate/pair.ts` runs one source document into one language:

1. **Lease.** `aiTranslation.lease.<sourceId>.<lang>`, 90 s out (`AI_TRANSLATION_LEASE_TTL_MS`: the
   function cap, which no request outlives, plus 30 s for clock drift between instances). A lease that has
   not expired answers `busy` and spends nothing. It is released however the pair ends.
2. **Fresh reads.** Settings, the source version asked for, its translation group, the targets, and the
   groups of every document they link to (so a link a copy moved to a variant is no edit).
3. **Server re-check.** The status is recomputed from those reads, as the plan computes it. Without work
   to do (or `overwrite`), the answer is `skipped`, with no AI request. A translation that exists only inside a
   release is refused for free (`in_release`), overwrite or not, and so is a new translation of a source
   in two groups (`two_groups`), since the other group may hold one already.
4. **Saved result.** A paid result already kept for the pair answers `saved_result`
   (`saved_result_exists`), with no AI request: `apply` writes it free. `overwrite` calls the AI again, and
   the new result replaces the old one.
5. **Refusals.** An unlinked document already where a new translation would go
   (`unlinked_translation`), a style guide over 2,000 characters, a deployed schema that drifted, or too
   little time left for the call (`out_of_time`, see [Time](#time)).
6. **Daily ledger.** One document, `aiTranslation.ledger`, holds today's UTC date and count, and starts
   again from zero when the day changes, so no document piles up per day. It is incremented behind its
   revision before the AI call, and refused at `maxCreditsPerDay`. A call Sanity refused before doing any
   work is refunded in the ledger; a timeout is not, since it may still count toward the organization's
   AI usage. A pair and a labels batch both go through `spendOneCredit` (`translate/credit.ts`): the reservation, the time re-check after it, the call
   and the refund.
7. **The AI call.** `buildTranslateRequest` (`sanity/ai-translation/request.ts`): `noWrite`,
   `forcePublishedWrite`, `temperature: 0`, `maxPathDepth: 12`, the per-type exclusions and the
   conditional paths that type actually opens. Its timeout is what the request has left ([Time](#time)).
   A failure is logged under `[ai-translate]` with its code, Sanity's status and the first 300 characters
   of its message. A call that ran at least 30 s and still timed out (a gateway's quick 504 does not count)
   leaves a timeout note, `aiTranslation.result.<sourceId>.<lang>.timeout`, with the source text hash: the
   page is too large for one request, and the plan holds the pair out of bulk until that text changes
   ([Held out of bulk](#held-out-of-bulk)).
8. **The paid result is kept first,** as JSON text in `aiTranslation.result.<sourceId>.<lang>`, before
   anything else can fail (sent again on a transient failure).
9. **Merge guard** (below).
10. **Write.** A new translation is a draft plus its translation group in one transaction
    (`planTranslationStub` in `sanity/translation-stub.ts`); a new group gets a deterministic id from the
    source's id, and its URI is claimed first ([Slugs](#slugs-labels-and-phrases)). An existing one gets
    leaf-level sets on the paths that differ, behind the target's revision (`planTranslationRefresh`); it
    keeps its own URI, **Password protect** and `seoMetadata.noIndex`, overwritten or not. The
    translation's [agent Markdown](#agent-markdown) goes in the same transaction.
11. **Conflicts.** A conflict on the translation group alone is retried. Any other conflict stops,
    keeps the result, and answers `saved_result`: `apply` writes it later, for free. So does an unlinked
    document that appeared at a fixed path while the AI worked (`saved_result`, `unlinked_translation`).
12. **Publish,** when asked (or when `afterTranslate` is `publish`), through the Actions API, behind the
    draft's revision and, for a draft made from the published copy, that copy's revision too; a draft
    made from a copy published over since is discarded, as a conflict
    ([Free passes and stale reads](#free-passes-and-stale-reads)).
13. **Clean up.** The saved result, and any older one it replaced, is deleted once it is written, with the
    pair's timeout note. One whose delete failed is recognized by the `translatedAt` the translation now
    carries: the plan no longer lists it, step 4 ignores it, and the next write deletes it.

**Apply** (`applySavedResult`) runs steps 1, 2, 3's release check, 9 to 13 for free. When the translation
changed by hand since the result was paid for (the edit a conflict kept, or a page translated by hand
meanwhile), it answers `needs_overwrite` until it is sent with `overwrite`, so the Studio asks first.
**Discard** (`discardSavedResult`) deletes the pair's saved result under the same lease, for a result
nobody will apply (the editor finished the page by hand).

A whole-site run calls this once per pair, in dependency order (`RUN_ORDER` in
`sanity/ai-translation/plan.ts`): category names, people, articles, legal pages, pages, the blog index,
the homepage, and the Site last. A document is translated before the pages that link to it, so their
references can point at its translation. Never two languages of one source at once.

## Agent Markdown

A translation of a type that serves [agent Markdown](./agent-markdown.md) (a page, legal page, article
or the blog index) is written with its Markdown, and so is a person's language translated in place
(`agentMarkdown.content.<lang>`, when that arm is empty), so there is no backfill to run after a run. It is
free: the same `pageToMarkdown` serializer as **Generate**, over one Content Lake read, with no Agent
Action.

- **What it reads.** The translation as the write will leave it (for a new one, `stubAsWritten`: its URI
  and its references already moved into the language), sent as `$document` to
  `AiTranslationMarkdownQuery`, which runs the shared agent Markdown projection over it in the target
  language. The read is published, so links, the byline, category names and the blog index's article
  list name published documents only: a link to a page whose translation is not published yet points at
  the default language's page, as the translation's reference does.
- **When.** Step 10, `translationMarkdown` in `src/features/agents/translation-markdown.ts`, so `apply`
  writes it too. A new translation gets `agentMarkdown.content`; a refresh replaces it, since it described
  the text the refresh rewrites, in the same patch as the new text.
- **Left alone:** the Site and any type without the field, a translation whose **Serve Markdown to agents**
  is off, and a refresh whose Markdown came out the same.
- **Best effort.** When the read or the serializer fails, the translation is written without it (a
  refresh keeps the old Markdown), the error is logged, and the pair still answers `translated`.
- **The answer** carries `agentMarkdown`: `written`, `unchanged`, or `failed`, the one case that still needs
  **Generate** on the page, or Settings > Agents > **Backfill** for a new translation. It is absent when the
  type serves none or serving is off. `TranslatedPair` in `translate/pair.ts` adds it to the contract's
  `PairResult`.
- **Relink** moves the Markdown's links with the references (`relinkedMarkdown`), in the same patch, but
  only while the stored Markdown still reads exactly as the page serializes before the move. Markdown
  edited by hand is left as it is, so a link it names keeps the default language's page there until
  **Generate** runs on that page.

The Markdown is excluded from both hashes, so it never changes a translation's status.

## What the AI may change

`mergeTranslation` (`sanity/ai-translation/merge.ts`) starts from the source and takes only translated
text from the answer:

- **Restored from the source, always:** `_id`, `_type`, `_key`, references, mark definitions (a link, a
  color) other than those `TRANSLATED_MARKS` lists, a block's style and list settings, enum and slug
  fields, link targets, URL, path, email and asset id strings, section anchors (`sectionHash`; a section's
  title is translated, since a link to the section prints it as its default text), assets, numbers,
  booleans and colors. A person's name goes through `TYPE_EXCLUDED_FIELDS` in
  `sanity/ai-translation/fields.ts`: never sent, copied from the source. A type whose title is a proper
  name (a partner, a product) can list its `title` there too, so the name is never translated and a new
  translation's slug, which comes from its title, keeps it; protected phrases in Settings are the
  content-level alternative, keeping the name as written wherever the copy uses it.
- **A unit led by a slash stays as written.** A value that is a slash followed by no whitespace reads as
  a path (`isMachineString`), so a price suffix such as `/yr` or `/mo` is never sent back translated: a
  check on the value alone cannot tell it from `/it`. Store the unit without its slash and let the
  component print it.
- **Portable Text is guarded per block.** The answer's children are taken as a unit when every child is
  a span with allowed decorators or the source block's own annotations, the source's inline objects and
  links are all still there, and the text is not empty. Otherwise the whole source block is kept and
  counted as kept in English.
- **Inline objects, and annotations whose type `TRANSLATED_MARKS` lists** (empty here: list one whose
  fields are copy, a tooltip's term, say), are merged by `_key` like any object, so their copy is
  translated as leaves of its own while their settings stay the source's, even when the block's own text
  is kept in English. `markDefs` is not a protected key, so listing the type is all it takes: the tests
  list one for a suite and prove it is collected, merged and fingerprinted.
- **Arrays** are matched by `_key`: a missing item keeps the source item, an extra one is dropped, a
  type change is refused.

Each answer reports translated, kept in English and guarded counts, and the guarded paths. More than
three strings back unchanged marks the pair as partially translated.

`PROTECTED_KEYS`, `TRANSLATED_MARKS` and the per-type `CONDITIONAL_PATHS` live in
`sanity/ai-translation/fields.ts`, and `sanity/ai-translation/fields.test.ts` walks the Studio schema: it
fails when a new enum, slug, URL or date field is not protected, when copy sits in an annotation
`TRANSLATED_MARKS` does not list, or when a new conditional copy field is not listed. The Prefix Page
Route generator lists its new type's SEO title and description there, at `// PLOP: Add Conditional Paths`.

A conditional field inside an array is listed with `[]` for the item
(`["pageBuilder", "sectionsArray", "[]", "sectionContent", "note"]`). Agent Actions want each path whole,
item keys included, so the request opens the rule at every keyed path the source holds
(`conditionalPaths` in `sanity/ai-translation/request.ts`), and nothing the source lacks; an item without
a `_key` cannot be addressed, so it is skipped. The test lets a rule stand once a trim has removed every
section field it names, since it then opens nothing.

`AI_TRANSLATE_MAX_PATH_DEPTH` (12, in `request.ts`) bounds how deep a request reaches. The deepest copy
in the schema is 9 segments (a span's text in a section's rich text), and `fields.test.ts` fails when
copy goes deeper than the limit.

A new translated type also needs its own run step: an entry in `RUN_ORDER` (`plan.ts`), its group's title
in `SITE_GROUP_TITLES` (`site-run.ts`) and, when its translation takes a slug from its title, an entry in
`OWN_SLUG_STEPS` (`dialog-model.ts`). Without a step it would run and be grouped as a legal page:
`plan.test.ts` fails until every type in `I18N_DOCUMENT_TYPES` has one, `site-run.test.ts` when two steps
share a title, and `dialog-model.test.ts` when a section's item takes no slug of its own. The Prefix Page
Route generator fills all three for its type, at `// PLOP: Add Run Step`, `// PLOP: Add Site Group Title`
and `// PLOP: Add Own Slug Step`.

## Status

Every translation the AI writes carries a hidden, read-only `aiTranslation` record
(`create-ai-translation-field.tsx`): the source id, language and revision, and two hashes of the
source and of what was written. Both hashes run over a normalized projection (sorted keys, NFC text,
empty values removed, `false` included): `textHash` covers the translatable strings, `layoutHash`
everything else.

Statuses, first match wins: `editedByHand`, `translatedByHand`, `englishChanged`, `layoutChanged`
(reported only), `copyOfEnglish`, `notTranslated`, `upToDate`. A bulk run takes `notTranslated` and
`copyOfEnglish`; the `refresh` policy adds `englishChanged`. A translation edited or written by hand is
never done in bulk, and needs `overwrite`. The words the Studio shows for each are in
[Words on screen](#words-on-screen).

**A copy no AI wrote** is judged exactly, never by how much of it still reads as English. A copy made by
`npm run sanity:add-language` or the Translations menu is stamped where it is made (`copyRecord()`, from
the translation callback and the add-language planner): its record holds only `sourceTextHash` and
`sourceLayoutHash`, the copy's own hashes as made, and no `textHash`. While the copy still hashes as made
it is `copyOfEnglish`, however much the English changed since; once its text differs it is
`translatedByHand`, and once its layout (its **Password protect**, a section hidden) differs it is
`editedByHand`. A copy with no stamp (made before stamps, or by hand) is compared with the English:
`copyOfEnglish` only while its text is the English's, else `translatedByHand`, or `editedByHand` when the
text matches but the layout does not. A partly translated page, or a finished translation whose words
half stay English (names, job titles), is therefore never done in bulk and needs `overwrite`.

The hashes leave a document reference's `_ref` out, since translations re-point them per language. So a
copy's links are compared too (`movedReferences()` in `fingerprint.ts`): a link moved to a variant of the
English's target (any document in its translation group) is no edit, but one re-pointed anywhere else (an
Italian-only page in the header) makes the copy `editedByHand`, so a bulk run never resets it. Only places
both link from are compared: a link the English added or dropped since is no edit, and one the copy added
or dropped changes its layout anyway. A copy the English re-pointed since is held out like an edited one,
the safe side. An AI translation's own links are not compared: relink moves them on its own.

### Held out of bulk

Some pairs need work but are never picked by a whole-site run; the plan gives them `hold` and `bulk:
false`, and the dialog can still run them one by one:

| `hold` | When | What to do |
| --- | --- | --- |
| `inRelease` | The linked translation exists only inside a release (made in it with the Translations menu). Any release version is proof it exists: its group row is never replaced, and the route refuses the pair (`in_release`). | Publish or discard the release version. |
| `twoGroups` | The source sits in two translation groups (a plugin create raced an AI write). The plan and the route both use the oldest; a translation that is not in it yet is refused (`two_groups`), as it could duplicate one in the other. | Ask a developer to merge the groups. |
| `timedOut` | The pair's last call ran at least 30 s and timed out, on this exact source text. Another call would likely make another AI request for nothing. | Translate it from the dialog, or shorten the page; a change to its text lifts the hold. |

## Slugs, labels and phrases

- **Slugs.** A new translation's slug comes from its translated title (`slugs: "keep"` keeps the
  source's); the section word comes from the language. A slug the URI field would refuse (the Studio's
  path, `/404`, `/section-preview`, a gated shape, another section's word: `newTranslationUriProblem` in
  `sanity/translation-stub.ts`, on the rules `uri-gate.ts` and `sections.ts` share with the field) falls
  back to the source's own word. The URI then gets a `-2` suffix while it is taken, a draft included, or is
  the source of a redirect in Settings > Redirects in any letter case, which would answer first. It is
  claimed with a lease (`aiTranslation.lease.uri.<hash>`) and checked again under it, so two translations
  written at once never share one. The lease names the pair that claimed it (`owner`), and only that pair
  may take it back while it is live: a retry after a write killed between the claim and the write keeps
  the clean URI instead of moving to `-2`, which is safe because the pair's own lease lets one request
  write it at a time. A refresh keeps the target's URI.
- **Category names.** One `prompt` per 50 names, every language at once, checked strictly (the exact
  ids, one string per language, at most 80 characters, no markup). Each name is set only where it is
  missing. Two ids answered with the same name in a language while their English names differ both fail:
  one injected instruction in a category name could otherwise rename a whole batch alike (genuine
  duplicates fail too). A name that fails the checks is left out (`invalid`, with `labels_left_for_hand` as
  the message) and the rest of the batch is written; an answer with no valid name is `invalid_labels`. A
  failed name is remembered with its English, so no later run pays for it again until the English changes
  or someone fills it in by hand; an English name that fails the checks itself is never sent. The plan
  marks both with `handFix`. An id the answer left out (or answered with something other than an object,
  or with a language left out and nothing else wrong) is not a failed name: it stays in `remaining` and is
  asked again, and only a second miss in a row with the same English parks it. An answer that is not a
  JSON object blames no name, and every one is asked again. With nothing left to ask but names waiting for a hand fix, `labels` answers `skipped` with
  `labels_left_for_hand` and a message that counts them, instead of `nothing_missing`.
- **People, in place.** A person is one shared document ([A shared person](./internationalization.md#a-shared-person)),
  so it is never a pair: the `labels` action translates it in place once no batch of names is left to send.
  Each request makes at most one call: Translate in noWrite mode on the person itself, aimed at the
  default-language arms of the fields its target language lacks (`role.en`, `bio.en`,
  `seoMetadata.title.en`, `seoMetadata.description.en`; `buildInPlaceRequest` in
  `sanity/ai-translation/in-place.ts`), one AI request per person and language. The answer is checked against
  the source: a string must come back non-empty, and the bio keeps the source's blocks, keys, marks and links
  with only the span text taken from the answer (`translatedArms`); a field that fails is refused, the rest
  are written. Only empty arms are filled (`setIfMissing`), in a draft made from the published copy if need
  be, under the same draft, publish and conflict rules as category names, and that language's agent Markdown
  is generated from the result when its arm is empty. A paid answer not written yet is kept in the labels
  result (`documents`, by `<id>:<language>`) and written first, for free; an answer with nothing usable
  leaves the person for a hand fix until its English changes. As for category names, an arm once filled is
  never refreshed when the English changes. A plan lists a person as a label item with `kind: "document"`,
  one batch per missing language; the whole-site panel shows it under People and runs one job per
  language, and the document's dialog queues the same.
- **A paid answer is never lost.** The valid names are kept in `aiTranslation.result.labels.all` before
  any is written, with the failed ones. A write Sanity refuses (`failed`), a conflict, or the deadline
  leaves the rest there, and the next `labels` request writes them first, for free. Each is kept with the
  English it translates: one whose English changed since is dropped, and the new name is asked for instead.
  A name in a language taken out of `LOCALES` since is dropped too, never written back.
- **Drafts.** With publish on, `labels` and `relink` publish only the drafts they created (relink also
  those an earlier relink left, see [Publishing drafts](#publishing-drafts)), so an editor's open draft is
  never published. With publish off, `labels` answers `drafts`: each category draft it created, with the
  revision it wrote, for `publish`. Both passes write from what they read at their start, so a draft they
  make from a published copy is guarded ([Free passes and stale reads](#free-passes-and-stale-reads)).
- **Protected phrases.** Settings' phrases, the Site name and every person's name are passed to the
  agent and never replace each other. A run cannot add its own: protected phrases live only in Settings.

## Fixed paths and singletons

The homepage and the blog index keep one path in every language, and the Site has one copy per
language (`fixedPlace` in `sanity/translation-stub.ts`). A new translation of one of them is refused for
free (`unlinked_translation`, 409, with `unlinkedId`) when a document already sits at that path in the
language, or is that language's Site, without being linked to the source (made in Pages > Italiano, or
before the group existed): it would be a second homepage or Site. The Translations menu cannot
link an existing document, so the route can: `link` (free) adds it to the source's translation group,
replacing a row whose document is gone, or creates the group. It takes only a document of the source's
type, written in that language, in no translation group yet, and runs under the pair's lease; `preview:
true` checks it and answers its `title` without writing, so the editor confirms it is the same page. The plan marks such a target
with `unlinkedId` and `unlinkedTitle` and never puts it in a whole-site run.

## Publishing drafts

`{ action: "publish", ids, revs? }` publishes the drafts a run left, 50 per request (`FREE_PASS_BATCH` in
`wire.ts`, which the Studio batches by too), and answers
`{ published, skipped }`, each skipped id with a `code` and fixed `reason` (`PUBLISH_SKIP_REASONS` in
`wire.ts`):

| `code` | When |
| --- | --- |
| `no_draft` | Nothing to publish. |
| `not_ai_translation` | A source, a translation with no AI record, or a category draft sent without its revision. |
| `edited_by_hand` | A translation edited since the AI wrote it: its hashes no longer match its record. |
| `changed_since` | The draft is not at the revision `revs` names, or changed while it was published. |
| `publish_failed` | Sanity refused the publish. |
| `out_of_time` | Not reached before the request's deadline: send it again. |

`revs` maps an id to the revision a run left; an id with one is published only while its draft is still at
it. A category name's draft carries no record, so it is published with the revision `labels` answered in
`drafts`, or, without one, when the route proves it is a labels pass's: it differs from the published copy
only by names filled in for empty languages (`isFilledNamesDraft()`; `provedLabelDrafts()` reads it and
publishes it at that revision). The plan lists the same drafts, with every translation draft still as the
AI wrote it, in `plan.aiDrafts`, so publishing them never depends on a run's summary still being in a tab. A
relink after a run's own drafts still sees them as drafts, so publish first, then relink with `publish:
true` to point the now published translations at each other: references move only to published variants.
The whole-site panel's "Publish N AI drafts" does exactly that, from `plan.aiDrafts` and with no `revs`
([Whole site](#whole-site-settings--translations)).

**Relink** re-points the references of every translation to the variants published since. With
`publish: true` it publishes the drafts it created, and also a draft an earlier relink left (a relink with
`publish: false`, or one cut off by the deadline): one whose only difference from the published copy is
references moved to this language's variants and the agent Markdown that move writes. An editor's draft
is never published. A write Sanity refuses is reported in `failed` and tried again by the next pass.

### Free passes and stale reads

Relink reads every translation once, and a labels request every category it writes, then writes them one
by one, seconds apart. An editor can publish, delete or start a draft in between. So:

- **A draft a pass makes from a published copy** uses `create`: a draft that appeared since the read
  conflicts and is left alone, where `createIfNotExists` would have written into it and published it.
- **It is kept only while that published copy is unchanged.** Right after the write the pass reads the
  published copy again (`keepIfPublishedUnchanged` in `translate/publish.ts`); one published over or
  deleted since means the draft was made from a stale copy, so it is discarded and the id is reported in
  `conflicts`. The next pass works from the copy as it is now; a labels request keeps the paid names and
  writes them then, for free.
- **Its publish names both revisions:** `ifDraftRevisionId` and `ifPublishedRevisionId` (the published
  revision it was made from). A publish in between refuses it: the pass discards its draft and reports a
  conflict, so a reverted edit or a deleted page never goes live.
- **The discard is guarded too:** a delete beside a no-op patch on the draft's revision (the Studio's own
  revision lock), so a draft an editor touched in the meantime is theirs and stays.
- **A refresh made from the published copy** (`planTranslationRefresh` with `create`) is guarded the
  same way, in draft mode too: kept only while the target's published copy is still the one it was made
  from (checked right after the write), and published only behind that copy's revision (`publishedRev`).
  Otherwise its draft is discarded and the pair answers `saved_result` with `conflict`, the paid result
  kept to apply for free, so a draft that would put the older copy back live is never left behind.

## Settings > Translations

| Field | Purpose |
| --- | --- |
| `styleGuide` | Tone and terminology. With the glossary and the language's note it must fit 2,000 characters per language. |
| `protectedPhrases` | Text never translated (brand and product names). |
| `glossary` | A term and its rendering per language. |
| `languageNotes` | One note per language. |
| `defaults` | `languages`, `policy` (`missing` or `refresh`), `slugs` (`translate` or `keep`), `afterTranslate` (`draft` or `publish`), `maxCreditsPerRun` (25), `maxCreditsPerDay` (100; `0` switches Translate with AI off, while automatic alt text reads it as 100; unset reads as 100). |

The object is titled "Translation settings" and sits under the whole-site panel. The first four sit in the
"How the AI writes" fieldset and `defaults` is its own collapsible object, both folded, so the tab opens on
the panel. The options use the dialog's and the panel's words:
"Only pages not translated yet" and "Also refresh AI translations whose English was updated", "Translate
the slug" and "Keep the English slug", "Save as draft" and "Publish".

## AI usage

Translate with AI and automatic alt text use your Sanity organization's AI credits. Check usage in your
organization settings. The app counts the calls it makes to Sanity AI as AI requests, and enforces its own
limits on them below.

There is one path, and no environment is exempt: `astro dev` calls Sanity AI through the same route,
client and ledger as a deployment, and every AI call counts toward the organization's AI usage. The other AI
features behave the same way: [alt text](./auto-alt-text.md) describes every image uploaded in a local
Studio while its toggle is on, and [llms.txt](./llms-txt.md) Generate is a real `prompt` call. Agent
Actions clients are built in one place, `createAgentClient` (`src/features/agents/agent-client.ts`), with
`apiVersion: "vX"` and a 55 s timeout that Translate with AI shortens to what its request has left
([Time](#time)), so a document too large to translate in time times out locally as it would on a
deployment.

What keeps Translate with AI within its limits, first in the Studio, then on the route:

- **The plan makes no AI request.** The Studio reads it before every start, so a run's size is known before
  anything runs.
- **A typed confirmation** before a whole-site run that may make more than 50 AI requests (the estimate,
  or the run's limit when that is lower; `TYPED_CONFIRMATION_THRESHOLD`), so a run at the default limit of
  25 asks for a click and a large one for the word.
- **The run cap,** `maxCreditsPerRun` (**AI request limit per run**, 25 by default). The document dialog
  refuses a run that needs more, and the run queue never starts a job that calls the AI past it, counting
  the jobs in flight and those whose answer was lost. The whole-site panel starts its own **AI request
  limit for this run** from it, which the editor can change for that run
  (1 to 500). A whole-site run whose estimate is over its limit still starts: it stops at the limit
  (`credit_cap`), and translating the site again picks up what is left, since the plan no longer lists
  what was translated. A run that saved drafts says to publish them first, so the next run's links can
  point at them; its drafts stay under "Publish N AI drafts" whatever runs next, since that list comes
  from the plan.
- **One request per pair.** The lease answers a second request `busy`, with no AI request.
- **The server re-check.** A pair with no work left answers `skipped`, and one with a saved result
  `saved_result_exists`: neither makes an AI request, and applying a saved result is free.
- **The daily cap,** `maxCreditsPerDay` (**AI request limit per day**, 100 by default). The route reserves
  an AI request in the ledger before every AI call and refuses at the cap with `daily_cap`, whichever Studio, tab or person sends the
  request. The day is UTC. `0` is the off switch: every action, free ones included, answers 404 `off`
  (`isSwitchedOff()` in `translate/dispatch.ts`, one small read per request).
- **Sanity's own limit.** A spent budget answers `budget_exceeded`, which stops the run at once.

[Automatic alt text](./auto-alt-text.md) goes through the same ledger and the same `spendOneCredit`:
each description reserves an AI request first, is refunded on the same rules, counts in "AI requests today",
and is refused at `maxCreditsPerDay` (at `0`, which switches only Translate with AI off, at the default
100). With one language Settings > Translations is hidden, so descriptions are counted but never capped.
The alt text route passes `ledgerCredit` (`translate/alt-text-credit.ts`) to the describers, which make
one direct call per description without it, so alt text needs nothing else of this feature. llms.txt
Generate does not go through the ledger.

The ledger is written from launch, one language included, so the revalidate webhook's
`!(_id in path("aiTranslation.**"))` filter matters from the first deploy (see
[Revalidation and Caching](../sanity/revalidation-and-caching.md#the-webhook)).

### What it costs (as of October 2026)

Sanity sets these prices and can change them. Check the current figures on
[sanity.io/pricing](https://www.sanity.io/pricing) and your usage in your organization settings.

Each AI request Translate with AI makes is one Sanity Agent Actions call, billed as **1 AI credit**
whatever the page's length or number of sections: a page is one Translate request, so the count grows with
pages and languages, not with how much a page holds. At the time of writing an AI credit costs **$0.05**,
and Sanity includes **1,000 credits a month** on Free and Growth and 5,000 on Enterprise, shared with every
other AI feature in the organization. Past that, Growth pays per credit, Free stops until the next month,
and Enterprise uses credit bundles.

Translating a whole site once, pages only:

| Site | Translated into | AI requests (= credits) | List price | On Growth, after the 1,000 included |
| --- | --- | --- | --- | --- |
| 25 pages | 1 language | 25 | $1.25 | $0 |
| 100 pages | 1 language | 100 | $5 | $0 |
| 100 pages | 4 languages (5 in total) | 400 | $20 | $0 |
| 100 pages | 5 languages (6 in total) | 500 | $25 | $0 |
| 300 pages | 4 languages | 1,200 | $60 | $10 |
| 1,000 pages | 4 languages | 4,000 | $200 | $150 |

What adds to it:

- Re-translating a page after its source changes: one more request per language.
- Authors: one request per author and language.
- Category names: one request per batch of 50 names, every language at once, so a handful in total.
- Automatic alt text, when switched on: one request per new image and language (300 images in 5 languages
  is 1,500).
- A page that times out and is tried again counts twice; whole-site runs hold such pages back.

How long it takes: the defaults are 25 AI requests per run and 100 per day, so the 400-request example
above takes four days and at least 16 runs. Before a first full translation, raise both under Settings >
Translations > Defaults (up to 500 per run and 1,000 per day).

## In the Studio

The Studio side shares one core in `sanity/ai-translation/`, so the document action and the Settings panel
behave the same way. React components hold no rules; these modules do, and each has a test.

### The contract

`wire.ts` holds the route's request and answer types (`PlanRequest`, `PlanResponse`, `PairInput`,
`PairResult`, `LabelsResult`, `RelinkResult`, `PublishResult`), its codes (`TranslateCode`,
`RouteErrorCode`) and the fixed copy (`TRANSLATE_MESSAGES`). The route imports them from there, so both
sides read one definition.

### The client

`api.ts` calls the route through `studioFetch`, at `sanityConfig.endpoints.aiTranslate`: `fetchPlan`,
`postTranslate`, `applySaved`, `discardSaved`, `linkTranslation` (with `preview` for the title to confirm),
`translateLabels`, `relink` and `publish`; `createTranslateTransport()` hands the run queue the three it
sends (`translate`, `labels`, `relink`), and the panel's "Publish N AI drafts" calls `publish` itself. Each returns `{ ok: true, data }` or `{ ok: false, error }`, where
`error` has a `code`, a `message` an editor can read (the route's fixed copy, or the Studio's for a code),
`retryAfterSeconds`, `usage`, and the route's own answer when it sent one. Failures that never reach the route get their own codes:

| Code | When | Counts as an AI request? |
| --- | --- | --- |
| `timeout` | The host's plain-text 504 | Maybe, for `translate` and `labels` |
| `host_error` | Any other page that is not the route's JSON | Maybe, for `translate` and `labels` |
| `network` | No answer at all | Maybe, for `translate` and `labels` |
| `aborted` | The request was cancelled | Maybe, for `translate` and `labels` |

A 401 reads as the editor's ended session and a 403 as "Only people who can publish can translate with
AI." (`PUBLISH_ACCESS_TEXT`), whatever the gate's own text says. "Maybe" is `creditMayBeSpent`: such a
call counts against a run's cap; a 503 `sanity_unavailable` says `creditSpent: false`, so it never does.

### The run queue

`run-store.ts` is one queue per Studio tab (`runStore`, read with `useTranslationRun()`). A run started in
the document action keeps going when its dialog closes, and the Settings panel sees it. A hot reload in
development keeps the same queue. Only one run goes at a time; a second start is refused with a message.
The queue lives in the tab and ends with it, so while a run is going, closing or reloading the tab asks
first (`guardUnload()`, a `beforeunload` listener that `useTranslationRun()` installs once and that is on
only while a run is active).

- **Order.** `RUN_ORDER`: category names, people, articles, legal pages, a generated type's documents,
  pages, the blog index, the homepage, the Site, then the free relink pass, called "Update links" on
  screen (`UPDATE_LINKS`). A step starts only once every earlier step has finished, so references can point at variants published moments before. The
  queue has no publish job: the panel's "Publish N AI drafts" calls `publish` itself
  (`publishInBatches()`), then relinks.
- **Concurrency.** Two at a time, never two languages of one source (they share a translation group), and
  never two label batches (they share one lease).
- **The run's cap.** `maxCreditsPerRun` from Settings. A job that calls the AI starts only when the AI
  requests made, plus one for each such job in flight, plus its own, stay within it. A pair answered
  `skipped` made none, so the next one may still run. Reaching the cap ends the jobs that call the AI
  (`credit_cap`), but the free relink
  pass after them still runs, so what the run published points at the translations published with it. A
  whole-site run's stop reason says to translate the site again to continue (a draft run's, to publish its
  drafts first); a document run's, to raise the limit or translate fewer languages.
- **Stop.** "Stop after the N running": queued jobs never start, and the running ones finish and keep what
  they translated.
- **Stops at once** on `budget_exceeded`, `daily_cap`, `schema_drift`, `unauthorized`, `forbidden`,
  `i18n_disabled` and `off`, since every later request would be refused the same way. One that answers
  after the editor's Stop becomes the run's stop reason, so the summary names it and "Try again" is not
  offered.
- **A lasting rate limit stops the run.** A rate limit pauses every worker for `retryAfterSeconds` (60 s
  when Sanity names none), then asks that job again. Three rate-limited answers in a row
  (`RATE_LIMIT_STOP_AFTER`) stop the run with `rate_limited` (`rateLimitStop()`): the jobs not done are
  left "Not started", none of them failed, and the stop says to try again in a few minutes, and where to
  check the organization's AI usage. "Try again" stays on offer. An answer that
  goes through resets the count, so a limit that lets requests through keeps the run going.
- **Retries, once each.** A `busy` pair is asked again after 5 s, and so is a job Sanity did not answer
  before the AI call (`sanity_unavailable`, spent nothing). An `out_of_time` pair or label batch (the
  route had too little of its time cap left for the AI call, and spent nothing) is asked again at once,
  since a new request has the whole cap. Nothing whose AI request may have gone through is retried: not a timeout, not a failure, not a `conflict`
  (`saved_result`, applied later for free) or `wrong_target_language`. Nor is `saved_result_exists`,
  which spent nothing: applying it is free. A label batch asked again keeps the names and drafts its first
  attempt wrote from a saved answer, so the run's summary still counts them.

A relink job asks again while some are left, and stops on a pass that neither relinked nor published
anything (`relinkAll()`, which every Update links button and menu item uses too); ids Sanity refused (`failed`) are
reported once, unless a later pass relinked them. A labels job that wrote some names says what it left:
names that changed meanwhile, could not be saved (written free by the next run), or failed the checks or
were left out twice, and now wait for a hand fix (`labelsNote()`).

Each job row carries its state (`queued`, `running`, `done`, `skipped`, `failed`, `saved_result`,
`stopped`), its timing, whether it made an AI request, and the route's answer. `runTotals()`,
`sourceProgress()` and `pairJob()` read a run (the time left counts one lane per source, since one source's
languages run one after another); `siteRunJobs()` and `documentRunJobs()` build one from a plan. A
document run that publishes ends with Update links (`updateLinksJob()`, free), as a whole-site run does,
so other pages point at the translation it published; a draft run has nothing to point at yet.

**A saved result is never paid for twice.** When the plan lists a saved result for a pair (`savedPairs()`),
applying it is free, so neither view queues that pair on its own: the whole-site plan leaves it out of the
run and its row says a paid result is saved, and the document dialog leaves it unticked with a hint
(ticking it translates again, with another AI request, sent with `overwrite`). The route checks again before
it calls the AI, so a busy retry, a second tab or a stale plan answers `saved_result_exists` instead of
calling it twice. An AI call
whose answer was lost (a timeout, a host error page) may still have saved its result, so the dialog reads
the plan again when a run ends and offers "Apply saved result (free)" on that language instead of "Try
again".

### Words on screen

`present.ts` holds the copy both views show, so the dialog and the panel use one vocabulary. A status is
stated as a fact, never a judgment: two languages may differ on purpose.

| Status | Row text | Hint | Ticked by default |
| --- | --- | --- | --- |
| `notTranslated` | Not translated yet | | yes |
| `copyOfEnglish` | Still in English | The page exists but holds the English text. | yes |
| `upToDate` | Translated by AI on 20 Oct 2026 | | no |
| `englishChanged` | Translated by AI on 20 Oct 2026 | English updated since. | no |
| `layoutChanged` | Translated by AI on 20 Oct 2026 | English updated since. | no |
| `editedByHand` | Edited since the AI translation | | no |
| `translatedByHand` | Written by hand | | no |
| any, with `unlinkedId` | Not linked | This language already has its own version, not linked as its translation. Link it with Translate with AI on the English page instead of translating. (`unlinkedText()`) | no, and it cannot be ticked |
| any, with `hold: "inRelease"` | In a release | Its translation exists only inside a release. Publish or discard that release version, then translate. | no, and it cannot be ticked |
| any, with `hold: "twoGroups"` or `"timedOut"` | its status | its status's hint, then why whole-site runs leave it out (`heldText()`); a timed-out one adds that trying again makes another AI request and may run out of time again | no |
| any, with `aiDraft` | its status | its hint, then "Draft, not published." (`DRAFT_HINT`) | as its status |

The plugin's Translations menu cannot link a document that already exists, so no copy sends an editor
there. A category name with `handFix` reads "Fill in by hand", with why: the English name is too long or holds
markup, or the AI's answer for it failed the checks or left it out twice in a row (`handFixText()`). Copy that needs a command says
who runs it: "Ask a developer to run npm run X." (`askDeveloperToRun()`), and the agent `unauthorized`
copy names `SANITY_API_EDIT_TOKEN`. `sanity/editor-copy.test.ts` fails on any Studio copy that names an
`npm run` without asking a developer, and on a message that starts a sentence with "Run npm".

The date is the translation's `aiTranslation.translatedAt` (its draft's first, as the plan reads a
status), which the Studio reads itself with one query over the translation ids (`useTranslatedAt()` in
`translate-ui.tsx`), again for each new plan, since the plan carries statuses only; without it the row
reads "Translated by AI". Months have three letters ("20 Sep 2026").
Languages are named in English in sentences ("the Italian page", `languageName()`) and by flag and native
title on labels. `present.ts` also holds the AI request count ("1 AI request", `aiRequestCount()`), the
usage line ("Uses your Sanity organization's AI credits. Check usage in your organization settings.",
`AI_USAGE_NOTE`, kept out of buttons and footers), timers, the
word count, what is kept as it is, guarded paths in plain words, and the `policy` option titles that
Settings and the panel share. It holds the run's words both views show too: the progress line, "12 of 40
done, 12 AI requests made, 2 more may still count" (`runProgressCopy()`, with `requestsMadeCopy()`
for the totals), an Update links pass summed up (`linksCopy()`), and what Update links does
(`UPDATE_LINKS_NOTE`: free, and it publishes the pages it changes).

**Shared Studio layer.** The views share their behaviour as well as their words. `translate-ui.tsx` holds
the hooks: `useTranslationPlan()` (one free plan read per request, the last plan kept on screen while a
new one loads), `useSavedResultActions()` and the `SavedResultControls` beside each saved result (Apply and
Discard, with the caution first when Apply replaces someone's changes), `useLinkTranslation()` (the
preview, then the link) and the `LinkTranslationControl` under each unlinked row, `useUpdateLinks()`, and
`useTranslateSwitchedOff()` (Settings' published daily
limit is 0). What each answer means for the view (`applyAnswer()`, `discardAnswer()`, `linkAnswer()`,
`updateLinksToast()`) is pure and tested in `dialog-model.ts`.

### One document: Translate with AI

The document action (`createTranslateWithAiAction` in `sanity/ai-translation/translate-action.tsx`, added in
`sanity/actions.tsx`) is on every translated type and on the category, only with a second language, after
the open-page actions and before Delete translation. While this document is in the tab's run its label reads
"Translating... 1 of 2" (its languages; the Update links pass after them is not counted), and it stays
clickable so the dialog can show the run or stop it. It is disabled, with a title saying why, until the
document is saved, while it has no language, and for anyone who cannot publish the document
(`useDocumentPairPermissions`, the check the route makes too): a Contributor reads "Only people who can
publish can translate with AI." without waiting for a plan. It is hidden on a release version, and while
Settings > Translations' AI request limit per day is 0 (the off switch, read from the published Settings by
`useTranslateSwitchedOff()`), unless this tab's run is still going. Its rules are pure and tested in
`sanity/ai-translation/dialog-model.ts`; the dialog is `translate-dialog.tsx`, with its parts in
`translate-dialog-configure.tsx`, `translate-dialog-run.tsx` and `translate-ui.tsx`. Which of its views
shows is `dialogView()`, tested over every state: a run going, a run finished and not yet seen, the plan
loading (with no plan on screen), the plan failed, a translation, nothing to translate from, or
configure.

The dialog (an @sanity/ui `Dialog`, id `translate-with-ai`) keeps one rhythm: `DialogBody` and
`DialogFooter` (`translate-ui.tsx`) put a divider under the header and above the footer, the body and the
footer's note start on the header title's left edge, and the footer is laid out as the Studio's own
dialogs (padding 3, buttons at padding 2). Sections sit 5 apart, the items in a section 3, and the lines
of one item 2. It has these states:

1. **Checking translations.** One free `GET ?documentId=<published id>` for every target language, with
   `useDraft=1` when the current draft is the source. It runs again when the source version changes and
   on "Back to languages" after a run; the last plan stays on screen meanwhile, and the button waits for
   the new one.
2. **Configure.**
   - **Source line:** "From 🇬🇧 English: About (/about)". When the document has unpublished changes, an
     inline "Translate: Published version / Current draft" choice, published by default. A document never
     published translates its draft.
   - **Banners,** under the source line and only when they apply, the ones that block first: another run
     going in this tab, instructions the route would refuse, schema drift ("Ask a developer to run npm run
     sanity:schema-deploy"), today's limit reached, or a run over this run's limit. One only warns: fewer
     AI requests left today than the run needs.
   - **Languages:** one row per language, even with one: a checkbox, the flag and name, the row text and
     hint from [Words on screen](#words-on-screen), and the translation's URI; the checkbox is described
     by its row text. A row with no page yet, or one still in English, starts ticked, among Settings'
     default languages when it names any of them; a row held out of whole-site runs (`hold`) never starts
     ticked. A row whose language already has its own document there (`unlinkedId`), or whose translation
     exists only inside a release, is never ticked and cannot be: the route would refuse it. The first
     offers "Link as the Italian translation": a free `link` preview answers that document's title, a
     caution asks to confirm it ('Link "Chi siamo" as the Italian translation of "About"? It joins the
     translation group as it is: nothing is translated or published, and no AI request is made.', and for a
     person, to change one of the slugs instead if this is someone else), and Link writes it and reads the
     plan again. Ticking a row whose
     page the AI made shows a caution under it: "Replaces the Italian page with a fresh translation of the
     English. Changes and sections that exist only in Italian are lost. Its URL, Password protect and No
     Index stay as they are." On a page edited since or written by
     hand the caution adds a required "I understand the Italian changes are replaced", and Translate
     stays disabled until it is ticked. Every replacement goes with `overwrite`, as does a language with
     a saved result.
   - **Saved results** for this document, each with "Apply saved result (free)" and Discard. When the
     translation was changed by hand since the result was saved (the plan's status, or the route's
     `needs_overwrite` on a stale plan), Apply waits for "I understand the Italian changes are replaced"
     under a caution, then goes with `overwrite`. Discard asks once ("The AI request it took still counts,
     and nothing offers it again.") and deletes the result for free.
   - **After translating:** Save as draft or Publish, inline; "Published as soon as it is translated." only
     when Publish is chosen.
   - **More options** (collapsed): the URL slug (shown only for the types that take a slug from their
     title, `hasOwnSlug`: pages, articles, legal pages and a generated type, when a ticked language has no
     page yet), "Extra instructions for this run" with the characters left (what the
     tightest ticked language's compiled guide leaves, within the route's 1,000), what stays as it is,
     "AI requests today: N of M" and the usage line (`AI_USAGE_NOTE`).
   - **Footer:** the summary as its note, "About 130 words", or what Translate waits for: "Tick a
     language to translate." or 'Tick "I understand" for Dutch to translate.' (no note on a category with
     names to translate, "Nothing to translate" on one without, and "Checking translations..." while the
     plan reloads). Then Cancel and "Translate"
     ("Translate 2 languages" with more than one).
3. **Running.** The run goes through `runStore` (one language at a time for one document), and with
   Publish chosen it ends with Update links. A `role="progressbar"` bar with "1 of 3 done, 1 AI request
   made" (`runProgressCopy()`), one row per language with its state and timer, "Retrying in m:ss" during
   a rate limit, "Stop after the N running" and Hide. Under them: "You can close this dialog. Keep this
   browser tab open until the run ends." Closing the dialog keeps the run going, and reopening it shows
   the run; closing the tab ends it, so the tab asks first. A document that is part of a whole-site run
   shows that run, and its Stop reads "Stop the site run after the N running", since it stops every
   document. The `aria-live` region carries "N of M
   done" and the language that just finished, never the timer, and the outcome once the run ends; it is
   empty while languages are being picked.
4. **Done.** One line per language ("🇮🇹 Italiano: translated, saved as draft") with Open, then "Links
   updated" with what the pass changed when the run published, and the AI request total in the footer
   (`requestTotalCopy()`; after a whole-site run, this document's share only, `documentRun`). Only after drafts: "Review the draft, then
   publish it. Then use Update links, so other pages link to it instead of the English page.", what Update
   links does, and an "Update links" button (`useUpdateLinks()`: the free relink with `publish: true`, its
   outcome in a toast). A stop that needs the editor (a limit, a spent budget, a lasting rate limit) shows
   once, with where to go. When texts came back in English, a "Details" disclosure says "6 texts came back
   in English, check them before publishing." and lists them, with what the guard put back. When the run
   ends the plan is read again: a language whose lost answer left a saved result offers "Apply saved result
   (free)" and Discard, with the caution first when the translation was edited meanwhile. "Try again"
   queues the other failures again (a timeout included) and the languages a stop kept from
   starting, then Update links again when the run published; "Try again (free)" when only Update links
   failed. Never after a stop code, and never a language already applied or discarded; it waits while the
   plan loads. A language whose answer was lost goes again without `overwrite`, since it may have been
   written already: the route's re-check then calls the AI only when it still needs work. "Back to languages" reads
   the plan again.
5. **Errors** show the route's fixed copy per code. A saved result offers "Apply saved result (free)", a
   spent budget or a lasting rate limit links to Sanity Manage, and today's limit opens Settings. A plan
   that failed offers "Try again" only when asking again could help: never on `forbidden`,
   `unauthorized`, `off` or `i18n_disabled` (`canRetryPlan()`).

The final outcome is also a toast, so it shows when the dialog is closed. After drafts it adds "Once
they are published, use Update links in Settings > Translations so other pages link to them.", and after
a run whose Update links failed, that the links were not updated.

**On a translation** the dialog is read-only: "This is the Italian translation of About.", its row text,
and "Open the English page". A document linked to no source says so ("This document is not linked to an
English page, so there is nothing to translate it from."), that Translate with AI on the English page
offers to link a document already where the translation goes, and to ask a developer to link any other.
**On a category** it lists the name in each language, and one `labels` job fills the ones not translated
yet, one AI request for all of them; with none missing it says there is nothing to translate. A name left for a
hand fix (`handFix`) queues nothing and says why, and a name still in plain text asks a developer to run
`npm run sanity:migrate-localize-fields`. A result
kept because the language's own document appeared at that path while the AI worked
(`unlinked_translation`) offers no "Apply saved result": linking is the fix.

### Whole site: Settings > Translations

`SiteTranslationField` (`sanity/inputs/site-translation-input.tsx`) is the `translations` object's field
component (`components.field`). It renders the "Translate the whole site" panel above the field, so the
panel does not read as one of the settings it uses, then the "Translation settings" field as usual, folded
under "How the AI writes" and "Defaults"; with one language it renders the field alone (the tab is hidden
then). `StyleGuideInput` counts each language's compiled guide (the style guide, that language's notes and
its glossary) against the 2,000 characters, with `buildStyleGuide`. The panel's rules are pure and tested
in `sanity/ai-translation/site-run.ts`, and it keeps the dialog's spacing. It loads, links, updates links
and acts on saved results through the shared Studio layer ([Words on screen](#words-on-screen)), so it
says and does what the dialog does.

**Off.** While Settings' published AI request limit per day is 0 (`useTranslateSwitchedOff()`), the panel is
replaced by one note, "Translate with AI is off: the AI request limit per day under Defaults is 0. Set it
above 0 and publish to switch it on." (`SWITCHED_OFF_NOTE`), and asks the route for nothing. A run this tab
is still going through keeps the panel, so its progress and Stop stay on screen (`showsSwitchedOff()`); the
route stops it with `off`.

The panel is one card: a header, the body, and a footer that holds the run's main action.

- **Header.** "Translate the whole site", a spinner while the plan reloads, links update or AI drafts
  publish, and a "More actions" menu: "Check again" reads the plan again, and "Update links (free)" points
  the links on other pages at the translations published since (looped while some are left). Its confirm
  says what it does before it does it (`UPDATE_LINKS_NOTE`: free, and it publishes the pages it changes),
  and `useUpdateLinks()` runs it and toasts the outcome. It always passes `publish: true`, whatever "After
  translating" says: a published translation's relink is published, and so is a draft an earlier relink
  left, while an editor's open draft only gets the move and stays a draft. A pass saved as drafts would
  wait for a publish the panel never offers. It waits while any run is going or AI drafts are publishing.
  The spinner has words in a second live region, "Updating links." or "Publishing the AI drafts."
  (`panelBusyCopy()`), empty otherwise; the outcome is the toast, which announces itself.
- **Notices,** first in the body and only when they apply: Settings has unpublished changes, since the
  route reads the published ones ("Publish your changes below first: translations use the published
  settings."), a document is being translated in this tab, a run would be refused (schema drift, today's
  limit), some documents have no language yet (`missingLanguageCopy()`), or some category names are still
  plain text (`plan.plainLabels`, `plainLabelsCopy()`); both ask a developer to run the migration. A plan
  that failed to load shows why, with "Try again" only when asking again could help (`canRetryPlan()`:
  never on `forbidden`, `unauthorized`, `off` or `i18n_disabled`).
- **The plan.** One free `GET ?scope=site` for every target language (`useTranslationPlan()`), loaded when
  the panel opens, on "Check again", after a run, a link, Update links, a publish or a saved result
  applied or discarded; the last plan stays on screen while the next loads. Ticking languages or switching
  the policy needs no new request: `sitePlanView()` narrows the plan and recomputes `bulk` the way the route
  does: never a target with `unlinkedId` or a `hold`, and never a category name with `handFix`, which stays
  out of the label batches and the estimate. Each language gets one line: its flag and name, then "3 not
  translated yet, 6 translated" (`countsCopy()`). Each target counts once, in the first that holds: "not
  linked" (`unlinkedId`), "left out of whole-site runs" (`hold`), "AI drafts not published" (`aiDraft`: the
  site does not show them yet), then its status, where pages still in English count apart and any other
  live translation, AI or not, counts as translated; then category names to translate, or to fill in by
  hand. "Pages (N)" opens the list, built to stay readable at hundreds of pages:
  - a filter, "To translate (N)" or "All (N)": a tab list whose selected tab labels the list, which is its
    `role="tabpanel"`. It opens on "To translate" while anything is left (`defaultPlanFilter()`,
    `filterPlanGroups()`);
  - a title search once the list has more than `PLAN_SEARCH_MIN` pages;
  - one folded group per step in run order, titled by `SITE_GROUP_TITLES` in `site-run.ts` (category
    names, people, articles, legal pages, pages, the blog index, the homepage, the Site), its header saying "120 pages · 30 to translate" (`groupCountsCopy()`).
    Groups start open only while the filtered list fits one page of `PLAN_PAGE_SIZE` rows;
  - inside a group, `PLAN_PAGE_SIZE` rows at a time with "Show 20 more (100 left)" (`showMoreCopy()`).
  Each row is one line: the title, a link to its source (a category name to its category), then each
  language in the dialog's row text (`cellText()`, dated for the rows on screen): a held target in
  `heldText()`'s words, an unpublished AI draft with "Draft, not published.", and a pair with a saved result
  says so and is left out. A source never published is skipped. A target whose language already has its
  own document there reads "Not linked" and offers "Link as the Italian translation" under the row, as the
  dialog does (`useLinkTranslation()`): a free `link` preview answers that document's title, a caution asks
  to confirm it (for a person, to change one of the slugs instead if it is someone else), and Link writes it
  and reads the plan again. Such rows are under "All", since they have nothing to translate.
- **This run.** "After translating" (Save as drafts or Publish) shows; "More options" holds the languages
  (with more than one target), "Also refresh AI translations whose English was updated" (off unless
  Settings' policy says `refresh`; it never touches pages edited since or written by hand), the slugs, and
  "AI request limit for this run" with the usage line (`AI_USAGE_NOTE`). All start from the published `defaults`, and start over when newly
  published defaults come back with the plan.
- **Footer.** "Translate N pages", with its AI requests and "AI requests today: N of M" beside it, or the one
  reason it is disabled: a run going, no language ticked, or a run that would be refused (schema drift,
  today's limit). It also waits while the plan reloads. With nothing left in the ticked languages it reads
  "Every page is translated", with today's AI requests, and under it, when category names wait for a hand fix,
  "2 category names are left to fill in by hand. Fill them in, or change the English name and run again."
  (`allDoneNote()`, the route's `labels_left_for_hand` words), never that nothing is missing. Today's count
  is the later of the run's newest result and the plan (`freshestCreditsToday()`). An estimate over this
  run's limit does not disable it: the count reads "500 of 620 AI requests this run" (`runCostCopy()`), and
  the run stops at the limit. The confirm Dialog lists what runs (languages named in English in its
  sentences), its AI requests ("Makes 12 AI requests." or "Makes up to 25 AI requests, this run's limit.",
  then the usage line), what happens after and what is left alone; over the limit it says so ("it stops
  there, with about 500 of the 620 translations done. Translate the site again to continue: the next run
  picks up the rest.", and "Publish its drafts, then translate the site again" when it saves drafts). It
  asks for the word "translate" typed out when the run may make more than 50 AI requests (`runSpend()`,
  `TYPED_CONFIRMATION_THRESHOLD`), so a run at the default limit of 25 asks for a click.
- **Running.** The run goes through `runStore`, so it keeps going when Settings is closed and shows again
  when it is reopened. The body shows the timer and the time left, a `role="progressbar"` bar, the
  rate-limit pause, and each job by step with Open (Update links last); the footer shows the dialog's
  progress line, "N of M done, N AI requests made, N more may still count" (`runProgressCopy()`), and
  Stop, which reads "Stop after the N running". The panel's live region stays mounted: it carries that line
  while the run goes and the summary once it ends, never the timer. With publish on, the run ends with
  Update links.
- **Done.** A summary card above the plan counts what was translated, skipped, failed (with each reason),
  saved for later and not started, the AI requests made in the dialog's words (`requestTotalCopy()`), and how
  many were published or that they were saved as drafts. "Each translation" lists every job, with what a
  label batch left. Dismiss clears the run from the tab's queue and loses nothing: its drafts and saved
  results come from the plan.
- **AI drafts.** Whenever the plan lists unpublished AI drafts (`plan.aiDrafts`: translation drafts still as
  the AI wrote them, and category drafts that only fill empty names), whatever run, tab or person left
  them, the panel says "2 translations and 1 category name the AI wrote are saved as drafts, not published
  yet." (`aiDraftsCopy()`) with "Publish 3 AI drafts" (`draftsToPublish(response)`). After a confirm it
  publishes them 50 per request with no `revs`: the route proves each category draft itself
  ([Publishing drafts](#publishing-drafts)); an id the route had no time for (`out_of_time`) goes once
  more. Then it runs Update links with `publish: true`, so the translations it just published link to
  each other instead of the English pages. A draft edited since the AI wrote it stays a draft, and every
  one left alone is listed with the route's reason, named from the plan (`skippedDrafts()`). It waits while
  a run is going, links update or the plan reloads.
- **Saved results.** Each one the plan lists has "Apply saved result (free)" and Discard
  (`SavedResultControls`, `useSavedResultActions()`). Apply writes it, and publishes it when this run's
  "After translating" says so. When the translation was changed by hand since the result was saved
  (the plan's status, or the route's `needs_overwrite` on a stale plan: `applyWarning()`), Apply waits for
  "I understand the Italian changes are replaced" under a caution, then goes with `overwrite`. Discard
  asks once and deletes the result for free.

## Troubleshooting

Every answer carries a `code`; the Studio shows its fixed copy. "Editor" is anyone with publish access,
"admin" whoever may edit Settings, "developer" whoever deploys the site. A failure of the AI call is
logged on the server under `[ai-translate]` with Sanity's status and message (never sent to the Studio).
Skipped drafts of `publish` have their own codes ([Publishing drafts](#publishing-drafts)).

| Code | What it means | Who acts |
| --- | --- | --- |
| `skipped`, `nothing_missing`, `no_saved_result`, `aborted` | Nothing to do, or stopped before the AI call. Nothing spent. | Nobody |
| `busy`, `out_of_time`, `auth_unavailable`, `sanity_unavailable`, `network`, `host_error` | Another request holds the pair, the request ran short of time, or Sanity did not answer. Nothing spent (a lost answer may have been). | Nobody: the run asks once more, or try again |
| `rate_limited` | Sanity is rate limiting AI requests. Each one waits and goes again; three in a row stop the run, with nothing spent on them. | Editor: try again in a few minutes; organization admin, when it keeps happening: AI usage in Sanity Manage |
| `daily_cap` | Today's AI request limit is reached; alt text counts toward it too. | Wait for midnight UTC, or an admin raises it |
| `credit_cap` | The run reached its own limit and stopped. | Editor: publish its drafts, then translate the site again |
| `off` | The daily limit is 0, which switches Translate with AI off: the action is hidden, the whole-site panel shows only how to switch it on, and the route answers 404. | Admin: set the AI request limit per day above 0 and publish |
| `budget_exceeded` | The organization's Sanity AI spending limit is reached. | Organization admin, in Sanity |
| `conflict`, `write_failed` | The translation changed or could not be written; the paid result is kept. | Editor: review, then Apply saved result (free) |
| `saved_result_exists`, `needs_overwrite` | A paid result waits, or applying it would replace someone's changes. | Editor: Apply it, or confirm the overwrite |
| `lost` | Neither the translation nor the paid result could be saved. | Developer: server log |
| `source_not_found`, `document_not_found` | The source is not published, or not the version asked for. | Editor: publish it, or translate its unpublished changes |
| `not_a_source` | The run started from a translation. | Editor: start from the default language's document |
| `unlinked_translation`, `link_not_found`, `link_mismatch`, `link_taken` | A document in that language sits where the translation goes without being linked, or the one picked cannot be linked. | Editor: link the right document |
| `wrong_target_language` | The translation group links a document of another language. | Editor: fix the group in the Studio |
| `in_release` | The translation exists only inside a release. | Editor: publish or discard that release version |
| `two_groups` | The source sits in two translation groups and the oldest has no translation in this language, so a new one could duplicate one in the other. | Developer: merge the groups (`translation.metadata`) |
| `labels_left_for_hand`, `invalid_labels` | Category names failed the checks (or were left out twice). | Editor: fill them in by hand, or change the English name |
| `style_guide_too_long` | The style guide, a language's note and its glossary pass 2,000 characters. | Admin: shorten Settings > Translations |
| `schema_drift`, `schema_missing`, `schema_rejected` | The deployed schema differs from the code, or Sanity AI refused the call over it. | Developer: `npm run sanity:schema-deploy` ([Checking the deployed schema](../deployment.md#checking-the-deployed-schema)) |
| `missing_language` | The document has no `language`. | Developer: `npm run sanity:migrate-backfill-language` |
| `invalid_request`, `server_error`, `timeout`, `unknown` | Sanity AI refused or failed the call; the last three may still count toward the organization's AI usage. A `timeout` after at least 30 s holds the pair out of bulk (`timedOut`). | Developer: the `[ai-translate]` line in the server log, with Sanity's status and message |
| `unauthorized`, `forbidden` | No Studio session, no publish access (the action is disabled with that reason), or the server's token cannot run AI actions. Try again is never offered. | Editor: sign in; admin: grant publish; developer: check `SANITY_API_EDIT_TOKEN` |
| `i18n_disabled`, `bad_input`, `internal_error` | One language configured, a Studio and site of different versions, or an unexpected error. | Developer |

## Tests

No test can reach Sanity AI. One tripwire, `agentActionTripwire` in `sanity/test-support/agent-actions.ts`,
throws `AgentActionTripwireError` on any `/agent/action/` request, for the Studio's tests (through
`sanity/ai-translation/test-fixtures.ts`) and the server's alike: `agent-actions.test.ts` checks the fake
lake carries it, `request.test.ts` that the fixtures do. `sanity/test-support/fake-content-lake.ts`
answers a real `@sanity/client` in memory behind it (groq-js, revision conflicts, publish behind
`ifDraftRevisionId` and `ifPublishedRevisionId`, and discard); a test stubs only the action it exercises, wrapping the lake's request
handler and picking the action with `agentActionOf()`. The pipeline is in `translate.test.ts` (its agent
Markdown included, with the read failing on purpose; the free passes and a pair's refresh with an editor
publishing, deleting or opening a draft between their read and their write), the pair's re-check against the plan in
`translate/pair.test.ts` (stamped copies, moved links, releases, two groups, timeout notes, discard), what
the plan offers in `translate/plan-read.test.ts` (AI drafts, unlinked titles, saved results), the actions
as the route answers them in `translate/dispatch.test.ts` (the off switch, free failures, link, proved
category drafts), the AI call sequence in `translate/credit.test.ts`,
the Agent Actions client in `agent-client.test.ts` (its `vX` request reaches the tripwire, its timeout stays
under the function cap), the lease and ledger in `ai-ledger.test.ts`, and the pure core in
`sanity/ai-translation/*.test.ts`. The run queue runs over a
fake transport and a fake clock (`run-store.test.ts`: the order, the cap, a lasting rate limit, the
retries, and the tab's `beforeunload` guard over a plain `EventTarget`), and the client over a fake
`fetch` (`api.test.ts`), so no Studio test sends a request.
The whole-site panel's rules run over a hand-built plan (`site-run.test.ts`: held, unlinked and AI draft
targets kept out of runs and counted apart, the AI drafts to publish taken from the plan, the hand-fix note,
the off switch, the shared progress and AI request words), and what a pure rule cannot show of its markup and
wiring (the tab panel, the busy live region, the shared hooks) is read from its source
(`sanity/inputs/site-translation-input.test.ts`). The document action's rules run over
hand-built plans and runs (`dialog-model.test.ts`: the action's state, `dialogView()` over every view, held
and unlinked rows, Apply, Discard and link answers, Update links). `sanity/actions.test.ts` checks where
the action is offered, in both locale modes, and `sanity/editor-copy.test.ts` that Studio copy asks a
developer to run every command it names.

## Not in v1

- A free "Sync layout" (`layoutChanged` is reported only) and Content Release output.
- Raising the function cap (`FUNCTION_MAX_DURATION_SECONDS` in `src/lib/function-cap.ts`): a call has
  what is left of 60 s after the reads before it and the 10 s kept for the write, locally too, so the
  largest pages may need it. The lease, the call and every pass follow the constant.
- A cleanup job for expired leases and ledgers. They are tiny dotted documents. A saved result is
  discarded with `discard`, and `npm run sanity:migrate-remove-language` deletes a removed language's
  saved results and timeout notes and takes its pending category names out of the labels result.
- `requestedBy` on the record: the Studio gate does not expose the verified user yet.

## Removing it

`npm run trim` offers `ai-translation` (Translate with AI) when a run switches off the last second
language, and on its own to a project that keeps two. A project cut before it joined the starter, which
took it afterwards, is offered it once `npm run trim -- --reconcile --ported ai-translation` records it.
It deletes `sanity/ai-translation/`, the
Settings panel (`sanity/inputs/site-translation-*`), the record field, `src/features/agents/translate/`,
`translation-markdown.ts`, `ai-ledger.ts`, the route, `npm run sanity:schema-check`, and
this page; it unwires the action, the Settings > Translations group and field, `withAiTranslationRecord`,
the `AI_TRANSLATION_*` constants, `endpoints.aiTranslate`, the queries, the stamps the translation
callback and `sanity:add-language` write, and the saved-results step of `sanity:migrate-remove-language`.
With `--dataset` it unsets `siteSettings.translations` and the `aiTranslation` record on every translated
type. Automatic alt text stays, one direct call per description. The dotted `aiTranslation.*`
bookkeeping documents stay in the dataset for you to delete. Details:
[Trimming features](./trimming-features.md).

Until then, a one-language Studio still loads the action and the helpers it imports, hidden: a build
folds `IS_I18N_ENABLED` to a literal, but that only drops the branches it guards, never a module
imported at the top of a file. The document dialog (`React.lazy` in `translate-action.tsx`) and the
Settings panel (`React.lazy` in `site-settings.tsx`) load only when opened; and the route imports `sanity-schema.json`
as a JSON module, which a build ships minified, only when a check runs.
`src/features/agents/translate/bundle.test.ts` keeps the lazy boundaries and the import as they are.

## Files

| Concern | Location |
| --- | --- |
| Route | `src/pages/api/agents/translate.ts` |
| Pipeline, one module per concern (the route imports `index.ts`) | `src/features/agents/translate/`: the POST actions and the off switch (`dispatch.ts`), one pair with apply and discard (`pair.ts`, its write in `pair-write.ts`, its timeout note in `timeout.ts`), the AI call (`credit.ts`), the plan (`plan-read.ts`), `link.ts`, `labels.ts`, `relink.ts`, `publish.ts` (category drafts proved in `ai-drafts.ts`), `schema-check.ts`, the request bodies (`parse.ts`), the HTTP status (`status.ts`), and the reads and helpers they share (`reads.ts`, `shared.ts`) |
| Queries | `src/features/agents/query.ts` (`AiTranslation*Query`), except the lease, ledger and saved-result reads, which live in `ai-ledger.ts` |
| Agent client (`vX`, the 55 s timeout, `agentCallBudget`) | `src/features/agents/agent-client.ts` |
| The function cap the route budgets against | `src/lib/function-cap.ts` |
| Lease, ledger (alt text counts in it too), saved results | `src/features/agents/ai-ledger.ts`; alt text's `ledgerCredit` in `translate/alt-text-credit.ts` |
| Test support (Agent Actions tripwire, in-memory Content Lake, test locales) | `sanity/test-support/agent-actions.ts`, `sanity/test-support/fake-content-lake.ts`, `sanity/ai-translation/test-fixtures.ts` |
| A translation's agent Markdown | `src/features/agents/translation-markdown.ts`; `AiTranslationMarkdownQuery` in `query.ts` |
| Pure core (fields, merge, fingerprint, style guide, request, plan, labels, errors) | `sanity/ai-translation/` |
| Route contract | `sanity/ai-translation/wire.ts` |
| Studio client, run queue, copy | `sanity/ai-translation/api.ts`, `run-store.ts`, `present.ts` |
| Translation stub and refresh, a new translation's fixed place and URI checks | `sanity/translation-stub.ts`; the reserved paths in `sanity/schemas/fields/uri-gate.ts` |
| Record field | `sanity/schemas/fields/create-ai-translation-field.tsx` (`withAiTranslationRecord`) |
| Settings | `sanity/schemas/documents/site-settings.tsx` (`translations`) |
| Document action and dialog | `sanity/ai-translation/translate-action.tsx`, `translate-dialog.tsx`, `translate-dialog-configure.tsx`, `translate-dialog-run.tsx`, `translate-ui.tsx`; rules in `dialog-model.ts` |
| Whole-site panel | `sanity/inputs/site-translation-input.tsx`, `site-translation-run.tsx` (the run, the AI drafts and the saved results); rules in `sanity/ai-translation/site-run.ts` |
| Constants | `sanity/constants.ts` (`AI_TRANSLATION_*`, `aiTranslationDocumentId`) |
