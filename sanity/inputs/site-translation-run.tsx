// The whole-site run as it goes and once it is done: progress, each job, the summary, the AI drafts to publish,
// and paid results kept for later. Rendered by the Settings > Translations panel.

import { Badge, Button, Card, Dialog, Flex, Spinner, Stack, Text } from "@sanity/ui";
import type { useToast } from "@sanity/ui/toast";
import * as React from "react";
import { useRouter } from "sanity/router";
import { publish, relink } from "../ai-translation/api";
import { applyWarning, rateLimitCopy } from "../ai-translation/dialog-model";
import { formatDuration, formatTimeLeft, jobStatePresentation, languageName, runProgressCopy } from "../ai-translation/present";
import {
  pairKey,
  RUN_STEPS,
  type RunJob,
  relinkAll,
  runStore,
  runTotals,
  type TranslationRun,
} from "../ai-translation/run-store";
import {
  aiDraftsCopy,
  draftsToPublish,
  publishButtonText,
  publishConfirmCopy,
  publishCopy,
  publishInBatches,
  runSummary,
  SITE_GROUP_TITLES,
  type SkippedDraft,
  savedResultItems,
  skippedDrafts,
} from "../ai-translation/site-run";
import {
  DialogBody,
  DialogFooter,
  Disclosure,
  ProgressBar,
  SavedResultControls,
  useSavedResultActions,
} from "../ai-translation/translate-ui";
import type { PlanResponse } from "../ai-translation/wire";
import { getLocaleTitle } from "../i18n";
import type { StudioFetch } from "../lib/studio-fetch";

type Task =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; message: string; skipped?: SkippedDraft[] }
  | { status: "failed"; message: string };

type Toast = ReturnType<typeof useToast>;

export function RunProgress({ run, now, response }: { run: TranslationRun; now: number; response: PlanResponse | null }) {
  const totals = runTotals(run, now);
  const pausedFor = run.pausedUntil !== undefined && run.pausedUntil > now ? run.pausedUntil - now : 0;
  const timing = [
    formatDuration(totals.elapsedMs),
    ...(totals.remainingMs !== undefined ? [formatTimeLeft(totals.remainingMs)] : []),
  ].join(" · ");

  return (
    <Stack gap={5}>
      <Stack gap={3}>
        <Flex align="center" gap={3} justify="space-between" wrap="wrap">
          <Flex align="center" gap={2}>
            <Spinner muted />
            <Text size={1} weight="medium">
              {run.status === "stopping" ? "Stopping after the requests already sent" : "Translating the site"}
            </Text>
          </Flex>
          <Text size={1} muted>
            {timing}
          </Text>
        </Flex>
        <ProgressBar
          value={totals.finished}
          max={totals.total}
          label="Translation progress"
          valueText={runProgressCopy(totals)}
        />
        {pausedFor > 0 ? (
          <Text size={1} muted>
            {rateLimitCopy(pausedFor)}
          </Text>
        ) : null}
      </Stack>
      <JobList run={run} response={response} />
    </Stack>
  );
}

function JobList({ run, response }: { run: TranslationRun; response: PlanResponse | null }) {
  const { navigateIntent } = useRouter();
  const typeOf = (sourceId: string) => response?.plan.rows.find((row) => row.sourceId === sourceId)?.type;
  const groups = RUN_STEPS.map((step) => ({ step, jobs: run.jobs.filter((job) => job.step === step) })).filter(
    ({ jobs }) => jobs.length > 0
  );

  return (
    <Stack gap={3}>
      {groups.map((group) => (
        <Stack key={group.step} gap={2}>
          <Text size={1} weight="medium">
            {SITE_GROUP_TITLES[group.step]}
          </Text>
          <Card border radius={2}>
            {group.jobs.map((job, index) => (
              <JobRow
                key={job.id}
                job={job}
                isFirst={index === 0}
                type={job.kind === "pair" ? typeOf(job.sourceId) : undefined}
                onOpen={(id, type) =>
                  navigateIntent("edit", { id, type, language: job.kind === "pair" ? job.language : undefined })
                }
              />
            ))}
          </Card>
        </Stack>
      ))}
    </Stack>
  );
}

