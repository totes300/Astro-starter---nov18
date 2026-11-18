import { CheckmarkCircleIcon } from "@sanity/icons/CheckmarkCircle";
import { EllipsisHorizontalIcon } from "@sanity/icons/EllipsisHorizontal";
import { LinkIcon } from "@sanity/icons/Link";
import { RefreshIcon } from "@sanity/icons/Refresh";
import { SearchIcon } from "@sanity/icons/Search";
import { Box, Button, Card, Dialog, Flex, Spinner, SrOnly, Stack, Tab, TabList, Text, TextInput } from "@sanity/ui";
import { Menu, MenuButton, MenuItem } from "@sanity/ui/menu";
import { useToast } from "@sanity/ui/toast";
import * as React from "react";
import { type ObjectFieldProps, type TextInputProps, useEditState, useFormValue } from "sanity";
import { IntentLink } from "sanity/router";
import { createTranslateTransport } from "../ai-translation/api";
import { canRetryPlan } from "../ai-translation/dialog-model";
import {
  AI_USAGE_NOTE,
  formatNumber,
  languageName,
  policyTitles,
  requestsTodayCopy,
  runProgressCopy,
  statusLine,
  UPDATE_LINKS_NOTE,
} from "../ai-translation/present";
import { isRunActive, runStore, runTotals, siteRunJobs, UPDATE_LINKS, useTranslationRun } from "../ai-translation/run-store";
import {
  allDoneNote,
  cellText,
  confirmCopy,
  countsCopy,
  defaultPlanFilter,
  defaultSiteRunOptions,
  type FilteredGroup,
  filterPlanGroups,
  freshestCreditsToday,
  groupCountsCopy,
  isConfirmationTyped,
  missingLanguageCopy,
  needsTypedConfirmation,
  PLAN_PAGE_SIZE,
  PLAN_SEARCH_MIN,
  type PlanFilter,
  panelBusyCopy,
  plainLabelsCopy,
  planTotals,
  RUN_CREDIT_LIMIT_MAX,
  RUN_CREDIT_LIMIT_MIN,
  runBlocks,
  runCostCopy,
  runCreditLimit,
  runSpend,
  type SitePlanView,
  type SiteRunOptions,
  SWITCHED_OFF_NOTE,
  showMoreCopy,
  showsSwitchedOff,
  sitePlanView,
  siteRunAnnouncement,
  startBlock,
  stopButtonText,
  styleGuideRoom,
  styleGuideRoomCopy,
  TYPED_CONFIRMATION_WORD,
  translateButtonText,
} from "../ai-translation/site-run";
import {
  CheckboxLine,
  DialogBody,
  DialogFooter,
  Disclosure,
  InlineChoice,
  LinkTranslationControl,
  ToggleButton,
  useLinkTranslation,
  useNow,
  useTranslatedAt,
  useTranslateSwitchedOff,
  useTranslationPlan,
  useUpdateLinks,
} from "../ai-translation/translate-ui";
import type { PlanRequest, PlanResponse } from "../ai-translation/wire";
import { AI_TRANSLATION_STYLE_GUIDE_LIMIT, SANITY_SINGLETON_SITE_SETTINGS_ID } from "../constants";
import { DEFAULT_LOCALE, getLocaleTitle, getStudioLocaleTitle, IS_I18N_ENABLED, LOCALES } from "../i18n";
import { run as runBlock } from "../lib/run";
import { useStudioFetch } from "../lib/studio-fetch";
import { AiDrafts, RunProgress, RunSummaryCard, SavedResults } from "./site-translation-run";

const TARGETS = LOCALES.filter(({ id }) => id !== DEFAULT_LOCALE).map(({ id }) => ({ id, title: getLocaleTitle(id) }));
const TARGET_IDS = TARGETS.map(({ id }) => id);
const SOURCE = languageName(DEFAULT_LOCALE);
const POLICY_TITLES = policyTitles(SOURCE);

