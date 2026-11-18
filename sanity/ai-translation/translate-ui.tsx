import { ChevronDownIcon } from "@sanity/icons/ChevronDown";
import { ChevronRightIcon } from "@sanity/icons/ChevronRight";
import { LaunchIcon } from "@sanity/icons/Launch";
import { Box, Button, Card, Checkbox, Flex, Radio, rem, Stack, Text, useTheme_v2 } from "@sanity/ui";
import { useToast } from "@sanity/ui/toast";
import * as React from "react";
import { useClient, useEditState } from "sanity";
import { sanityConfig } from "../config";
import { AI_TRANSLATION_FIELD, SANITY_SINGLETON_SITE_SETTINGS_ID } from "../constants";
import { run } from "../lib/run";
import { useStudioFetch } from "../lib/studio-fetch";
import { applySaved, discardSaved, fetchPlan, linkTranslation, relink } from "./api";
import {
  applyAnswer,
  discardAnswer,
  isTranslateSwitchedOff,
  linkAnswer,
  linkConfirmCopy,
  linkedToast,
  linkLabel,
  type Notice,
  type NoticeAction,
  noticeLink,
  type ReplaceWarning,
  updateLinksToast,
} from "./dialog-model";
import type { RunStep } from "./plan";
import { translatedAtById } from "./present";
import { pairKey, relinkAll } from "./run-store";
import type { ApplyInput, DiscardInput, LinkInput, PlanRequest, PlanResponse } from "./wire";

/** A clock for timers only: it ticks while `active`, so a finished view stops re-rendering. */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!active) {
      return;
    }

    setNow(Date.now());

    const timer = setInterval(() => setNow(Date.now()), intervalMs);

    return () => clearInterval(timer);
  }, [active, intervalMs]);

  return now;
}

const TRANSLATED_AT_QUERY = `*[_id in $ids]{ _id, "at": ${AI_TRANSLATION_FIELD}.translatedAt }`;

/** When the AI wrote each translation, by published id: the plan carries statuses only, so the Studio reads the dates. */
export function useTranslatedAt(ids: readonly string[], plan: unknown): Readonly<Record<string, string>> {
  const client = useClient({ apiVersion: sanityConfig.apiVersion });
  const key = [...new Set(ids)].sort().join(",");
  const [dates, setDates] = React.useState<Readonly<Record<string, string>>>({});

  // biome-ignore lint/correctness/useExhaustiveDependencies: each new `plan` reads again, since a run may have rewritten a date.
  React.useEffect(() => {
    const published = key === "" ? [] : key.split(",");

    if (published.length === 0) {
      setDates({});

      return;
    }

    const controller = new AbortController();
    const params = { ids: [...published, ...published.map((id) => `drafts.${id}`)] };

    client
      .fetch<{ _id: string; at?: unknown }[]>(TRANSLATED_AT_QUERY, params, { perspective: "raw", signal: controller.signal })
      .then((rows) => setDates(translatedAtById(rows)))
      // A date is a nicety: without it the row reads "Translated by AI".
      .catch(() => undefined);

    return () => controller.abort();
  }, [client, key, plan]);

  return dates;
}

// The Dialog header draws no border; pinned, this one stays under it while the body scrolls.
const PINNED_DIVIDER = { position: "sticky", top: 0, zIndex: 1 } as const;

/** A Dialog's body: the divider under the header, then the padding the header's title sits at. */
export function DialogBody({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Card borderTop style={PINNED_DIVIDER} />
      <Box padding={4}>{children}</Box>
    </>
  );
}

// The note wraps beside the buttons instead of pushing them onto a left-aligned row of their own.
const FOOTER_NOTE_MIN_WIDTH = "12em";

/** A Dialog's footer as the Studio lays out its own (padding 3, buttons at padding 2), the note on the body's left edge. */
export function DialogFooter({ note, children }: { note?: string; children: React.ReactNode }) {
  return (
    <Card borderTop>
      <Flex align="center" gap={3} padding={3} wrap="wrap">
        <Box flex={1} paddingLeft={2} style={{ minWidth: FOOTER_NOTE_MIN_WIDTH }}>
          {note ? (
            <Text size={1} muted>
              {note}
            </Text>
          ) : null}
        </Box>
        <Flex gap={3} justify="flex-end" wrap="wrap">
          {children}
        </Flex>
      </Flex>
    </Card>
  );
}