function JobRow(props: { job: RunJob; isFirst: boolean; type?: string; onOpen: (id: string, type: string) => void }) {
  const { job, type } = props;
  const presented = jobStatePresentation(job.state);
  const name = job.kind === "pair" ? `${job.title} (${getLocaleTitle(job.language)})` : job.title;
  const targetId = job.kind === "pair" ? job.result?.targetId : undefined;
  const note = job.state === "queued" || job.state === "running" || job.state === "stopped" ? undefined : job.message;

  return (
    <Card borderTop={!props.isFirst} padding={3}>
      <Flex align="center" gap={3}>
        <Stack flex={1} gap={2}>
          <Text size={1} weight="medium" textOverflow="ellipsis">
            {name}
          </Text>
          {note ? (
            <Text size={1} muted>
              {note}
            </Text>
          ) : null}
        </Stack>
        {job.state === "running" ? <Spinner muted /> : null}
        <Badge tone={presented.tone}>{presented.label}</Badge>
        {targetId && type ? (
          <Button
            text="Open"
            aria-label={`Open ${name}`}
            mode="bleed"
            fontSize={1}
            padding={2}
            onClick={() => props.onOpen(targetId, type)}
          />
        ) : null}
      </Flex>
    </Card>
  );
}

function TaskNote({ task }: { task: Task }) {
  if (task.status === "running") {
    return <Spinner muted />;
  }

  if (task.status === "idle") {
    return null;
  }

  return (
    <Text size={1} muted={task.status === "done"}>
      {task.message}
    </Text>
  );
}

export function RunSummaryCard(props: { run: TranslationRun; response: PlanResponse | null }) {
  const { run, response } = props;
  const summary = runSummary(run);
  const outcome = [summary.headline, summary.credits, run.publish ? `${summary.published} published` : "saved as drafts"].join(
    " · "
  );

  return (
    <Card padding={3} radius={2} tone={summary.tone}>
      <Stack gap={4}>
        <Flex align="flex-start" gap={3}>
          <Stack flex={1} gap={2}>
            <Text size={1} weight="medium">
              {run.status === "stopped" ? "Translation stopped" : "Translation finished"}
            </Text>
            <Text size={1} muted>
              {outcome}
            </Text>
            {summary.stopped ? (
              <Text size={1} muted>
                {summary.stopped}
              </Text>
            ) : null}
          </Stack>
          <Button text="Dismiss" mode="bleed" fontSize={1} padding={2} onClick={() => runStore.clear()} />
        </Flex>

        {summary.failures.length > 0 ? (
          <Stack gap={2}>
            {summary.failures.map((failure) => (
              <Text key={failure.id} size={1}>
                {failure.title}
                {failure.language ? ` (${getLocaleTitle(failure.language)})` : ""}: {failure.message}
              </Text>
            ))}
            <Text size={1} muted>
              Translate the site again to retry them.
            </Text>
          </Stack>
        ) : null}

        {summary.savedResults.length > 0 ? (
          <Text size={1}>Some paid results are saved but not applied. Apply or discard them below, for free.</Text>
        ) : null}

        <Disclosure label="Each translation">
          <JobList run={run} response={response} />
        </Disclosure>
      </Stack>
    </Card>
  );
}