// Every language at once: ticking one, or switching the policy, then needs no new request.
const PLAN_REQUEST: PlanRequest = { languages: TARGET_IDS };

type LinkControl = ReturnType<typeof useLinkTranslation>;

/** The style guide plus each language's compiled length (notes and glossary included) against Sanity's cap. */
function StyleGuideInput(props: TextInputProps) {
  const translations = useFormValue(["translations"]);
  const rooms = styleGuideRoom(translations, TARGETS);

  return (
    <Stack gap={2}>
      {props.renderDefault(props)}
      {rooms.length === 0 ? (
        <Text muted size={1}>
          {formatNumber(props.value?.length ?? 0)} / {formatNumber(AI_TRANSLATION_STYLE_GUIDE_LIMIT)}
        </Text>
      ) : (
        rooms.map((room) => (
          <Text key={room.language.id} muted={room.ok} size={1}>
            {styleGuideRoomCopy(room, rooms.length === 1)}
          </Text>
        ))
      )}
    </Stack>
  );
}

/** Settings > Translations: the whole-site panel above the field, so it is not framed as one of the settings it reads. */
function SiteTranslationField(props: ObjectFieldProps) {
  if (!IS_I18N_ENABLED) {
    return props.renderDefault(props);
  }

  return (
    <Stack gap={5}>
      <SiteTranslationSection />
      {props.renderDefault(props)}
    </Stack>
  );
}

/** The panel, or only how to switch Translate with AI back on while Settings' published daily limit is 0. */
function SiteTranslationSection() {
  const isOff = useTranslateSwitchedOff();
  const run = useTranslationRun();

  if (showsSwitchedOff(isOff, run)) {
    return (
      <Card border radius={3} padding={4}>
        <Text size={1} muted>
          {SWITCHED_OFF_NOTE}
        </Text>
      </Card>
    );
  }

  return <SiteTranslationPanel />;
}

function useUnpublishedSettings(): boolean {
  const { draft, published } = useEditState(SANITY_SINGLETON_SITE_SETTINGS_ID, "siteSettings", "low");
  const translationsOf = (document: unknown) =>
    JSON.stringify((document as { translations?: unknown } | null)?.translations ?? null);

  return draft !== null && translationsOf(draft) !== translationsOf(published);
}