// A bare button, so the toggle reads like the Studio's own collapsible fieldsets rather than a button.
const TOGGLE_RESET = {
  appearance: "none",
  background: "none",
  border: 0,
  padding: 0,
  margin: 0,
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
  textAlign: "left",
} as const;

const FULL_WIDTH_TOGGLE = { ...TOGGLE_RESET, display: "block", width: "100%" } as const;

/** A caret, a label and an optional aside on the right, as one button that shows and hides a panel. */
export function ToggleButton(props: {
  isOpen: boolean;
  controls: string;
  label: string;
  aside?: string;
  fullWidth?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={props.isOpen}
      aria-controls={props.isOpen ? props.controls : undefined}
      style={props.fullWidth ? FULL_WIDTH_TOGGLE : TOGGLE_RESET}
      onClick={props.onToggle}
    >
      <Flex align="center" gap={2}>
        <Text size={1} muted>
          {props.isOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </Text>
        <Box flex={1}>
          <Text size={1} weight="medium" textOverflow="ellipsis">
            {props.label}
          </Text>
        </Box>
        {props.aside ? (
          <Text size={1} muted>
            {props.aside}
          </Text>
        ) : null}
      </Flex>
    </button>
  );
}

/** A caret and a label that show and hide what follows them; the label sits on the text's left edge. */
export function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  const [isOpen, setIsOpen] = React.useState(false);
  const panelId = React.useId();

  return (
    <Stack gap={4}>
      <Flex>
        <ToggleButton isOpen={isOpen} controls={panelId} label={label} onToggle={() => setIsOpen((open) => !open)} />
      </Flex>

      {isOpen ? <Box id={panelId}>{children}</Box> : null}
    </Stack>
  );
}

type Choice<T extends string> = { value: T; title: string };

/** A label and its radios on one line, wrapping when the dialog is narrow. */
export function InlineChoice<T extends string>(props: {
  label: string;
  value: T;
  choices: readonly Choice<T>[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const labelId = React.useId();

  return (
    <Flex align="center" gap={4} role="radiogroup" aria-labelledby={labelId} wrap="wrap">
      <Text id={labelId} size={1} weight="medium">
        {props.label}
      </Text>
      {props.choices.map((choice) => (
        <Flex key={choice.value} as="label" align="center" gap={2}>
          <Radio
            name={labelId}
            value={choice.value}
            checked={props.value === choice.value}
            disabled={props.disabled}
            onChange={() => props.onChange(choice.value)}
          />
          <Text as="span" size={1}>
            {choice.title}
          </Text>
        </Flex>
      ))}
    </Flex>
  );
}

/** A checkbox with a label, its description read with it, then anything else; the label's line centers on the box. */
export function CheckboxRow(props: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  aside?: React.ReactNode;
  description?: React.ReactNode;
  /** More text the checkbox is described by, such as a caution under the row. */
  describedBy?: string;
  children?: React.ReactNode;
}) {
  const id = React.useId();
  const descriptionId = React.useId();
  const { input } = useTheme_v2();
  const describedBy = [props.description ? descriptionId : undefined, props.describedBy].filter(Boolean).join(" ");

  return (
    <Flex align="flex-start" gap={3}>
      <Box flex="none">
        <Checkbox
          id={id}
          checked={props.checked}
          disabled={props.disabled}
          aria-describedby={describedBy || undefined}
          onChange={(event) => props.onChange(event.currentTarget.checked)}
        />
      </Box>
      <Stack flex={1} gap={2}>
        <Flex align="center" gap={3} justify="space-between" wrap="wrap" style={{ minHeight: rem(input.checkbox.size) }}>
          <Text as="label" htmlFor={id} size={1} weight="medium">
            {props.label}
          </Text>
          {props.aside}
        </Flex>
        {props.description ? (
          <Stack id={descriptionId} gap={2}>
            {props.description}
          </Stack>
        ) : null}
        {props.children}
      </Stack>
    </Flex>
  );
}

/** A checkbox beside one line of text, for options rather than rows. */
export function CheckboxLine(props: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Flex as="label" align="center" gap={2}>
      <Checkbox
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      <Text as="span" size={1}>
        {props.label}
      </Text>
    </Flex>
  );
}

