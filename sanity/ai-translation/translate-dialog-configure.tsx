import { Card, Flex, Stack, Text, TextArea } from "@sanity/ui";
import * as React from "react";
import {
  type CategoryNoteOptions,
  categoryNote,
  charactersLeftCopy,
  type NameRow,
  type ReplaceWarning,
  savedResultCopy,
  type TargetOption,
  type TargetPick,
  type TargetPicks,
} from "./dialog-model";
import type { RunStep } from "./plan";
import { AI_USAGE_NOTE, joinWords, keptAsTheyAre, languageName } from "./present";
import { pairKey } from "./run-store";
import {
  CheckboxLine,
  CheckboxRow,
  Disclosure,
  FieldLabel,
  InlineChoice,
  LinkTranslationControl,
  SavedResultControls,
  type useLinkTranslation,
} from "./translate-ui";
import type { SavedResultSummary } from "./wire";

type SourceProps = {
  /** The flag and native title of the default language. */
  language: string;
  title: string;
  uri?: string;
  hasPublished: boolean;
  hasUnpublishedChanges: boolean;
  useDraft: boolean;
  onUseDraft: (useDraft: boolean) => void;
};

/** "From 🇬🇧 English: About (/about)", and which version to translate when the draft differs. */
export function SourceLine(props: SourceProps) {
  return (
    <Stack gap={3}>
      <Text size={1}>
        {`From ${props.language}: `}
        <strong>{props.title}</strong>
        {props.uri ? ` (${props.uri})` : ""}
      </Text>

      {props.hasPublished && props.hasUnpublishedChanges ? (
        <InlineChoice
          label="Translate"
          value={props.useDraft ? "draft" : "published"}
          choices={[
            { value: "published", title: "Published version" },
            { value: "draft", title: "Current draft" },
          ]}
          onChange={(version) => props.onUseDraft(version === "draft")}
        />
      ) : null}

      {props.hasPublished ? null : (
        <Text size={1} muted>
          Not published yet, so its current draft is translated.
        </Text>
      )}
    </Stack>
  );
}

/** Linking the language's own document, which sits where the translation would go, instead of translating. */
export type LinkControl = {
  link: ReturnType<typeof useLinkTranslation>;
  sourceId: string;
  sourceTitle: string;
  step: RunStep;
};

type TargetRowProps = {
  option: TargetOption;
  pick: TargetPick;
  link: LinkControl;
  onSelect: (selected: boolean) => void;
  onAcknowledge: (acknowledged: boolean) => void;
};

function TargetRow({ option, pick, link, onSelect, onAcknowledge }: TargetRowProps) {
  const warning = pick.selected ? option.warning : undefined;
  const warningId = React.useId();

  return (
    <CheckboxRow
      label={option.title}
      checked={pick.selected}
      disabled={option.isLocked}
      onChange={onSelect}
      aside={
        option.uri ? (
          <Text size={1} muted textOverflow="ellipsis">
            {option.uri}
          </Text>
        ) : null
      }
      description={
        <>
          <Text size={1} muted>
            {option.text}
          </Text>
          {option.hint ? (
            <Text size={1} muted>
              {option.hint}
            </Text>
          ) : null}
        </>
      }
      describedBy={warning ? warningId : undefined}
    >
      {option.unlinkedId ? (
        <LinkTranslationControl
          link={link.link}
          input={{ sourceId: link.sourceId, language: option.language, targetId: option.unlinkedId }}
          title={option.unlinkedTitle}
          sourceTitle={link.sourceTitle}
          step={link.step}
        />
      ) : null}
      {warning ? (
        <Card padding={3} radius={2} tone="caution">
          <Stack gap={3}>
            <Text id={warningId} size={1}>
              {warning.message}
            </Text>
            {warning.acknowledgement ? (
              <CheckboxLine label={warning.acknowledgement} checked={pick.acknowledged} onChange={onAcknowledge} />
            ) : null}
          </Stack>
        </Card>
      ) : null}
    </CheckboxRow>
  );
}

type TargetListProps = {
  options: readonly TargetOption[];
  picks: TargetPicks;
  link: LinkControl;
  onSelect: (option: TargetOption, selected: boolean) => void;
  onAcknowledge: (option: TargetOption, acknowledged: boolean) => void;
};

export function TargetList({ options, picks, link, onSelect, onAcknowledge }: TargetListProps) {
  return (
    <Stack gap={3}>
      {options.map((option) => (
        <TargetRow
          key={option.language}
          option={option}
          pick={picks[option.language] ?? { selected: false, acknowledged: false }}
          link={link}
          onSelect={(selected) => onSelect(option, selected)}
          onAcknowledge={(acknowledged) => onAcknowledge(option, acknowledged)}
        />
      ))}
    </Stack>
  );
}

