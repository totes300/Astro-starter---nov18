import { Button, Dialog, Flex, Spinner, SrOnly, Stack, Text } from "@sanity/ui";
import { useToast } from "@sanity/ui/toast";
import * as React from "react";
import { useRouter } from "sanity/router";
import { SANITY_SINGLETON_SITE_SETTINGS_ID } from "../constants";
import { DEFAULT_LOCALE, getStudioLocaleTitle, LOCALE_IDS } from "../i18n";
import { run as runBlock } from "../lib/run";
import { useStudioFetch } from "../lib/studio-fetch";
import { createTranslateTransport } from "./api";
import {
  acknowledgeTarget,
  applyWarning,
  canRetryPlan,
  canStart,
  categoryJobs,
  categoryNames,
  coveredJobs,
  dialogSubject,
  dialogView,
  documentRun,
  hasOwnSlug,
  initialPicks,
  instructionsLeft,
  instructionsRoom,
  type PairOutcome,
  requestTotalCopy,
  retryJobs,
  retryLabel,
  runAnnouncement,
  runOutcome,
  runPicks,
  selectTarget,
  startLabel,
  startNotices,
  stopLabel,
  summaryLine,
  type TargetPicks,
  targetLanguages,
  targetOptions,
  toastStatus,
  translationNote,
  unacknowledgedTargets,
  unavailableCopy,
} from "./dialog-model";
import { readRecord } from "./plan";
import { type FieldTitles, languageName, requestsTodayCopy, translatableSummary } from "./present";
import {
  documentRunJobs,
  isRunActive,
  type JobInput,
  jobCredits,
  pairKey,
  runStore,
  runTotals,
  savedPairs,
  useTranslationRun,
} from "./run-store";
import { AfterTranslating, CategoryNames, MoreOptions, SavedResults, SourceLine, TargetList } from "./translate-dialog-configure";
import { DoneView, RunningView } from "./translate-dialog-run";
import {
  DialogBody,
  DialogFooter,
  NoticeCard,
  useLinkTranslation,
  useNow,
  useSavedResultActions,
  useTranslatedAt,
  useTranslationPlan,
  useUpdateLinks,
} from "./translate-ui";
import type { PlanRequest, SavedResultSummary } from "./wire";

const DIALOG_ID = "translate-with-ai";

const TARGETS = LOCALE_IDS.filter((id) => id !== DEFAULT_LOCALE);

const SOURCE = languageName(DEFAULT_LOCALE);

/** Runs whose summary the editor already closed in this tab, so reopening starts from a fresh plan. */
const seenRuns = new Set<string>();

export type TranslateDialogProps = {
  documentId: string;
  documentType: string;
  isCategory: boolean;
  /** A shared routed document (a person): translated in place, one call per language. */
  isInPlaceDocument?: boolean;
  /** The field a category translates in place (`LOCALIZED_FIELDS`). */
  categoryField?: string;
  published: Record<string, unknown> | null;
  draft: Record<string, unknown> | null;
  titles: FieldTitles;
  onClose: () => void;
};

