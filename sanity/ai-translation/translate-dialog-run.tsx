import { CheckmarkCircleIcon } from "@sanity/icons/CheckmarkCircle";
import { ClockIcon } from "@sanity/icons/Clock";
import { ErrorOutlineIcon } from "@sanity/icons/ErrorOutline";
import { RemoveCircleIcon } from "@sanity/icons/RemoveCircle";
import { WarningOutlineIcon } from "@sanity/icons/WarningOutline";
import { Box, Button, Card, Flex, Spinner, Stack, Text } from "@sanity/ui";
import {
  type JobIcon,
  jobLine,
  jobName,
  labelsOutcome,
  nextStep,
  noticeActionFor,
  otherJobHeading,
  type PairOutcome,
  pairOutcome,
  type ReplaceWarning,
  rateLimitCopy,
  runningNote,
  spokenName,
} from "./dialog-model";
import {
  describePaths,
  type FieldTitles,
  formatDuration,
  formatTimeLeft,
  joinWords,
  languageName,
  runProgressCopy,
  UPDATE_LINKS_NOTE,
} from "./present";
import { pairKey, type RunJob, runTotals, type TranslationRun, UPDATE_LINKS } from "./run-store";
import { Disclosure, NoticeActionButton, NoticeCard, ProgressBar, SavedResultControls } from "./translate-ui";

function StateIcon({ icon }: { icon: JobIcon }) {
  if (icon === "running") {
    return <Spinner muted />;
  }

  const Icon = {
    waiting: ClockIcon,
    done: CheckmarkCircleIcon,
    skipped: RemoveCircleIcon,
    failed: ErrorOutlineIcon,
    saved: WarningOutlineIcon,
    stopped: RemoveCircleIcon,
  }[icon];

  return (
    <Text size={2} muted={icon !== "failed"}>
      <Icon aria-hidden />
    </Text>
  );
}

function JobRow({ job, now }: { job: RunJob; now: number }) {
  const line = jobLine(job, now);

  return (
    <Flex align="center" gap={3}>
      <Box flex="none">
        <StateIcon icon={line.icon} />
      </Box>
      <Stack flex={1} gap={2}>
        <Text size={2} weight="medium">
          {jobName(job)}
        </Text>
        <Text size={1} muted>
          {line.detail ? `${line.label}. ${line.detail}` : line.label}
        </Text>
      </Stack>
      {line.elapsed ? (
        <Text size={1} muted>
          {line.elapsed}
        </Text>
      ) : null}
    </Flex>
  );
}

type RunningProps = { run: TranslationRun; jobs: RunJob[]; now: number; isPartOfSiteRun: boolean };

export function RunningView({ run, jobs, now, isPartOfSiteRun }: RunningProps) {
  const totals = runTotals(run, now);
  const pausedFor = run.pausedUntil !== undefined && run.pausedUntil > now ? run.pausedUntil - now : 0;
  const languages = jobs.flatMap((job) => (job.kind === "pair" ? [spokenName(job)] : []));
  const heading = languages.length > 0 ? `Translating into ${joinWords(languages)}` : "Translating the category name";
  const timeLeft = totals.remainingMs !== undefined ? `, ${formatTimeLeft(totals.remainingMs)}` : "";

  return (
    <Stack gap={5}>
      <Stack gap={3}>
        <Flex align="center" gap={3} justify="space-between" wrap="wrap">
          <Text size={1} weight="semibold">
            {heading}
          </Text>
          <Text size={1} muted>
            {formatDuration(totals.elapsedMs)}
            {timeLeft}
          </Text>
        </Flex>
        <ProgressBar
          value={totals.finished}
          max={totals.total}
          label="Translation progress"
          valueText={runProgressCopy(totals)}
        />
        <Text size={1} muted>
          {runProgressCopy(totals)}
        </Text>
      </Stack>

      {pausedFor > 0 ? (
        <Card padding={3} radius={2} tone="caution">
          <Text size={1}>{rateLimitCopy(pausedFor)}</Text>
        </Card>
      ) : null}

      <Stack gap={3}>
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} now={now} />
        ))}
      </Stack>

      <Text size={1} muted>
        {runningNote(isPartOfSiteRun)}
      </Text>
    </Stack>
  );
}

type OutcomeActions = {
  onOpen: (targetId: string, language: string) => void;
  onApply: (outcome: PairOutcome, overwrite: boolean) => void;
  onDiscard: (outcome: PairOutcome) => void;
  onOpenSettings: () => void;
  onUpdateLinks: () => void;
  isUpdatingLinks: boolean;
  /** The saved result's action in flight: which pair, and which button. */
  busy: { key: string; action: "apply" | "discard" } | null;
  /** Applied or discarded in this view, by job id. */
  settled: ReadonlyMap<string, "applied" | "discarded">;
  warningFor: (outcome: PairOutcome) => ReplaceWarning | undefined;
};

function PathList({
  paths,
  document,
  titles,
}: {
  paths: string[];
  document: Record<string, unknown> | null;
  titles: FieldTitles;
}) {
  return (
    <Stack gap={2}>
      {describePaths(paths, document ?? undefined, titles).map((line) => (
        <Text key={line} size={1} muted>
          {line}
        </Text>
      ))}
    </Stack>
  );
}