function SiteTranslationPanel() {
  const studioFetch = useStudioFetch();
  const toast = useToast();
  const run = useTranslationRun();
  const siteRun = run?.scope.kind === "site" ? run : null;
  const isActive = isRunActive(run);
  const isSiteRunActive = siteRun !== null && isRunActive(siteRun);
  const now = useNow(isActive);
  const hasUnpublishedSettings = useUnpublishedSettings();
  const { state: planState, reload } = useTranslationPlan(PLAN_REQUEST);
  const links = useUpdateLinks(reload);

  const [picked, setPicked] = React.useState<{ defaults: string; options: SiteRunOptions } | null>(null);
  const [isConfirming, setIsConfirming] = React.useState(false);
  const [isConfirmingLinks, setIsConfirmingLinks] = React.useState(false);
  const [isPublishing, setIsPublishing] = React.useState(false);

  const finishedRunId = siteRun && !isRunActive(siteRun) ? siteRun.id : undefined;
  const reloadedFor = React.useRef(finishedRunId);

  // A finished run changed what is translated and what was spent today.
  React.useEffect(() => {
    if (!finishedRunId || reloadedFor.current === finishedRunId) {
      return;
    }

    reloadedFor.current = finishedRunId;
    reload();
  }, [finishedRunId, reload]);

  const response = runBlock(() => {
    if (planState.status === "ready") {
      return planState.response;
    }
    if (planState.status === "loading") {
      return planState.previous ?? null;
    }
    return null;
  });
  // New published defaults reset the run's options; the same ones keep the editor's picks.
  const defaults = response ? JSON.stringify(response.settings.defaults) : "";
  const options = React.useMemo(() => {
    if (response) {
      if (picked?.defaults === defaults) {
        return picked.options;
      }
      return defaultSiteRunOptions(response);
    }
    return null;
  }, [response, picked, defaults]);
  const view = React.useMemo(() => (response && options ? sitePlanView(response, options) : null), [response, options]);
  const isRefreshing = planState.status === "loading" && response !== null;
  const creditsToday = freshestCreditsToday(siteRun, response?.creditsToday);

  const setOptions = (update: (current: SiteRunOptions | null) => SiteRunOptions | null) => {
    setPicked((current) => {
      const base = runBlock(() => {
        if (current?.defaults === defaults) {
          return current.options;
        }
        if (response) {
          return defaultSiteRunOptions(response);
        }
        return null;
      });
      const next = update(base);

      return next ? { defaults, options: next } : current;
    });
  };

  const startRun = () => {
    setIsConfirming(false);

    if (!response || !view || !options) {
      return;
    }

    const started = runStore.start(
      {
        scope: { kind: "site" },
        publish: options.publish,
        maxCredits: options.maxCredits,
        jobs: siteRunJobs(
          { plan: view.plan },
          { publish: options.publish, slugs: options.slugs, languages: options.languages, relink: options.publish }
        ),
      },
      createTranslateTransport(studioFetch)
    );

    if (!started.ok) {
      toast.push({ status: "warning", title: "Translation not started", description: started.message });
    }
  };

  // Always publishes, as its confirm says: a pass left as drafts would wait for a publish the panel never offers.
  const updateLinks = () => {
    setIsConfirmingLinks(false);
    void links.update();
  };

  const showPlan = response !== null && view !== null && options !== null && !isSiteRunActive;
  const isBusy = isActive || links.isUpdating || isPublishing;

  return (
    <Card border radius={3}>
      <Flex align="center" gap={2} paddingLeft={4} paddingRight={2} paddingY={2}>
        <Box flex={1} paddingY={2}>
          <Text size={1} weight="semibold">
            Translate the whole site
          </Text>
        </Box>
        {isRefreshing || links.isUpdating || isPublishing ? <Spinner muted /> : null}
        <MenuButton
          id="site-translation-menu"
          button={<Button icon={EllipsisHorizontalIcon} mode="bleed" padding={2} aria-label="More actions" />}
          menu={
            <Menu>
              <MenuItem icon={RefreshIcon} text="Check again" disabled={isRefreshing} onClick={reload} />
              <MenuItem
                icon={LinkIcon}
                text={`${UPDATE_LINKS} (free)`}
                disabled={isBusy || !response}
                onClick={() => setIsConfirmingLinks(true)}
              />
            </Menu>
          }
          popover={{ portal: true, placement: "bottom-end" }}
        />
      </Flex>

      <Card borderTop padding={4}>
        <Stack gap={5}>
          <PanelNotices
            response={response}
            failure={planState.status === "failed" ? planState : null}
            hasUnpublishedSettings={hasUnpublishedSettings}
            documentRunActive={run?.scope.kind === "document" && isActive}
            onRetry={reload}
          />

          {planState.status === "loading" && response === null ? (
            <Flex align="center" gap={2}>
              <Spinner muted />
              <Text size={1} muted>
                Checking what is translated
              </Text>
            </Flex>
          ) : null}

          {isSiteRunActive ? <RunProgress run={siteRun} now={now} response={response} /> : null}

          {siteRun && !isRunActive(siteRun) ? <RunSummaryCard run={siteRun} response={response} /> : null}

          {response && !isSiteRunActive ? (
            <AiDrafts
              response={response}
              run={siteRun}
              disabled={isBusy || isRefreshing}
              studioFetch={studioFetch}
              toast={toast}
              onPublishing={setIsPublishing}
              onChanged={reload}
            />
          ) : null}

          {showPlan ? (
            <>
              <LanguageLines view={view} />
              <Disclosure label={`Pages (${formatNumber(planTotals(view.groups).rows)})`}>
                <PlanList view={view} response={response} onChanged={reload} />
              </Disclosure>
              <InlineChoice
                label="After translating"
                value={options.publish ? "publish" : "draft"}
                disabled={isActive}
                choices={[
                  { value: "draft", title: "Save as drafts" },
                  { value: "publish", title: "Publish" },
                ]}
                onChange={(after) => setOptions((current) => (current ? { ...current, publish: after === "publish" } : current))}
              />
              <MoreOptions
                key={JSON.stringify(response.settings.defaults)}
                options={options}
                disabled={isActive}
                defaultMaxCredits={response.settings.defaults.maxCreditsPerRun}
                onChange={setOptions}
              />
            </>
          ) : null}

          {response && response.savedResults.length > 0 ? (
            <SavedResults response={response} publishAfter={options?.publish ?? false} disabled={isActive} onChanged={reload} />
          ) : null}
        </Stack>
      </Card>

      {showPlan || isSiteRunActive ? (
        <Card borderTop paddingX={4} paddingY={3}>
          {runBlock(() => {
            if (isSiteRunActive) {
              return (
                <Flex align="center" gap={3}>
                  <Box flex={1}>
                    <Text size={1} muted>
                      {runProgressCopy(runTotals(siteRun, now))}
                    </Text>
                  </Box>
                  <Button
                    text={stopButtonText(siteRun, runTotals(siteRun, now))}
                    mode="ghost"
                    padding={2}
                    fontSize={1}
                    disabled={siteRun.status === "stopping"}
                    onClick={() => runStore.stop()}
                  />
                </Flex>
              );
            }
            if (view && response && options) {
              return (
                <StartRow
                  view={view}
                  response={response}
                  options={options}
                  creditsToday={creditsToday}
                  isActive={isActive}
                  isStale={isRefreshing}
                  onStart={() => setIsConfirming(true)}
                />
              );
            }
            return null;
          })}
        </Card>
      ) : null}

      <SrOnly as="div" aria-live="polite" aria-atomic="true">
        {siteRunAnnouncement(siteRun)}
      </SrOnly>
      <SrOnly as="div" aria-live="polite" aria-atomic="true">
        {panelBusyCopy({ isUpdatingLinks: links.isUpdating, isPublishing })}
      </SrOnly>

      {isConfirming && response && view && options ? (
        <ConfirmRunDialog
          view={view}
          response={response}
          options={options}
          onCancel={() => setIsConfirming(false)}
          onConfirm={startRun}
        />
      ) : null}

      {isConfirmingLinks ? (
        <Dialog
          id="site-translation-links-confirm"
          header={`${UPDATE_LINKS}?`}
          width={1}
          onClose={() => setIsConfirmingLinks(false)}
          footer={
            <DialogFooter>
              <Button text="Cancel" mode="bleed" padding={2} onClick={() => setIsConfirmingLinks(false)} />
              <Button text={UPDATE_LINKS} tone="primary" padding={2} onClick={updateLinks} />
            </DialogFooter>
          }
        >
          <DialogBody>
            <Text size={1}>{UPDATE_LINKS_NOTE}</Text>
          </DialogBody>
        </Dialog>
      ) : null}
    </Card>
  );
}