// A primary-tone Card fill vanishes in the dark scheme; the badge dot stays saturated in both.
const PROGRESS_TRACK = "var(--card-border-color)";
const PROGRESS_FILL = "var(--card-badge-primary-dot-color)";

/** @sanity/ui has no progress bar: a filled Card inside a track, with the ARIA a screen reader needs. */
export function ProgressBar({ value, max, label, valueText }: { value: number; max: number; label: string; valueText: string }) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;

  return (
    <Card
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      overflow="hidden"
      radius={2}
      tone="inherit"
      style={{ backgroundColor: PROGRESS_TRACK }}
    >
      {percent > 0 ? (
        <Card padding={1} radius={2} tone="inherit" style={{ width: `${percent}%`, backgroundColor: PROGRESS_FILL }} />
      ) : (
        <Box padding={1} />
      )}
    </Card>
  );
}

/** Where a notice sends the editor next: Settings in this Studio, or Sanity Manage for the spending limit. */
export function NoticeActionButton({ action, onOpenSettings }: { action?: NoticeAction; onOpenSettings?: () => void }) {
  const link = noticeLink(action);

  if (action === "openSettings" && onOpenSettings) {
    return (
      <Flex>
        <Button fontSize={1} mode="ghost" padding={2} text="Open Settings" onClick={onOpenSettings} />
      </Flex>
    );
  }

  if (!link) {
    return null;
  }

  return (
    <Flex>
      <Button
        as="a"
        href={link.href}
        target="_blank"
        rel="noreferrer"
        fontSize={1}
        iconRight={LaunchIcon}
        mode="ghost"
        padding={2}
        text={link.text}
      />
    </Flex>
  );
}

export function NoticeCard({ notice, onOpenSettings }: { notice: Notice; onOpenSettings?: () => void }) {
  return (
    <Card padding={3} radius={2} tone={notice.tone}>
      <Stack gap={3}>
        <Text size={1}>{notice.message}</Text>
        <NoticeActionButton action={notice.action} onOpenSettings={onOpenSettings} />
      </Stack>
    </Card>
  );
}

export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <Text as="label" htmlFor={htmlFor} size={1} weight="medium">
      {children}
    </Text>
  );
}

/** A plan read: `previous` keeps the last plan on screen while a new one loads, so a view does not jump. */
export type PlanState =
  | { status: "loading"; previous?: PlanResponse }
  | { status: "failed"; message: string; code: string }
  | { status: "ready"; response: PlanResponse };

/** One free plan read per `request` (memoize it), and again on `reload`; the dialog's, and the panel's to share. */
export function useTranslationPlan(request: PlanRequest): { state: PlanState; reload: () => void } {
  const fetcher = useStudioFetch();
  const [state, setState] = React.useState<PlanState>({ status: "loading" });
  const [nonce, setNonce] = React.useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is the reload; it is read by nothing else.
  React.useEffect(() => {
    const controller = new AbortController();

    setState((current) => ({
      status: "loading",
      previous: run(() => {
        if (current.status === "ready") {
          return current.response;
        }
        if (current.status === "loading") {
          return current.previous;
        }
        return undefined;
      }),
    }));

    void fetchPlan(fetcher, request, controller.signal).then((answer) => {
      if (controller.signal.aborted) {
        return;
      }

      setState(
        answer.ok
          ? { status: "ready", response: answer.data }
          : { status: "failed", message: answer.error.message, code: answer.error.code }
      );
    });

    return () => controller.abort();
  }, [fetcher, request, nonce]);

  const reload = React.useCallback(() => setNonce((count) => count + 1), []);

  return { state, reload };
}