function OutcomeRow({
  outcome,
  source,
  titles,
  actions,
}: {
  outcome: PairOutcome;
  source: { document: Record<string, unknown> | null; language: string };
  titles: FieldTitles;
  actions: OutcomeActions;
}) {
  const settled = actions.settled.get(outcome.id);
  const name = languageName(outcome.language);
  const canApply = outcome.canApply && !settled;
  const key = pairKey(outcome.sourceId, outcome.language);

  return (
    <Stack gap={2}>
      <Flex align="center" gap={3} justify="space-between">
        <Text size={2}>{settled ? `${outcome.title}: saved result ${settled}` : outcome.line}</Text>
        {outcome.targetId ? (
          <Button
            fontSize={1}
            mode="ghost"
            padding={2}
            text="Open"
            aria-label={`Open the ${name} translation`}
            onClick={() => actions.onOpen(outcome.targetId as string, outcome.language)}
          />
        ) : null}
      </Flex>

      {outcome.message && !settled ? (
        <Text size={1} muted>
          {outcome.message}
        </Text>
      ) : null}

      <NoticeActionButton action={outcome.action} onOpenSettings={actions.onOpenSettings} />

      {canApply ? (
        <SavedResultControls
          name={name}
          busy={actions.busy?.key === key ? actions.busy.action : null}
          disabled={actions.busy !== null}
          warning={actions.warningFor(outcome)}
          applyTone="primary"
          onApply={(overwrite) => actions.onApply(outcome, overwrite)}
          onDiscard={() => actions.onDiscard(outcome)}
        />
      ) : null}

      {outcome.keptNote ? (
        <Disclosure label="Details">
          <Stack gap={3}>
            <Stack gap={2}>
              <Text size={1}>{outcome.keptNote}</Text>
              <PathList paths={outcome.keptPaths} document={source.document} titles={titles} />
            </Stack>
            {outcome.guardedPaths.length > 0 ? (
              <Stack gap={2}>
                <Text size={1}>{`Put back as the ${source.language} page has it:`}</Text>
                <PathList paths={outcome.guardedPaths} document={source.document} titles={titles} />
              </Stack>
            ) : null}
          </Stack>
        </Disclosure>
      ) : null}
    </Stack>
  );
}

/** A category run's names, or the Update links pass after a run that published. */
function OtherJobRow({ job, categoryId }: { job: RunJob; categoryId: string }) {
  if (job.kind === "pair") {
    return null;
  }

  const names = job.kind === "labels" ? labelsOutcome(job, categoryId) : [];
  const line = jobLine(job, job.finishedAt ?? 0);

  return (
    <Stack gap={2}>
      <Text size={2}>{otherJobHeading(job)}</Text>
      {names.map((name) => (
        <Text key={name.language} size={1}>
          {name.title}: {name.value}
        </Text>
      ))}
      {line.detail ? (
        <Text size={1} muted>
          {line.detail}
        </Text>
      ) : null}
    </Stack>
  );
}

type DoneProps = {
  run: TranslationRun;
  jobs: RunJob[];
  documentId: string;
  source: { document: Record<string, unknown> | null; language: string };
  titles: FieldTitles;
  /** `pairKey`s the latest plan lists a saved result for. */
  saved: ReadonlySet<string>;
  actions: OutcomeActions;
};

/** One line per language with Open, a stop that needs the editor only when there is one, and the next step after drafts. */
export function DoneView({ run, jobs, documentId, source, titles, saved, actions }: DoneProps) {
  const stop = run.stopReason && run.stopReason.code !== "stopped" ? run.stopReason : undefined;
  const next = nextStep(jobs, source.language);

  return (
    <Stack gap={5}>
      {stop ? (
        <NoticeCard
          notice={{ id: stop.code, tone: "critical", message: stop.message, blocking: false, action: noticeActionFor(stop.code) }}
          onOpenSettings={actions.onOpenSettings}
        />
      ) : null}

      <Stack gap={3}>
        {jobs.map((job) =>
          job.kind === "pair" ? (
            <OutcomeRow
              key={job.id}
              outcome={pairOutcome(job, source.language, { saved: saved.has(pairKey(job.sourceId, job.language)) })}
              source={source}
              titles={titles}
              actions={actions}
            />
          ) : (
            <OtherJobRow key={job.id} job={job} categoryId={documentId} />
          )
        )}
      </Stack>

      {next ? (
        <Stack gap={3}>
          <Text size={1} muted>
            {next}
          </Text>
          <Text size={1} muted>
            {UPDATE_LINKS_NOTE}
          </Text>
          <Flex>
            <Button
              fontSize={1}
              mode="ghost"
              padding={2}
              text={actions.isUpdatingLinks ? "Updating links..." : UPDATE_LINKS}
              disabled={actions.isUpdatingLinks}
              onClick={actions.onUpdateLinks}
            />
          </Flex>
        </Stack>
      ) : null}
    </Stack>
  );
}