/** Only what blocks or changes a run: unpublished settings, a failed read, a refusal, what it leaves out. */
function PanelNotices(props: {
  response: PlanResponse | null;
  failure: { message: string; code: string } | null;
  hasUnpublishedSettings: boolean;
  documentRunActive: boolean;
  onRetry: () => void;
}) {
  const blocks = props.response ? runBlocks(props.response) : [];
  const missing = props.response?.plan.missingLanguage.length ?? 0;
  const plain = props.response?.plan.plainLabels?.length ?? 0;
  const notices = [
    ...(props.hasUnpublishedSettings
      ? [
          {
            key: "unpublished",
            tone: "caution" as const,
            text: "Publish your changes below first: translations use the published settings.",
          },
        ]
      : []),
    ...(props.documentRunActive
      ? [
          {
            key: "document",
            tone: "caution" as const,
            text: "A document is being translated. The site can be translated once it finishes.",
          },
        ]
      : []),
    ...blocks.map((block) => ({ key: block.code, tone: "critical" as const, text: block.message })),
    ...(missing > 0 ? [{ key: "missing", tone: "caution" as const, text: missingLanguageCopy(missing) }] : []),
    ...(plain > 0 ? [{ key: "plain", tone: "caution" as const, text: plainLabelsCopy(plain) }] : []),
  ];

  if (!props.failure && notices.length === 0) {
    return null;
  }

  return (
    <Stack gap={3}>
      {props.failure ? (
        <Card padding={3} radius={2} tone="critical">
          <Flex align="center" gap={3}>
            <Box flex={1}>
              <Text size={1}>{props.failure.message}</Text>
            </Box>
            {canRetryPlan(props.failure.code) ? (
              <Button text="Try again" mode="ghost" fontSize={1} padding={2} onClick={props.onRetry} />
            ) : null}
          </Flex>
        </Card>
      ) : null}
      {notices.map((notice) => (
        <Card key={notice.key} padding={3} radius={2} tone={notice.tone}>
          <Text size={1}>{notice.text}</Text>
        </Card>
      ))}
    </Stack>
  );
}