/** Settings' published daily limit is 0: Translate with AI is off, as the route answers. */
export function useTranslateSwitchedOff(): boolean {
  const { published } = useEditState(SANITY_SINGLETON_SITE_SETTINGS_ID, "siteSettings", "low");

  return isTranslateSwitchedOff(published);
}

type SavedAction = { key: string; action: "apply" | "discard" };

/** Apply and Discard for saved results, free in both views; `onChanged` reads the plan again after either. */
export function useSavedResultActions(onChanged: () => void) {
  const fetcher = useStudioFetch();
  const toast = useToast();
  const [busy, setBusy] = React.useState<SavedAction | null>(null);
  const [needsOverwrite, setNeedsOverwrite] = React.useState<ReadonlySet<string>>(() => new Set());

  const apply = async (input: ApplyInput, name: string): Promise<boolean> => {
    const key = pairKey(input.sourceId, input.language);

    setBusy({ key, action: "apply" });

    const { outcome, toast: copy } = applyAnswer(await applySaved(fetcher, input), name);

    setBusy(null);
    toast.push({ ...copy, closable: true });

    // The plan was older than an edit: ask for the acknowledgement now, as the plan would have.
    if (outcome === "needsOverwrite") {
      setNeedsOverwrite((current) => new Set([...current, key]));
    }

    if (outcome === "applied") {
      onChanged();
    }

    return outcome === "applied";
  };

  const discard = async (input: DiscardInput, name: string): Promise<boolean> => {
    setBusy({ key: pairKey(input.sourceId, input.language), action: "discard" });

    const { ok, toast: copy } = discardAnswer(await discardSaved(fetcher, input), name);

    setBusy(null);
    toast.push({ ...copy, closable: true });
    onChanged();

    return ok;
  };

  return { busy, needsOverwrite, apply, discard };
}

/** Update links, from the done view or the panel: always with publish, which the copy beside it says. */
export function useUpdateLinks(onDone?: () => void) {
  const fetcher = useStudioFetch();
  const toast = useToast();
  const [isUpdating, setIsUpdating] = React.useState(false);

  const update = async () => {
    setIsUpdating(true);

    const answer = await relinkAll((input) => relink(fetcher, input), true);

    setIsUpdating(false);
    toast.push({ ...updateLinksToast(answer), closable: true });
    onDone?.();
  };

  return { isUpdating, update };
}

export type LinkStep =
  | { key: string; status: "checking" | "linking" }
  | { key: string; status: "confirm"; title?: string }
  | { key: string; status: "failed"; message: string };

/** "Link as the Italian translation": a free preview answers the document's title, then the editor confirms. */
export function useLinkTranslation(onLinked: () => void) {
  const fetcher = useStudioFetch();
  const toast = useToast();
  const [step, setStep] = React.useState<LinkStep | null>(null);

  const check = async (input: Omit<LinkInput, "preview">) => {
    const key = pairKey(input.sourceId, input.language);

    setStep({ key, status: "checking" });

    const answer = linkAnswer(await linkTranslation(fetcher, { ...input, preview: true }));

    setStep(
      answer.status === "failed"
        ? { key, status: "failed", message: answer.message }
        : { key, status: "confirm", ...(answer.title ? { title: answer.title } : {}) }
    );
  };

  const confirm = async (input: Omit<LinkInput, "preview">) => {
    const key = pairKey(input.sourceId, input.language);

    setStep({ key, status: "linking" });

    const answer = linkAnswer(await linkTranslation(fetcher, input));

    if (answer.status === "failed") {
      setStep({ key, status: "failed", message: answer.message });

      return;
    }

    setStep(null);
    toast.push({ ...linkedToast(input.language), closable: true });
    onLinked();
  };

  return { step, check, confirm, cancel: () => setStep(null) };
}