export function TranslateDialog(props: TranslateDialogProps) {
  const studioFetch = useStudioFetch();
  const toast = useToast();
  const { navigateIntent } = useRouter();
  const run = useTranslationRun();
  const [useDraft, setUseDraft] = React.useState(() => !props.published && Boolean(props.draft));
  const request = React.useMemo<PlanRequest>(
    () => ({ documentId: props.documentId, useDraft, languages: TARGETS }),
    [props.documentId, useDraft]
  );
  const { state: plan, reload: reloadPlan } = useTranslationPlan(request);
  const [, rerender] = React.useReducer((count: number) => count + 1, 0);
  const [picksState, setPicksState] = React.useState<{ key: string; picks: TargetPicks }>({ key: "", picks: {} });
  const [slugChoice, setSlugChoice] = React.useState<"translate" | "keep" | null>(null);
  const [publishChoice, setPublishChoice] = React.useState<boolean | null>(null);
  const [instructions, setInstructions] = React.useState("");
  const [settled, setSettled] = React.useState<ReadonlyMap<string, "applied" | "discarded">>(() => new Map());
  const savedActions = useSavedResultActions(reloadPlan);
  const link = useLinkTranslation(reloadPlan);
  const links = useUpdateLinks();

  const jobs = coveredJobs(run, props.documentId);
  const ownRun = run && jobs.length > 0 ? run : null;
  const summaryRun = documentRun(run, props.documentId);
  const isRunning = isRunActive(ownRun);
  const showsDone = ownRun !== null && !isRunning && !seenRuns.has(ownRun.id);
  const now = useNow(isRunning);
  const finishedRunId = ownRun && !isRunning ? ownRun.id : undefined;
  const reloadedFor = React.useRef(finishedRunId);

  // A lost answer may have saved its paid result: a fresh plan offers it free instead of "Try again".
  React.useEffect(() => {
    if (!finishedRunId || reloadedFor.current === finishedRunId) {
      return;
    }

    reloadedFor.current = finishedRunId;
    reloadPlan();
  }, [finishedRunId, reloadPlan]);

  const response = runBlock(() => {
    if (plan.status === "ready") {
      return plan.response;
    }
    if (plan.status === "loading") {
      return plan.previous ?? null;
    }
    return null;
  });
  const isRefreshing = plan.status === "loading";
  const subject = response ? dialogSubject(response, props.documentId, { isCategory: props.isCategory }) : null;
  const view = dialogView({
    run: runBlock(() => {
      if (isRunning) {
        return "running";
      }
      if (showsDone) {
        return "done";
      }
      return null;
    }),
    plan: plan.status,
    hasPlan: response !== null,
    subject: subject?.kind ?? null,
  });
  const row = subject?.kind === "source" ? subject.row : undefined;
  const savedHere = (response?.savedResults ?? []).filter(({ sourceId }) => sourceId === props.documentId);
  const savedKeys = savedPairs(savedHere);
  const translatedAt = useTranslatedAt(row?.targets.flatMap(({ targetId }) => (targetId ? [targetId] : [])) ?? [], response);
  const options =
    row && response
      ? targetOptions(row, {
          source: SOURCE,
          defaultLanguages: response.settings.defaults.languages,
          saved: savedHere.map(({ language }) => language),
          translatedAt,
        })
      : [];
  const optionsKey = options.map(({ language, status, preselected }) => `${language}=${status}:${preselected}`).join(",");
  const picks = picksState.key === optionsKey ? picksState.picks : initialPicks(options);
  const chosen = runPicks(options, picks);
  const languages = chosen.map(({ language }) => language);
  const room = response
    ? instructionsRoom(response.settings.styleGuideByLanguage, languages.length > 0 ? languages : TARGETS)
    : 0;
  const charactersLeft = instructionsLeft(room, instructions);
  const publish = publishChoice ?? response?.settings.defaults.afterTranslate === "publish";
  const slugs = slugChoice ?? response?.settings.defaults.slugs ?? "translate";
  const sourceDocument = useDraft ? (props.draft ?? props.published) : (props.published ?? props.draft);
  const category = subject?.kind === "category" ? subject : undefined;
  const runJobs: JobInput[] = runBlock(() => {
    if (row) {
      return documentRunJobs(row, chosen, { publish, slugs, instructions: instructions.trim() });
    }
    if (category) {
      return categoryJobs(props.documentId, category.label, publish);
    }
    return [];
  });
  const credits = jobCredits(runJobs);
  const notices = response
    ? startNotices({ response, credits, otherRunActive: isRunActive(run) && !ownRun, charactersLeft })
    : [];
  const unacknowledged = unacknowledgedTargets(options, picks);

  const updatePicks = (next: TargetPicks) => setPicksState({ key: optionsKey, picks: next });

  const warningFor = (sourceId: string, language: string) =>
    applyWarning(row, language, { forced: savedActions.needsOverwrite.has(pairKey(sourceId, language)) });

  const close = () => {
    if (showsDone && ownRun) {
      seenRuns.add(ownRun.id);
    }

    props.onClose();
  };

  const backToPlan = () => {
    if (ownRun) {
      seenRuns.add(ownRun.id);
    }

    setSettled(new Map());
    rerender();
    reloadPlan();
  };

  // The language picks the Structure folder; without it the folder open now claims the document.
  const openDocument = (id: string, type: string, language?: string) => {
    close();
    navigateIntent("edit", { id, type, language });
  };

  const openSettings = () => openDocument(SANITY_SINGLETON_SITE_SETTINGS_ID, "siteSettings");

  const start = (jobsToRun: JobInput[], runPublish = publish) => {
    if (!response) {
      return;
    }

    const started = runStore.start(
      {
        scope: { kind: "document", sourceId: props.documentId },
        publish: runPublish,
        maxCredits: response.settings.defaults.maxCreditsPerRun,
        jobs: jobsToRun,
      },
      createTranslateTransport(studioFetch)
    );

    if (!started.ok) {
      toast.push({ status: "warning", title: "Translation not started", description: started.message });

      return;
    }

    setSettled(new Map());

    void started.finished.then((finished) => {
      const outcome = runOutcome(finished);

      toast.push({
        status: toastStatus(outcome.tone),
        title: outcome.title,
        description: outcome.description,
        closable: true,
        duration: 12_000,
      });
    });
  };

  const settle = (id: string, how: "applied" | "discarded") => setSettled((current) => new Map([...current, [id, how]]));

  const applyFromPlan = (saved: SavedResultSummary, overwrite: boolean) =>
    void savedActions.apply(
      { sourceId: saved.sourceId, language: saved.language, publish, ...(overwrite ? { overwrite } : {}) },
      languageName(saved.language)
    );

  const discardFromPlan = (saved: SavedResultSummary) =>
    void savedActions.discard({ sourceId: saved.sourceId, language: saved.language }, languageName(saved.language));

  const applyFromRun = async (outcome: PairOutcome, overwrite: boolean) => {
    const input = {
      sourceId: outcome.sourceId,
      language: outcome.language,
      publish: ownRun?.publish ?? publish,
      ...(overwrite ? { overwrite } : {}),
    };

    if (await savedActions.apply(input, languageName(outcome.language))) {
      settle(outcome.id, "applied");
    }
  };

  const discardFromRun = async (outcome: PairOutcome) => {
    if (await savedActions.discard({ sourceId: outcome.sourceId, language: outcome.language }, languageName(outcome.language))) {
      settle(outcome.id, "discarded");
    }
  };

  let body: React.ReactNode;
  let footer: React.ReactNode;

  switch (view) {
    case "running": {
      const active = ownRun as NonNullable<typeof ownRun>;
      const totals = runTotals(active, now);

      body = <RunningView run={active} jobs={jobs} now={now} isPartOfSiteRun={active.scope.kind === "site"} />;
      footer = (
        <DialogFooter>
          <Button
            padding={2}
            mode="ghost"
            text={stopLabel(totals.running, active.status === "stopping", { site: active.scope.kind === "site" })}
            disabled={active.status === "stopping"}
            onClick={() => runStore.stop()}
          />
          <Button padding={2} text="Hide" onClick={close} />
        </DialogFooter>
      );
      break;
    }
    case "done": {
      const finished = ownRun as NonNullable<typeof ownRun>;
      const recoverable = jobs.filter((job) => job.kind === "pair" && savedKeys.has(pairKey(job.sourceId, job.language)));
      const retry = retryJobs(finished, jobs, new Set([...settled.keys(), ...recoverable.map(({ id }) => id)]));

      body = (
        <DoneView
          run={summaryRun ?? finished}
          jobs={jobs}
          documentId={props.documentId}
          source={{ document: sourceDocument, language: SOURCE }}
          titles={props.titles}
          saved={savedKeys}
          actions={{
            onOpen: (targetId, language) => openDocument(targetId, props.documentType, language),
            onApply: (outcome, overwrite) => void applyFromRun(outcome, overwrite),
            onDiscard: (outcome) => void discardFromRun(outcome),
            onOpenSettings: openSettings,
            onUpdateLinks: () => void links.update(),
            isUpdatingLinks: links.isUpdating,
            busy: savedActions.busy,
            settled,
            warningFor: (outcome) => warningFor(outcome.sourceId, outcome.language),
          }}
        />
      );
      footer = (
        <DialogFooter note={requestTotalCopy(summaryRun ?? finished)}>
          <Button padding={2} mode="bleed" text="Back to languages" onClick={backToPlan} />
          {retry.length > 0 && response ? (
            <Button
              padding={2}
              mode="ghost"
              text={retryLabel(jobCredits(retry))}
              disabled={isRefreshing}
              onClick={() => start(retry, finished.publish)}
            />
          ) : null}
          <Button padding={2} tone="primary" text="Done" onClick={close} />
        </DialogFooter>
      );
      break;
    }
    case "loading":
      body = (
        <Flex align="center" gap={3}>
          <Spinner muted />
          <Text size={1} muted>
            Checking translations...
          </Text>
        </Flex>
      );
      footer = (
        <DialogFooter>
          <Button padding={2} mode="bleed" text="Cancel" onClick={close} />
        </DialogFooter>
      );
      break;
    case "failed": {
      const failure = plan.status === "failed" ? plan : { message: "", code: "" };

      body = <NoticeCard notice={{ id: "plan", tone: "critical", message: failure.message, blocking: true }} />;
      footer = (
        <DialogFooter>
          <Button padding={2} mode="bleed" text="Close" onClick={close} />
          {canRetryPlan(failure.code) ? <Button padding={2} text="Try again" onClick={reloadPlan} /> : null}
        </DialogFooter>
      );
      break;
    }
    case "translation": {
      const translation = subject?.kind === "translation" ? subject : undefined;

      if (!translation) {
        break;
      }

      const note = translationNote({
        language: translation.target.language,
        status: translation.target.status,
        sourceTitle: translation.row.title,
        source: SOURCE,
        translatedAt: readRecord(props.draft ?? props.published)?.translatedAt,
      });

      body = (
        <Stack gap={3}>
          <Text size={2} weight="medium">
            {note.heading}
          </Text>
          <Text size={1}>{note.status}</Text>
          <Text size={1} muted>
            {note.note}
          </Text>
        </Stack>
      );
      footer = (
        <DialogFooter>
          <Button padding={2} mode="bleed" text="Close" onClick={close} />
          <Button
            padding={2}
            tone="primary"
            text={`Open the ${SOURCE} page`}
            onClick={() => openDocument(translation.row.sourceId, translation.row.type, DEFAULT_LOCALE)}
          />
        </DialogFooter>
      );
      break;
    }
    case "unavailable": {
      const kind = subject?.kind === "missingLanguage" || subject?.kind === "unlinked" ? subject.kind : "none";

      body = <NoticeCard notice={{ id: "subject", tone: "caution", message: unavailableCopy(kind, SOURCE), blocking: true }} />;
      footer = (
        <DialogFooter>
          <Button padding={2} mode="bleed" text="Close" onClick={close} />
        </DialogFooter>
      );
      break;
    }
    case "configure": {
      if (!response) {
        break;
      }

      const field = props.categoryField ?? "name";
      const ready = !isRefreshing && canStart({ credits, unacknowledged: unacknowledged.length, notices });
      const words = row && sourceDocument ? translatableSummary(sourceDocument, props.titles).words : 0;
      const [categoryName] = categoryNames(props.draft ?? props.published, field, [DEFAULT_LOCALE], undefined);

      body = (
        <Stack gap={5}>
          <SourceLine
            language={getStudioLocaleTitle(DEFAULT_LOCALE)}
            title={row?.title ?? (category?.label?.kind === "document" ? category.label.text : categoryName?.value) ?? ""}
            uri={row?.uri}
            hasPublished={Boolean(props.published)}
            hasUnpublishedChanges={row?.hasUnpublishedChanges === true}
            useDraft={useDraft}
            onUseDraft={setUseDraft}
          />

          {notices.length > 0 ? (
            <Stack gap={3}>
              {notices.map((notice) => (
                <NoticeCard key={notice.id} notice={notice} onOpenSettings={openSettings} />
              ))}
            </Stack>
          ) : null}

          {row ? (
            <TargetList
              options={options}
              picks={picks}
              link={{ link, sourceId: row.sourceId, sourceTitle: row.title, step: row.step }}
              onSelect={(option, selected) => updatePicks(selectTarget(picks, option, selected))}
              onAcknowledge={(option, acknowledged) => updatePicks(acknowledgeTarget(picks, option, acknowledged))}
            />
          ) : null}

          {category ? (
            <CategoryNames
              rows={categoryNames(props.draft ?? props.published, field, targetLanguages(response), category.label)}
              note={{
                handFix: category.label?.handFix,
                plain: category.plain,
                source: SOURCE,
                document: props.isInPlaceDocument,
              }}
            />
          ) : null}

          <SavedResults
            saved={savedHere}
            busy={savedActions.busy}
            warningFor={(saved) => warningFor(saved.sourceId, saved.language)}
            onApply={applyFromPlan}
            onDiscard={discardFromPlan}
          />

          <AfterTranslating publish={publish} onPublish={setPublishChoice} />

          {row ? (
            <MoreOptions
              source={SOURCE}
              showSlugs={
                hasOwnSlug(row.step) && options.some((option) => !option.targetId && languages.includes(option.language))
              }
              slugs={slugs}
              onSlugs={setSlugChoice}
              instructions={instructions}
              onInstructions={setInstructions}
              charactersLeft={charactersLeft}
              creditsToday={requestsTodayCopy(response.creditsToday)}
            />
          ) : null}
        </Stack>
      );
      footer = (
        <DialogFooter
          note={runBlock(() => {
            if (isRefreshing) {
              return "Checking translations...";
            }
            if (row) {
              return summaryLine(words, credits, unacknowledged);
            }
            if (credits > 0) {
              return undefined;
            }
            return "Nothing to translate";
          })}
        >
          <Button padding={2} mode="bleed" text="Cancel" onClick={close} />
          <Button
            padding={2}
            tone="primary"
            text={startLabel(languages.length)}
            disabled={!ready}
            onClick={() => start(runJobs)}
          />
        </DialogFooter>
      );
      break;
    }
  }

  return (
    <Dialog id={DIALOG_ID} header="Translate with AI" width={1} onClose={close} footer={footer}>
      <DialogBody>
        {body}
        <SrOnly as="div" aria-live="polite" aria-atomic="true">
          {runAnnouncement(
            runBlock(() => {
              if (isRunning) {
                return ownRun;
              }
              if (showsDone) {
                return summaryRun;
              }
              return null;
            })
          )}
        </SrOnly>
      </DialogBody>
    </Dialog>
  );
}