/** One line per language: its name, then where its pages stand. */
function LanguageLines({ view }: { view: SitePlanView }) {
  return (
    <Stack gap={3}>
      {view.languages.map((language) => {
        const counts = view.counts[language.id];

        return counts ? (
          <Flex key={language.id} align="center" gap={3} justify="space-between" wrap="wrap">
            <Text size={1} weight="medium">
              {getStudioLocaleTitle(language.id)}
            </Text>
            <Text size={1} muted>
              {countsCopy(counts, SOURCE)}
            </Text>
          </Flex>
        ) : null;
      })}
    </Stack>
  );
}

function MoreOptions(props: {
  options: SiteRunOptions;
  disabled: boolean;
  defaultMaxCredits: number;
  onChange: (update: (current: SiteRunOptions | null) => SiteRunOptions | null) => void;
}) {
  const { options, disabled, defaultMaxCredits, onChange } = props;
  const [limitText, setLimitText] = React.useState(String(options.maxCredits));
  const update = (patch: Partial<SiteRunOptions>) => onChange((current) => (current ? { ...current, ...patch } : current));

  const toggleLanguage = (id: string, checked: boolean) => {
    onChange((current) => {
      if (!current) {
        return current;
      }

      const picked = new Set(current.languages);

      if (checked) {
        picked.add(id);
      } else {
        picked.delete(id);
      }

      return { ...current, languages: TARGET_IDS.filter((target) => picked.has(target)) };
    });
  };

  return (
    <Disclosure label="More options">
      <Stack gap={5}>
        {TARGET_IDS.length > 1 ? (
          <Stack gap={3} role="group" aria-labelledby="site-translation-languages">
            <Text id="site-translation-languages" size={1} weight="medium">
              Languages
            </Text>
            <Flex gap={4} wrap="wrap">
              {TARGET_IDS.map((id) => (
                <CheckboxLine
                  key={id}
                  label={getStudioLocaleTitle(id)}
                  checked={options.languages.includes(id)}
                  disabled={disabled}
                  onChange={(checked) => toggleLanguage(id, checked)}
                />
              ))}
            </Flex>
          </Stack>
        ) : null}

        <Stack gap={3}>
          <CheckboxLine
            label={POLICY_TITLES.refresh}
            checked={options.policy === "refresh"}
            disabled={disabled}
            onChange={(checked) => update({ policy: checked ? "refresh" : "missing" })}
          />
          <Text size={1} muted>
            Pages edited since the AI translation, or written by hand, are never replaced.
          </Text>
        </Stack>

        <Stack gap={3}>
          <InlineChoice
            label="URL slugs"
            value={options.slugs}
            disabled={disabled}
            choices={[
              { value: "translate", title: "Translate" },
              { value: "keep", title: `Keep the ${SOURCE} slug` },
            ]}
            onChange={(slugs) => update({ slugs })}
          />
          <Text size={1} muted>
            New translations only: an existing one keeps its URL.
          </Text>
        </Stack>

        <Stack gap={3}>
          <Text as="label" htmlFor="site-translation-limit" size={1} weight="medium">
            AI request limit for this run
          </Text>
          <Box style={LIMIT_WIDTH}>
            <TextInput
              id="site-translation-limit"
              type="number"
              inputMode="numeric"
              fontSize={1}
              min={RUN_CREDIT_LIMIT_MIN}
              max={RUN_CREDIT_LIMIT_MAX}
              step={1}
              value={limitText}
              disabled={disabled}
              onChange={(event) => {
                const text = event.currentTarget.value;

                setLimitText(text);
                update({ maxCredits: runCreditLimit(text, defaultMaxCredits) });
              }}
              onBlur={() => setLimitText(String(options.maxCredits))}
            />
          </Box>
          <Text size={1} muted>
            {`A run stops before it would make more. ${AI_USAGE_NOTE}`}
          </Text>
        </Stack>
      </Stack>
    </Disclosure>
  );
}