/** Under a row whose language already has its own document there: the link button, then its confirm, in both views. */
export function LinkTranslationControl(props: {
  link: ReturnType<typeof useLinkTranslation>;
  input: Omit<LinkInput, "preview">;
  /** The plan's title for that document, until the preview answers with its own. */
  title?: string;
  sourceTitle: string;
  step: RunStep;
}) {
  const { link, input } = props;
  const current = link.step?.key === pairKey(input.sourceId, input.language) ? link.step : null;
  const isBusy = link.step?.status === "checking" || link.step?.status === "linking";

  if (current?.status === "confirm" || current?.status === "linking") {
    const title = current.status === "confirm" ? (current.title ?? props.title) : props.title;

    return (
      <Card padding={3} radius={2} tone="caution">
        <Stack gap={3}>
          <Text size={1}>
            {linkConfirmCopy({ title, language: input.language, sourceTitle: props.sourceTitle, step: props.step })}
          </Text>
          <Flex gap={3} wrap="wrap">
            <Button
              fontSize={1}
              mode="ghost"
              padding={2}
              tone="primary"
              text={current.status === "linking" ? "Linking..." : "Link"}
              disabled={isBusy}
              onClick={() => void link.confirm(input)}
            />
            <Button fontSize={1} mode="bleed" padding={2} text="Cancel" disabled={isBusy} onClick={link.cancel} />
          </Flex>
        </Stack>
      </Card>
    );
  }

  return (
    <Stack gap={2}>
      <Flex>
        <Button
          fontSize={1}
          mode="ghost"
          padding={2}
          text={current?.status === "checking" ? "Checking..." : linkLabel(input.language)}
          disabled={isBusy}
          onClick={() => void link.check(input)}
        />
      </Flex>
      {current?.status === "failed" ? <Text size={1}>{current.message}</Text> : null}
    </Stack>
  );
}

/** Apply and Discard under a saved result, with the caution first when applying replaces someone's changes. */
export function SavedResultControls(props: {
  /** The language in prose, for the buttons' accessible names. */
  name: string;
  busy: SavedAction["action"] | null;
  disabled: boolean;
  warning?: ReplaceWarning;
  /** Inside a caution card already, so the caution needs no card of its own. */
  isInCard?: boolean;
  applyTone?: "primary";
  onApply: (overwrite: boolean) => void;
  onDiscard: () => void;
}) {
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [isConfirmingDiscard, setIsConfirmingDiscard] = React.useState(false);
  const { warning } = props;
  const caution = warning ? (
    <Stack gap={3}>
      <Text size={1}>{warning.message}</Text>
      {warning.acknowledgement ? (
        <CheckboxLine label={warning.acknowledgement} checked={acknowledged} onChange={setAcknowledged} />
      ) : null}
    </Stack>
  ) : null;

  if (isConfirmingDiscard) {
    const question = `Discard the saved ${props.name} result? The AI request it took still counts, and nothing offers it again.`;

    return (
      <Stack gap={3}>
        <Text size={1}>{question}</Text>
        <Flex gap={3} wrap="wrap">
          <Button
            fontSize={1}
            mode="ghost"
            padding={2}
            tone="critical"
            text={props.busy === "discard" ? "Discarding..." : "Discard"}
            disabled={props.disabled}
            onClick={props.onDiscard}
          />
          <Button
            fontSize={1}
            mode="bleed"
            padding={2}
            text="Keep it"
            disabled={props.disabled}
            onClick={() => setIsConfirmingDiscard(false)}
          />
        </Flex>
      </Stack>
    );
  }

  return (
    <Stack gap={3}>
      {caution && props.isInCard ? caution : null}
      {caution && !props.isInCard ? (
        <Card padding={3} radius={2} tone="caution">
          {caution}
        </Card>
      ) : null}
      <Flex gap={3} wrap="wrap">
        <Button
          fontSize={1}
          mode="ghost"
          padding={2}
          tone={props.applyTone}
          text={props.busy === "apply" ? "Applying..." : "Apply saved result (free)"}
          aria-label={props.busy === "apply" ? undefined : `Apply the saved ${props.name} result, for free`}
          disabled={props.disabled || (warning?.acknowledgement !== undefined && !acknowledged)}
          onClick={() => props.onApply(warning !== undefined)}
        />
        <Button
          fontSize={1}
          mode="bleed"
          padding={2}
          text="Discard"
          aria-label={`Discard the saved ${props.name} result`}
          disabled={props.disabled}
          onClick={() => setIsConfirmingDiscard(true)}
        />
      </Flex>
    </Stack>
  );
}