export function AfterTranslating({ publish, onPublish }: { publish: boolean; onPublish: (publish: boolean) => void }) {
  return (
    <Stack gap={2}>
      <InlineChoice
        label="After translating"
        value={publish ? "publish" : "draft"}
        choices={[
          { value: "draft", title: "Save as draft" },
          { value: "publish", title: "Publish" },
        ]}
        onChange={(after) => onPublish(after === "publish")}
      />
      {publish ? (
        <Text size={1} muted>
          Published as soon as it is translated.
        </Text>
      ) : null}
    </Stack>
  );
}

type MoreOptionsProps = {
  source: string;
  showSlugs: boolean;
  slugs: "translate" | "keep";
  onSlugs: (slugs: "translate" | "keep") => void;
  instructions: string;
  onInstructions: (instructions: string) => void;
  charactersLeft: number;
  creditsToday: string;
};

export function MoreOptions(props: MoreOptionsProps) {
  const instructionsId = React.useId();
  const counterId = React.useId();
  const { kept, notCopied } = keptAsTheyAre();
  const keptWords = joinWords(kept);

  return (
    <Disclosure label="More options">
      <Stack gap={5}>
        {props.showSlugs ? (
          <Stack gap={3}>
            <InlineChoice
              label="URL slug"
              value={props.slugs}
              choices={[
                { value: "translate", title: "Translate the slug" },
                { value: "keep", title: `Keep the ${props.source} slug` },
              ]}
              onChange={props.onSlugs}
            />
            <Text size={1} muted>
              Only for a new translation: an existing one keeps its URL.
            </Text>
          </Stack>
        ) : null}

        <Stack gap={3}>
          <Flex align="center" gap={3} justify="space-between">
            <FieldLabel htmlFor={instructionsId}>Extra instructions for this run</FieldLabel>
            <Text id={counterId} size={1} muted>
              {charactersLeftCopy(props.charactersLeft)}
            </Text>
          </Flex>
          <TextArea
            id={instructionsId}
            aria-describedby={counterId}
            fontSize={1}
            rows={3}
            value={props.instructions}
            placeholder="For example: this page is for developers, keep a technical tone."
            onChange={(event) => props.onInstructions(event.currentTarget.value)}
          />
        </Stack>

        <Stack gap={3}>
          <Text size={1} weight="medium">
            What stays as it is
          </Text>
          <Text size={1} muted>
            {`${keptWords.charAt(0).toUpperCase()}${keptWords.slice(1)}. Not copied: ${joinWords(notCopied)}.`}
          </Text>
        </Stack>

        <Text size={1} muted>
          {`${props.creditsToday}. ${AI_USAGE_NOTE}`}
        </Text>
      </Stack>
    </Disclosure>
  );
}

type SavedProps = {
  saved: readonly SavedResultSummary[];
  busy: { key: string; action: "apply" | "discard" } | null;
  /** The caution before applying over a translation someone changed since, by `pairKey`. */
  warningFor: (saved: SavedResultSummary) => ReplaceWarning | undefined;
  onApply: (saved: SavedResultSummary, overwrite: boolean) => void;
  onDiscard: (saved: SavedResultSummary) => void;
};

export function SavedResults({ saved, busy, warningFor, onApply, onDiscard }: SavedProps) {
  if (saved.length === 0) {
    return null;
  }

  return (
    <Stack gap={3}>
      {saved.map((result) => {
        const key = pairKey(result.sourceId, result.language);

        return (
          <Card key={key} padding={3} radius={2} tone="caution">
            <Stack gap={3}>
              <Text size={1}>{savedResultCopy(result)}</Text>
              <SavedResultControls
                name={languageName(result.language)}
                busy={busy?.key === key ? busy.action : null}
                disabled={busy !== null}
                warning={warningFor(result)}
                isInCard
                onApply={(overwrite) => onApply(result, overwrite)}
                onDiscard={() => onDiscard(result)}
              />
            </Stack>
          </Card>
        );
      })}
    </Stack>
  );
}

export function CategoryNames({ rows, note }: { rows: readonly NameRow[]; note: CategoryNoteOptions }) {
  return (
    <Stack gap={3}>
      <Stack gap={3}>
        {rows.map((row) => (
          <Flex key={row.language} align="center" gap={3} justify="space-between" wrap="wrap">
            <Text size={1} weight="medium">
              {row.title}
            </Text>
            <Text size={1} muted={row.missing}>
              {row.missing ? "Not translated yet" : row.value}
            </Text>
          </Flex>
        ))}
      </Stack>
      <Text size={1} muted>
        {categoryNote(rows, note)}
      </Text>
    </Stack>
  );
}