// Wide enough for three digits and the spinner arrows, so the limit does not stretch across the panel.
const LIMIT_WIDTH = { width: "6em" } as const;

/** Mounted only while "Pages" is open. Opens on what is left to translate, with a search once the list is long. */
function PlanList({ view, response, onChanged }: { view: SitePlanView; response: PlanResponse; onChanged: () => void }) {
  const totals = planTotals(view.groups);
  const [filter, setFilter] = React.useState<PlanFilter>(() => defaultPlanFilter(view.groups));
  const [query, setQuery] = React.useState("");
  const link = useLinkTranslation(onChanged);
  const listId = React.useId();
  const groups = filterPlanGroups(view.groups, { filter, query });
  const shown = groups.reduce((total, group) => total + group.rows.length, 0);
  // A short list opens every group; a long one starts folded, so its group counts read as the summary.
  const isOpenByDefault = shown <= PLAN_PAGE_SIZE;
  const filters: { id: PlanFilter; label: string }[] = [
    { id: "toTranslate", label: `To translate (${formatNumber(totals.toTranslate)})` },
    { id: "all", label: `All (${formatNumber(totals.rows)})` },
  ];

  return (
    <Stack gap={4}>
      <Flex align="center" gap={3} wrap="wrap">
        <TabList gap={1}>
          {filters.map((option) => (
            <Tab
              key={option.id}
              id={`${listId}-${option.id}`}
              aria-controls={listId}
              fontSize={1}
              padding={2}
              label={option.label}
              selected={filter === option.id}
              onClick={() => setFilter(option.id)}
            />
          ))}
        </TabList>
        {totals.rows > PLAN_SEARCH_MIN ? (
          <Box flex={1} style={SEARCH_MIN_WIDTH}>
            <TextInput
              aria-label="Search pages by title"
              fontSize={1}
              padding={2}
              icon={SearchIcon}
              placeholder="Search pages"
              value={query}
              clearButton={query !== ""}
              onClear={() => setQuery("")}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </Box>
        ) : null}
      </Flex>

      <Stack id={listId} role="tabpanel" aria-labelledby={`${listId}-${filter}`} gap={3}>
        {groups.length === 0 ? (
          <Text size={1} muted>
            {query.trim() !== "" ? "No pages match this search." : "Nothing left to translate."}
          </Text>
        ) : (
          groups.map((group) => (
            <PlanGroup
              key={`${group.step}:${filter}:${isOpenByDefault}`}
              group={group}
              response={response}
              multiple={view.languages.length > 1}
              isOpenByDefault={isOpenByDefault}
              link={link}
            />
          ))
        )}
      </Stack>
    </Stack>
  );
}