/** "Publish N AI drafts": from the plan, so it lasts past Dismiss, a reload or another run. */
export function AiDrafts(props: {
  response: PlanResponse;
  run: TranslationRun | null;
  disabled: boolean;
  studioFetch: StudioFetch;
  toast: Toast;
  onPublishing: (isPublishing: boolean) => void;
  onChanged: () => void;
}) {
  const { response, studioFetch, toast } = props;
  const drafts = draftsToPublish(response);
  const [task, setTask] = React.useState<Task>({ status: "idle" });
  const [isConfirming, setIsConfirming] = React.useState(false);
  const skipped = task.status === "done" ? (task.skipped ?? []) : [];

  const runPublish = async () => {
    setIsConfirming(false);
    setTask({ status: "running" });
    props.onPublishing(true);

    const answer = await publishInBatches((ids, revs) => publish(studioFetch, ids, revs), drafts.ids);

    if (!answer.ok) {
      setTask({ status: "failed", message: answer.error.message });
      props.onPublishing(false);
      props.onChanged();

      return;
    }

    // Only now are the translations published variants that references can move to.
    const relinked = await relinkAll((input) => relink(studioFetch, input), true);
    const message = publishCopy(answer.data, relinked);

    setTask({ status: "done", message, skipped: skippedDrafts(answer.data, { response, run: props.run }) });
    props.onPublishing(false);
    toast.push({
      status: relinked.ok && answer.data.skipped.length === 0 ? "success" : "warning",
      title: "AI drafts published",
      description: message,
    });
    props.onChanged();
  };

  if (drafts.ids.length === 0 && skipped.length === 0 && task.status !== "failed") {
    return null;
  }

  return (
    <Stack gap={3}>
      <Text size={1} weight="medium">
        AI drafts
      </Text>
      {drafts.ids.length > 0 ? (
        <>
          <Text size={1} muted>
            {aiDraftsCopy(drafts)}
          </Text>
          <Flex align="center" gap={3} wrap="wrap">
            <Button
              text={publishButtonText(drafts)}
              tone="primary"
              fontSize={1}
              padding={2}
              disabled={props.disabled || task.status === "running"}
              onClick={() => setIsConfirming(true)}
            />
            <TaskNote task={task} />
          </Flex>
        </>
      ) : (
        <TaskNote task={task} />
      )}
      {skipped.length > 0 ? (
        <Stack gap={2}>
          {skipped.map((item) => (
            <Text key={item.id} size={1}>
              {item.title}: {item.reason}
            </Text>
          ))}
        </Stack>
      ) : null}

      {isConfirming ? (
        <Dialog
          id="site-translation-publish-confirm"
          header="Publish the AI drafts?"
          width={1}
          onClose={() => setIsConfirming(false)}
          footer={
            <DialogFooter>
              <Button text="Cancel" mode="bleed" padding={2} onClick={() => setIsConfirming(false)} />
              <Button text={publishButtonText(drafts)} tone="primary" padding={2} onClick={() => void runPublish()} />
            </DialogFooter>
          }
        >
          <DialogBody>
            <Text size={1}>{publishConfirmCopy(drafts)}</Text>
          </DialogBody>
        </Dialog>
      ) : null}
    </Stack>
  );
}

export function SavedResults(props: { response: PlanResponse; publishAfter: boolean; disabled: boolean; onChanged: () => void }) {
  const { response } = props;
  const saved = useSavedResultActions(props.onChanged);
  const items = savedResultItems(response);

  return (
    <Stack gap={3}>
      <Stack gap={2}>
        <Text size={1} weight="medium">
          Saved results
        </Text>
        <Text size={1} muted>
          These translations were paid for, but the page changed before they could be written. Apply one to write it now, or
          discard it; both are free.
        </Text>
      </Stack>
      <Card border radius={2}>
        {items.map((item, index) => {
          const key = pairKey(item.sourceId, item.language);
          const pair = { sourceId: item.sourceId, language: item.language };
          const row = response.plan.rows.find(({ sourceId }) => sourceId === item.sourceId);
          const name = `${item.title} (${languageName(item.language)})`;

          return (
            <Card key={key} borderTop={index > 0} padding={3}>
              <Stack gap={3}>
                <Text size={1} textOverflow="ellipsis">
                  {`${item.title} (${item.languageTitle})`}
                </Text>
                <SavedResultControls
                  name={name}
                  busy={saved.busy?.key === key ? saved.busy.action : null}
                  disabled={props.disabled || saved.busy !== null}
                  warning={applyWarning(row, item.language, { forced: saved.needsOverwrite.has(key) })}
                  onApply={(overwrite) =>
                    void saved.apply({ ...pair, publish: props.publishAfter, ...(overwrite ? { overwrite } : {}) }, name)
                  }
                  onDiscard={() => void saved.discard(pair, name)}
                />
              </Stack>
            </Card>
          );
        })}
      </Card>
    </Stack>
  );
}