// Keeps the search usable beside the filter on a narrow pane, wrapping under it instead of shrinking.
const SEARCH_MIN_WIDTH = { minWidth: "12em" } as const;

function PlanGroup(props: {
  group: FilteredGroup;
  response: PlanResponse;
  multiple: boolean;
  isOpenByDefault: boolean;
  link: LinkControl;
}) {
  const { group } = props;
  const [isOpen, setIsOpen] = React.useState(props.isOpenByDefault);
  const [limit, setLimit] = React.useState(PLAN_PAGE_SIZE);
  const rowsId = React.useId();
  const rows = isOpen ? group.rows.slice(0, limit) : [];
  const left = group.rows.length - rows.length;
  const ids = rows.flatMap(({ cells }) => cells.flatMap(({ targetId }) => targetId ?? []));
  const translatedAt = useTranslatedAt(ids, props.response);

  return (
    <Card border radius={2}>
      <Box paddingX={3} paddingY={3}>
        <ToggleButton
          fullWidth
          isOpen={isOpen}
          controls={rowsId}
          label={group.title}
          aside={groupCountsCopy(group)}
          onToggle={() => setIsOpen((open) => !open)}
        />
      </Box>

      {isOpen ? (
        <Box id={rowsId}>
          {rows.map((row) => (
            <PlanRow
              key={row.id}
              row={row}
              step={group.step}
              multiple={props.multiple}
              translatedAt={translatedAt}
              link={props.link}
            />
          ))}
          {left > 0 ? (
            <Card borderTop paddingX={2} paddingY={2}>
              <Button
                mode="bleed"
                fontSize={1}
                padding={2}
                text={showMoreCopy(left)}
                onClick={() => setLimit((current) => current + PLAN_PAGE_SIZE)}
              />
            </Card>
          ) : null}
        </Box>
      ) : null}
    </Card>
  );
}

function PlanRow(props: {
  row: FilteredGroup["rows"][number];
  step: FilteredGroup["step"];
  multiple: boolean;
  translatedAt: Readonly<Record<string, string>>;
  link: LinkControl;
}) {
  const { row } = props;
  const unlinked = row.skipped ? [] : row.cells.filter(({ unlinkedId }) => unlinkedId);

  return (
    <Card borderTop paddingX={3} paddingY={2}>
      <Stack gap={3}>
        <Flex align="flex-start" gap={3}>
          <Box flex={1} style={ROW_TITLE}>
            <Text size={1} textOverflow="ellipsis">
              <IntentLink
                intent="edit"
                params={{ id: row.documentId, type: row.type, language: props.step === "labels" ? undefined : DEFAULT_LOCALE }}
              >
                {row.title}
              </IntentLink>
            </Text>
          </Box>
          <Stack gap={2}>
            {row.skipped ? (
              <Text size={1} muted align="right">
                {`Not published in ${SOURCE}`}
              </Text>
            ) : (
              row.cells.map((cell) => {
                const words = statusLine(
                  cellText(cell, { source: SOURCE, translatedAt: cell.targetId ? props.translatedAt[cell.targetId] : undefined })
                );

                return (
                  <Text key={cell.language} size={1} muted align="right">
                    {props.multiple ? `${getStudioLocaleTitle(cell.language)}: ${words}` : words}
                  </Text>
                );
              })
            )}
          </Stack>
        </Flex>
        {unlinked.map((cell) => (
          <LinkTranslationControl
            key={cell.language}
            link={props.link}
            input={{ sourceId: row.documentId, language: cell.language, targetId: cell.unlinkedId ?? "" }}
            title={cell.unlinkedTitle}
            sourceTitle={row.title}
            step={props.step}
          />
        ))}
      </Stack>
    </Card>
  );
}

// Lets a long title shrink and ellipsize instead of pushing the status off the row.
const ROW_TITLE = { minWidth: 0 } as const;

function StartRow(props: {
  view: SitePlanView;
  response: PlanResponse;
  options: SiteRunOptions;
  creditsToday: PlanResponse["creditsToday"] | undefined;
  isActive: boolean;
  isStale: boolean;
  onStart: () => void;
}) {
  const { view, response, options, isActive, isStale, creditsToday } = props;
  const block = isActive
    ? { code: "busy", message: "Wait for the translation that is running to finish." }
    : startBlock({ view, response });
  const today = creditsToday ? requestsTodayCopy(creditsToday) : null;

  if (block?.code === "nothing") {
    const note = allDoneNote(view);

    return (
      <Stack gap={3}>
        <Flex align="center" gap={3} wrap="wrap">
          <Flex align="center" gap={2} flex={1}>
            <Text size={1}>
              <CheckmarkCircleIcon />
            </Text>
            <Text size={1}>Every page is translated</Text>
          </Flex>
          {today ? (
            <Text size={1} muted>
              {today}
            </Text>
          ) : null}
        </Flex>
        {note ? (
          <Text size={1} muted>
            {note}
          </Text>
        ) : null}
      </Stack>
    );
  }

  return (
    <Flex align="center" gap={3} wrap="wrap">
      <Button
        text={translateButtonText(view)}
        tone="primary"
        padding={2}
        fontSize={1}
        disabled={block !== null || isStale}
        onClick={props.onStart}
      />
      <Box flex={1}>
        <Text size={1} muted>
          {block ? block.message : [runCostCopy(view.estimate, options.maxCredits), today].filter(Boolean).join(" · ")}
        </Text>
      </Box>
    </Flex>
  );
}

function ConfirmRunDialog(props: {
  view: SitePlanView;
  response: PlanResponse;
  options: SiteRunOptions;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { view, response, options } = props;
  const [typed, setTyped] = React.useState("");
  const copy = confirmCopy({ view, run: options, response });
  const mustType = needsTypedConfirmation(runSpend(view.estimate, options.maxCredits));

  return (
    <Dialog
      id="site-translation-confirm"
      header="Translate the whole site?"
      width={1}
      onClose={props.onCancel}
      footer={
        <DialogFooter note={runCostCopy(view.estimate, options.maxCredits)}>
          <Button text="Cancel" mode="bleed" padding={2} onClick={props.onCancel} />
          <Button
            padding={2}
            text={translateButtonText(view)}
            tone="primary"
            disabled={mustType && !isConfirmationTyped(typed)}
            onClick={props.onConfirm}
          />
        </DialogFooter>
      }
    >
      <DialogBody>
        <Stack gap={5}>
          <Stack gap={3}>
            <Text size={2} weight="medium">
              {copy.summary}
            </Text>
            {copy.lines.map((line) => (
              <Text key={line} size={1}>
                {line}
              </Text>
            ))}
          </Stack>
          {copy.cautions.map((caution) => (
            <Card key={caution} padding={3} radius={2} tone="caution">
              <Text size={1}>{caution}</Text>
            </Card>
          ))}
          {mustType ? (
            <Stack gap={2}>
              <Text as="label" htmlFor="site-translation-confirm-word" size={1} weight="medium">
                {`Type "${TYPED_CONFIRMATION_WORD}" to confirm`}
              </Text>
              <TextInput
                id="site-translation-confirm-word"
                autoComplete="off"
                value={typed}
                onChange={(event) => setTyped(event.currentTarget.value)}
              />
            </Stack>
          ) : null}
        </Stack>
      </DialogBody>
    </Dialog>
  );
}

export { SiteTranslationField, StyleGuideInput };
