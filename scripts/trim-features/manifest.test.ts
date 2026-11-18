/**
 * The manifest checked against the repository it describes. In the starter every anchor must resolve;
 * in a project only what the project owns is asserted, and anchor drift is `--status`'s to report.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { applyEdits, describeEdit, isInScope, isSatisfiedWhenAbsent, resolveEdits, verifyEdits } from "./edits";
import {
  FEATURES,
  findFeature,
  findMissingLandmarks,
  findSelectionConflicts,
  isFeaturePresent,
  manifestLandmarks,
  notesFor,
  offeredWithOneLocale,
  onDisk,
  resolveSelection,
  type StoredField,
  sectionNamesOf,
  shapesOf,
} from "./features";
import { buildImportIndex } from "./importers";
import { I18N_CONFIG, readLocaleConfig } from "./language";
import { loadLocaleToggle } from "./locale-toggle";
import {
  detectRole,
  findOutsideImporters,
  findRecordConflicts,
  findUnaccountedSections,
  findUnaccountedTypes,
  isDate,
  isOfferable,
  listSections,
  originRepository,
  PROJECT_FILE,
  readProjectRecord,
  statusesOf,
} from "./project";
import { isSystemType, parseDeclaredFields, parseRegisteredTypes } from "./schema";

const root = join(import.meta.dirname, "..", "..");
const exists = (path: string) => existsSync(join(root, path));

function read(file: string): string {
  return readFileSync(join(root, file), "utf8");
}

const record = readProjectRecord(root);
const role = detectRole(record, originRepository(root));
const statuses = statusesOf(record, exists);

// The starter must describe itself exactly. A project has changed what it kept, so there the per-feature
// assertions are skipped with a pointer to the report that shows the same drift without failing.
const starterOnly = role === "starter" ? {} : { skip: "a project reports drift with `npm run trim -- --status`" };

// Once a feature has actually been removed its entry is inert, and asserting its anchors would turn a
// successful trim into a red test suite.
const present = FEATURES.filter((feature) => isOfferable(statuses.get(feature.id) ?? "present"));

// A field a present feature stores on a type another feature's removal purged went with that type.
const purgedTypes = new Set(
  FEATURES.filter((feature) => !present.includes(feature)).flatMap((feature) => feature.documentTypes ?? [])
);
const storedHere = (fields: StoredField[] = []) => fields.filter((field) => !purgedTypes.has(field.documentType));

test("the manifest still describes at least one feature that is present", starterOnly, () => {
  // A guard on the guard: if `isPresent` ever silently matched nothing, every check below would
  // pass vacuously and the manifest would rot unnoticed.
  assert.ok(present.length > 0, "no feature in the manifest is present in this tree");
});

test("every feature id is unique and kebab/namespace shaped", () => {
  const ids = FEATURES.map((feature) => feature.id);

  assert.equal(new Set(ids).size, ids.length, "duplicate feature id");

  for (const id of ids) {
    assert.match(id, /^[a-z0-9-]+(:[a-z0-9-]+)?$/, `unexpected id shape: ${id}`);
  }
});

test("every implied feature id resolves to a real entry", () => {
  for (const feature of FEATURES) {
    for (const id of feature.implies ?? []) {
      assert.ok(findFeature(id), `${feature.id} implies unknown feature "${id}"`);
    }
  }
});

// The other direction. Every test below asks whether what the manifest declares is still here, and
// none asks whether what is here is declared, which is the half a growing repository breaks.
const hasPageBuilder = exists("sanity/schemas/page-sections/index.ts");
const pageBuilderOnly = role === "starter" || hasPageBuilder ? {} : { skip: "this project has no page builder" };

test("every page-builder section is declared, so a new one cannot ship unremovable", pageBuilderOnly, () => {
  const sections = listSections(root);

  assert.ok(sections.length > 0, "no page-builder sections on disk");

  const undeclared = findUnaccountedSections(sections, record, statuses);

  assert.deepEqual(
    undeclared,
    [],
    `no manifest entry, so \`npm run trim\` cannot tell whose these are:\n  ${undeclared.join("\n  ")}\n` +
      (role === "starter"
        ? "Starter kit needs an entry in `features.ts`. If this repository is a project, run `npm run trim -- --reconcile`."
        : `Record them as this project's with \`npm run trim -- --reconcile\` (plop does it for scaffolded ones).`)
  );
});

test("every document type the schema registers is removable, core, or this project's own", () => {
  const unaccounted = findUnaccountedTypes(parseRegisteredTypes(read("sanity-schema.json")), record, statuses, isSystemType);

  assert.deepEqual(
    unaccounted,
    [],
    `neither removable, core, nor recorded in ${PROJECT_FILE}:\n  ${unaccounted.join("\n  ")}\n` +
      (role === "starter"
        ? "Starter kit needs a `documentTypes` entry or a place in `CORE_DOCUMENT_TYPES`."
        : "Record them as this project's with `npm run trim -- --reconcile`.")
  );
});

test("project.json names only sections and types that exist, so it cannot hide a rename", () => {
  // An exemption for something that is gone would go on excusing whatever takes that name next.
  const sections = new Set(listSections(root));
  const registered = new Set(parseRegisteredTypes(read("sanity-schema.json")));
  const stale = [
    ...record.sections.filter((name) => !sections.has(name)),
    ...record.documentTypes.filter((type) => !registered.has(type)),
  ];

  assert.deepEqual(stale, [], `recorded in ${PROJECT_FILE} but not here:\n  ${stale.join("\n  ")}`);
});

test("project.json agrees with the tree", () => {
  assert.deepEqual(findRecordConflicts(record, exists), []);
});

test("every conditional note names a real feature", () => {
  for (const feature of FEATURES) {
    for (const note of feature.notes ?? []) {
      if (typeof note !== "string") {
        assert.ok(findFeature(note.unless), `${feature.id}: a note is dropped unless "${note.unless}", which is not a feature`);
      }
    }
  }
});

test("every stored field is removed by a schema edit of the same feature, and every removed field is declared", () => {
  // The purge can only unset what the manifest names, so a field the schema edit drops without a
  // declaration would be left in the dataset for the Studio to show as unknown.
  for (const feature of FEATURES) {
    const dropped = feature.edits.flatMap((entry) =>
      entry.file.startsWith("sanity/schemas/documents/")
        ? entry.edits.flatMap((edit) => (edit.kind === "dropFieldByName" ? [edit.name] : []))
        : []
    );
    const declared = (feature.fields ?? []).filter((field) => !field.addedBy).map((field) => field.name);

    assert.deepEqual(dropped.sort(), declared.sort(), `${feature.id}: dropFieldByName edits and \`fields\` disagree`);
  }
});

test("a field a wrapper adds to every type it wraps goes with that wrapper's module", () => {
  for (const feature of FEATURES) {
    for (const field of (feature.fields ?? []).filter((candidate) => candidate.addedBy)) {
      assert.ok(
        feature.paths.includes(field.addedBy ?? ""),
        `${feature.id}: ${field.documentType}.${field.name} is added by ${field.addedBy}, which the feature does not delete`
      );
    }
  }
});

test("a module adding a field is the one the declaration names, and every type it adds it to is declared", starterOnly, () => {
  const declared = parseDeclaredFields(read("sanity-schema.json"));

  for (const feature of present) {
    const wrapped = storedHere(feature.fields).filter((field) => field.addedBy);

    for (const module of new Set(wrapped.map((field) => field.addedBy ?? ""))) {
      const names = new Set(wrapped.filter((field) => field.addedBy === module).map((field) => field.name));

      for (const name of names) {
        const carriers = [...declared].filter(([, fields]) => fields.has(name)).map(([type]) => type);
        const listed = wrapped.filter((field) => field.name === name).map((field) => field.documentType);

        assert.deepEqual(listed.sort(), carriers.sort(), `${feature.id}: every type ${module} gives "${name}" must be declared`);
      }
    }
  }
});

test("every declared stored field is one its document type declares today", starterOnly, () => {
  const declared = parseDeclaredFields(read("sanity-schema.json"));

  for (const feature of present) {
    for (const field of storedHere(feature.fields)) {
      assert.ok(
        declared.get(field.documentType)?.has(field.name),
        `${feature.id}: ${field.documentType}.${field.name} is not in the extracted schema`
      );
    }
  }
});

test("every feature says when it joined the starter", () => {
  for (const feature of FEATURES) {
    assert.ok(isDate(feature.since), `${feature.id}: since must be a YYYY-MM-DD date, not "${feature.since}"`);
  }
});

test("every declared path exists on disk", starterOnly, () => {
  for (const feature of present) {
    for (const path of feature.paths) {
      assert.ok(onDisk(path, exists).length > 0, `${feature.id}: missing path ${path}`);
    }
  }
});

test("every edited file exists and every anchor resolves exactly once", starterOnly, () => {
  const failures: string[] = [];

  for (const feature of present) {
    for (const { file, edits, optional, requires, requiresAbsent } of feature.edits) {
      if (!isInScope({ requires, requiresAbsent }, exists)) {
        continue;
      }

      if (!existsSync(join(root, file))) {
        if (!optional) {
          failures.push(`${feature.id}: missing file ${file}`);
        }

        continue;
      }

      const source = read(file);

      for (const { edit, matches } of verifyEdits(source, edits, file)) {
        // The other locale mode comments the language out, which is this edit's own done state.
        if (edit.kind === "commentOutObjectInArray" && matches === 0 && isSatisfiedWhenAbsent(edit, source, file)) {
          continue;
        }

        failures.push(`${feature.id} · ${file}: ${describeEdit(edit)} matched ${matches} times`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("removing one feature leaves every anchor of the features that stay resolving exactly once", starterOnly, () => {
  // The check above as `trim:verify` runs it in each trimmed copy, without the copy: text one trim deletes can be another's anchor.
  const failures: string[] = [];

  for (const owner of present) {
    const selection = resolveSelection([owner.id]).features;
    const deleted = selection.flatMap((feature) => [...feature.paths.flatMap(shapesOf), ...(feature.docs ?? [])]);
    const remains = (path: string) => exists(path) && !deleted.some((gone) => path === gone || path.startsWith(`${gone}/`));
    const groups = selection.flatMap((feature) =>
      feature.edits
        .filter((entry) => isInScope(entry, exists))
        .map((entry) => ({ ...entry, requires: undefined, requiresAbsent: undefined }))
    );
    const trimmed = new Map(
      resolveEdits(groups, exists, read).applicable.map(({ file, edits }) => [file, applyEdits(read(file), edits, file)])
    );
    const statusesAfter = statusesOf(record, remains);
    const staying = FEATURES.filter((feature) => isOfferable(statusesAfter.get(feature.id) ?? "present"));

    for (const feature of staying) {
      for (const { file, edits } of feature.edits.filter((entry) => isInScope(entry, remains))) {
        const source = trimmed.get(file);

        if (source === undefined || !remains(file)) {
          continue;
        }

        for (const { edit, matches } of verifyEdits(source, edits, file)) {
          if (edit.kind === "commentOutObjectInArray" && matches === 0 && isSatisfiedWhenAbsent(edit, source, file)) {
            continue;
          }

          failures.push(`${owner.id} leaves ${feature.id} · ${file}: ${describeEdit(edit)} matched ${matches} times`);
        }
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("nothing outside a feature imports what it deletes", starterOnly, () => {
  // The static half of `trim:verify`: a file outside the selection importing it breaks the build.
  const index = buildImportIndex(root);
  const reaching = FEATURES.flatMap((feature) =>
    findOutsideImporters(index, resolveSelection([feature.id]).features).map(
      ({ file, target }) => `${feature.id}: ${file} imports ${target}`
    )
  );

  assert.deepEqual(reaching, []);
});

test("an edit to a file another feature deletes is skipped once that file is gone", () => {
  // `trim:verify` runs this suite in a copy with the owner trimmed alone, where such a group finds no file.
  const isUnder = (file: string, paths: string[]) =>
    paths.flatMap(shapesOf).some((path) => file === path || file.startsWith(`${path}/`));
  const stranded = FEATURES.flatMap((owner) => {
    const selection = resolveSelection([owner.id]).features;
    const deleted = selection.flatMap((feature) => [...feature.paths, ...(feature.docs ?? [])]);

    return FEATURES.filter((feature) => !selection.includes(feature)).flatMap((feature) =>
      feature.edits
        .filter((entry) => !entry.optional && isUnder(entry.file, deleted))
        .filter((entry) => !entry.requires || !isUnder(entry.requires, deleted))
        .map((entry) => `${owner.id} deletes ${entry.file}, which ${feature.id} still edits`)
    );
  });

  assert.deepEqual(stranded, []);
});

test("every declared dependency is a real dependency", starterOnly, () => {
  const manifest = JSON.parse(read("package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const installed = { ...manifest.dependencies, ...manifest.devDependencies };

  for (const feature of present) {
    for (const name of feature.dependencies ?? []) {
      assert.ok(name in installed, `${feature.id}: ${name} is not in package.json`);
    }
  }
});

test("every declared env var is wired into the config schema, env.ts and .env.example", starterOnly, () => {
  const schema = read("astro.config.mjs");
  const envTs = read("src/lib/env.ts");
  const envExample = read(".env.example");

  for (const feature of present) {
    for (const name of feature.env ?? []) {
      assert.ok(schema.includes(`${name}: envField.`), `${feature.id}: ${name} is not in the astro.config.mjs schema`);
      assert.ok(envTs.includes(name), `${feature.id}: ${name} is not re-exported from src/lib/env.ts`);
      assert.ok(envExample.includes(`${name}=`), `${feature.id}: ${name} is not in .env.example`);
    }
  }
});

test("every declared orphan exists, so a shared layer that moved is not reported as still here", starterOnly, () => {
  for (const feature of present) {
    for (const path of feature.orphans ?? []) {
      assert.ok(existsSync(join(root, path)), `${feature.id}: missing orphan ${path}`);
    }
  }
});

test("every declared doc and skill exists", starterOnly, () => {
  for (const feature of present) {
    for (const doc of feature.docs ?? []) {
      assert.ok(existsSync(join(root, doc)), `${feature.id}: missing doc ${doc}`);
    }

    for (const skill of feature.skills ?? []) {
      assert.ok(existsSync(join(root, ".agents", "skills", skill)), `${feature.id}: missing skill ${skill}`);
    }
  }
});

test("every declared document type is a registered schema", starterOnly, () => {
  const schema = read("sanity-schema.json");

  for (const feature of present) {
    for (const type of feature.documentTypes ?? []) {
      assert.ok(schema.includes(`"${type}"`), `${feature.id}: ${type} is not in the extracted schema`);
    }
  }
});

test("every declared section type is a page-builder array member", starterOnly, () => {
  const schema = read("sanity-schema.json");

  for (const feature of present) {
    for (const type of feature.sectionTypes ?? []) {
      assert.ok(schema.includes(`"${type}"`), `${feature.id}: ${type} is not in the extracted schema`);
    }
  }
});

test("resolveSelection closes over implies in both directions", () => {
  const fromBlog = resolveSelection(["blog"]);

  assert.deepEqual(fromBlog.features.map((feature) => feature.id).sort(), ["authors", "blog"]);
  assert.deepEqual(fromBlog.implied, ["authors"]);

  const fromAuthors = resolveSelection(["authors"]);

  assert.deepEqual(fromAuthors.features.map((feature) => feature.id).sort(), ["authors", "blog"]);
  assert.deepEqual(fromAuthors.implied, ["blog"]);
});

test("resolveSelection pulls in the section a feature owns", () => {
  const { features, implied } = resolveSelection(["contact-form"]);

  assert.deepEqual(features.map((feature) => feature.id).sort(), ["contact-form", "section:contact-form"]);
  assert.deepEqual(implied, ["section:contact-form"]);
});

test("a run switching off the last second language offers what needs one", () => {
  const italian = findFeature("language:it");
  const aiTranslation = findFeature("ai-translation");

  assert.ok(italian && aiTranslation);
  assert.deepEqual(offeredWithOneLocale([italian], ["en", "it"]), [aiTranslation]);
  assert.deepEqual(offeredWithOneLocale([italian], ["en", "it", "fr"]), [], "a second language stays");
  assert.deepEqual(offeredWithOneLocale([italian, aiTranslation], ["en", "it"]), [], "already chosen");
  assert.deepEqual(offeredWithOneLocale([aiTranslation], ["en", "it"]), [], "switches no language off");
  assert.deepEqual(offeredWithOneLocale([], ["en"]), []);
});

test("Translate with AI is selectable on its own, and coupled to no language", () => {
  const { features, implied } = resolveSelection(["ai-translation"]);

  assert.deepEqual(
    features.map((feature) => feature.id),
    ["ai-translation"]
  );
  assert.deepEqual(implied, []);
  assert.ok(!resolveSelection(["language:it"]).features.some((feature) => feature.id === "ai-translation"));
});

test("removing Italian with Translate with AI drops the note about the Translations settings it keeps", () => {
  const italian = findFeature("language:it");
  const aiTranslation = findFeature("ai-translation");

  assert.ok(italian && aiTranslation);

  const about = (notes: string[]) => notes.some((note) => note.startsWith("Settings > Translations keeps"));

  assert.ok(about(notesFor([italian])));
  assert.ok(!about(notesFor([italian, aiTranslation])));
});

const withAiTranslation = present.some((feature) => feature.id === "ai-translation")
  ? starterOnly
  : { skip: "Translate with AI is not here to remove (trimmed, removed, adopted or never had), nor is its warning sentence" };

test("removing Translate with AI leaves no language warning pointing at its Update links", withAiTranslation, () => {
  const aiTranslation = findFeature("ai-translation");
  const file = "sanity/schemas/fields/create-language-field.tsx";

  assert.ok(aiTranslation);
  assert.match(read(file), /Update links/);

  const edits = aiTranslation.edits.filter((entry) => entry.file === file).flatMap((entry) => entry.edits);

  assert.doesNotMatch(applyEdits(read(file), edits, file), /Update links/);
});

test("resolveSelection reports ids that are not in the manifest instead of ignoring them", () => {
  const { features, unknown } = resolveSelection(["blog", "not-a-feature"]);

  assert.deepEqual(unknown, ["not-a-feature"]);
  assert.ok(features.some((feature) => feature.id === "blog"));
});

test("removing every feature at once leaves no two edits fighting over the same text", () => {
  const byFile = new Map<string, { edit: ReturnType<typeof describeEdit>; feature: string }[]>();

  for (const feature of present) {
    // The other shape of a moved anchor never runs beside this one, so only what this tree runs can fight.
    for (const { file, edits } of feature.edits.filter((entry) => isInScope(entry, exists))) {
      const entries = byFile.get(file) ?? [];
      entries.push(...edits.map((edit) => ({ edit: describeEdit(edit), feature: feature.id })));
      byFile.set(file, entries);
    }
  }

  for (const [file, entries] of byFile) {
    const seen = new Map<string, string>();

    for (const { edit, feature } of entries) {
      const owner = seen.get(edit);

      assert.equal(owner, undefined, `${file}: "${edit}" is claimed by both ${owner} and ${feature}`);
      seen.set(edit, feature);
    }
  }
});

test("isFeaturePresent is false only once nothing a feature owns is left", () => {
  const feature = { paths: ["a.ts", "b.ts"] } as (typeof FEATURES)[number];

  assert.equal(
    isFeaturePresent(feature, () => true),
    true
  );
  assert.equal(
    isFeaturePresent(feature, (path) => path === "b.ts"),
    true
  );
  assert.equal(
    isFeaturePresent(feature, () => false),
    false
  );
});

test("every feature declares content for the same-run purge to delete", () => {
  // `--dataset` purges what the run just removed, using these lists. A feature that owns files but
  // names no type would silently leave its content behind.
  for (const feature of FEATURES) {
    const owns =
      (feature.documentTypes?.length ?? 0) +
      (feature.sectionTypes?.length ?? 0) +
      (feature.fields?.length ?? 0) +
      (feature.language ? 1 : 0);

    assert.ok(
      owns > 0 || feature.codeOnly,
      `${feature.id} declares no documentTypes, sectionTypes, fields or language, so it can never be purged. Mark it \`codeOnly\` if that is the point.`
    );
  }
});

const STARTER_SECTIONS = FEATURES.filter((feature) => feature.id.startsWith("section:"));
const ON_DISK = STARTER_SECTIONS.flatMap(sectionNamesOf);

test("findSelectionConflicts refuses a selection that would empty the page-builder registry", () => {
  const conflicts = findSelectionConflicts(STARTER_SECTIONS, ON_DISK);

  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0] ?? "", /every page-builder section/);
});

test("findSelectionConflicts allows every smaller selection, including all but one section", () => {
  assert.deepEqual(findSelectionConflicts(STARTER_SECTIONS.slice(0, -1), ON_DISK), []);
  assert.deepEqual(findSelectionConflicts([], ON_DISK), []);
  assert.deepEqual(
    findSelectionConflicts(
      FEATURES.filter((feature) => !feature.id.startsWith("section:")),
      ON_DISK
    ),
    []
  );
});

test("findSelectionConflicts counts a project's own sections as the ones that remain", () => {
  assert.deepEqual(findSelectionConflicts(STARTER_SECTIONS, [...ON_DISK, "FaqSection"]), []);
});

test("findSelectionConflicts catches the whole-manifest selection, which includes every section", () => {
  assert.equal(findSelectionConflicts([...FEATURES], ON_DISK).length, 1);
});

test("every manifest landmark exists, so a relocated registry fails here rather than silently", () => {
  // The landmarks are what tells the dataset-only purge that this manifest still describes this
  // tree. If one moves, `isFeaturePresent` starts reporting live features as already removed, so
  // this has to fail loudly rather than let the auto-detect draw conclusions from a moved folder.
  // A project that removed every feature editing a landmark has no reason to keep that file.
  const edited = new Set(
    present.flatMap((feature) => feature.edits.filter((entry) => !entry.optional).map((entry) => entry.file))
  );

  assert.deepEqual(
    findMissingLandmarks((path) => existsSync(join(root, path))).filter((file) => edited.has(file)),
    []
  );
});

test("landmarks are the registries shared by more than one feature", () => {
  const landmarks = manifestLandmarks();

  assert.ok(landmarks.length > 0, "the manifest shares no file between features, so it has no landmarks");

  for (const file of landmarks) {
    const owners = FEATURES.filter((feature) => feature.edits.some((entry) => entry.file === file));

    assert.ok(owners.length > 1, `${file} is only edited by ${owners.length} feature and is not a landmark`);
  }
});

test("a landmark is a file more than one feature edits whatever the tree, never one edited only beside something", () => {
  // A project from before i18n has neither `sanity/i18n.ts` nor what its groups edit, and must still start.
  const editors = new Map<string, Set<string>>();

  for (const feature of FEATURES) {
    for (const entry of feature.edits.filter(
      (candidate) => !candidate.requires && !candidate.requiresAbsent && !candidate.optional
    )) {
      editors.set(entry.file, new Set([...(editors.get(entry.file) ?? []), feature.id]));
    }
  }

  const expected = [...editors].filter(([, ids]) => ids.size > 1).map(([file]) => file);

  assert.deepEqual(manifestLandmarks(), expected.sort());
  assert.ok(!manifestLandmarks().includes(I18N_CONFIG));
  // Its second editor is the blog's group that only runs beside the feed.
  assert.ok(!manifestLandmarks().includes("src/features/agents/llms-txt-resources.ts"));
});

/** Files i18n added that the manifest edits: a project cut before it never had them, so nothing may report them gone. */
const I18N_ADDED = [I18N_CONFIG, "sanity/sections.ts", "src/features/i18n/strings.ts"];

test("a project cut before i18n is never told a file i18n added is already gone", () => {
  const before = (path: string) => !I18N_ADDED.includes(path) && exists(path);
  const reported = FEATURES.flatMap((feature) =>
    resolveEdits(feature.edits, before, read)
      .missingFiles.filter((file) => I18N_ADDED.includes(file))
      .map((file) => `${feature.id}: ${file}`)
  );

  assert.deepEqual(reported, []);
});

test("every file i18n added is still here, so the list above cannot hide a rename", starterOnly, () => {
  assert.deepEqual(
    I18N_ADDED.filter((path) => !exists(path)),
    []
  );
});

/** The query line Translate with AI added: a project cut with i18n but before it never had it. */
const AI_TRANSLATION_LINE = '"personNames": *[';

test("a project cut before Translate with AI is never told the line it added is missing", () => {
  const readBefore = (file: string) =>
    read(file)
      .split("\n")
      .filter((line) => !line.includes(AI_TRANSLATION_LINE))
      .join("\n");
  const reported = FEATURES.flatMap((feature) =>
    resolveEdits(feature.edits, exists, readBefore)
      .unresolved.filter(({ edit }) => edit.kind === "dropLines" && edit.contains === AI_TRANSLATION_LINE)
      .map(({ file }) => `${feature.id}: ${file}`)
  );

  assert.deepEqual(reported, []);
});

test("every old-shape group has a current-shape twin for the same file, and its marker exists here", starterOnly, () => {
  for (const feature of FEATURES) {
    for (const entry of feature.edits.filter((candidate) => candidate.requiresAbsent)) {
      const twin = feature.edits.find(
        (candidate) => candidate.file === entry.file && candidate.requires === entry.requiresAbsent
      );

      assert.ok(twin, `${feature.id} · ${entry.file}: an old shape with no current one beside it`);
      assert.ok(exists(entry.requiresAbsent ?? ""), `${feature.id} · ${entry.file}: ${entry.requiresAbsent} marks nothing here`);
    }
  }
});

test("a tree with no schema registry is not treated as one where every feature was trimmed", () => {
  const missing = findMissingLandmarks((path) => path !== "sanity/schemas/index.ts");

  assert.deepEqual(missing, ["sanity/schemas/index.ts"]);
});

test("a doc is declared once, as a doc, so index links are pruned rather than the file just vanishing", () => {
  // `docs` also derives the bullets pointing at it, and a doc under `paths` keeps its feature present.
  for (const feature of FEATURES) {
    const both = (feature.docs ?? []).filter((doc) => feature.paths.includes(doc));

    assert.deepEqual(both, [], `${feature.id}: declared under both paths and docs: ${both.join(", ")}`);
  }
});

test("a file the manifest tolerates being absent is never a landmark", () => {
  // `trim.ts` refuses to run when one is missing, so a generated file would be a first-run false alarm.
  const byFile = new Map<string, boolean[]>();

  for (const feature of FEATURES) {
    for (const entry of feature.edits) {
      byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry.optional === true]);
    }
  }

  const alwaysOptional = [...byFile].filter(([, flags]) => flags.every(Boolean)).map(([file]) => file);
  const wrong = manifestLandmarks().filter((file) => alwaysOptional.includes(file));

  assert.deepEqual(wrong, [], `optional everywhere, so not evidence of anything:\n  ${wrong.join("\n  ")}`);
});

/** Paths a doc invents to show a pattern, rather than naming a file that ships. */
const EXAMPLE_PATHS = [
  "src/components/Component.astro",
  "src/components/Name/Name.astro",
  "src/components/Name/NameElement.ts",
  "src/features/page-builder/sections/HeroSection.astro",
];

/** The repository's own prose: docs, its skills (not the vendored ones) and the top-level guides. */
function ownProse(): string[] {
  const vendored = Object.keys((JSON.parse(read("skills-lock.json")) as { skills?: Record<string, unknown> }).skills ?? {}).map(
    (name) => `.agents/skills/${name}/`
  );
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;

      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith(".md") && !vendored.some((prefix) => path.startsWith(prefix))) {
        found.push(path);
      }
    }
  };

  walk("docs");
  walk(".agents/skills");

  return [...found, "AGENTS.md", "README.md", "GETTING-STARTED.md"].filter(exists);
}

test("every code path the docs and skills name still exists", starterOnly, () => {
  // A section that grows a companion moves from a flat file into a folder, and the prose naming the
  // flat file keeps reading as fact. Placeholders (`...`, `<name>`, globs) are not paths, and a
  // trimmed feature's paths are the trim's mention report to list rather than this test's to fail.
  const trimmed = FEATURES.filter((feature) => !present.includes(feature)).flatMap((feature) => feature.paths);
  const isTrimmed = (path: string) => trimmed.some((owned) => path === owned || path.startsWith(`${owned}/`));
  const missing = ownProse().flatMap((file) =>
    [...read(file).matchAll(/`(src\/[^`\s]+)`/g)]
      .map((match) => (match[1] ?? "").replace(/[#:].*$/, "").replace(/\/$/, ""))
      .filter((path) => !/\.\.\.|…|[<>*{}[\]]/.test(path) && !EXAMPLE_PATHS.includes(path) && !isTrimmed(path))
      .filter((path) => ![path, `${path}.ts`, `${path}.astro`].some(exists))
      .map((path) => `${file}: ${path}`)
  );

  assert.deepEqual(missing, []);
});

const languages = present.filter((feature) => feature.language);

test("every language feature switches off a configured locale that is not the default", starterOnly, () => {
  if (languages.length === 0) {
    return;
  }

  const locales = readLocaleConfig(read(I18N_CONFIG));

  assert.ok(locales, `${I18N_CONFIG} has no literal LOCALES`);

  for (const feature of languages) {
    const id = feature.language ?? "";

    // Active as committed, or a commented candidate in the other locale mode.
    assert.ok(
      locales.active.includes(id) || locales.commented.includes(id),
      `${feature.id}: "${id}" is neither active nor a commented candidate in LOCALES`
    );
    assert.notEqual(id, locales.defaultLocale, `${feature.id}: the default locale cannot be trimmed`);
  }
});

test("every language feature owns its dictionary, comments out its entry and drops its registry key", () => {
  for (const feature of FEATURES.filter((candidate) => candidate.language)) {
    const edits = feature.edits.flatMap((entry) => entry.edits.map((edit) => ({ file: entry.file, edit })));

    assert.ok(feature.id === `language:${feature.language}`, `${feature.id}: a language feature is named by its locale`);
    assert.ok(
      feature.paths.some((path) => path.endsWith(`/dictionaries/${feature.language}.ts`)),
      `${feature.id}: no dictionary`
    );
    assert.ok(
      edits.some(
        ({ file, edit }) =>
          file === I18N_CONFIG &&
          edit.kind === "commentOutObjectInArray" &&
          edit.anchor === "LOCALES" &&
          edit.value === feature.language
      ),
      `${feature.id}: LOCALES keeps it active`
    );
    assert.ok(
      edits.some(
        ({ edit }) => edit.kind === "dropObjectProperty" && edit.anchor === "UI_STRINGS" && edit.key === feature.language
      ),
      `${feature.id}: UI_STRINGS keeps its dictionary`
    );
    assert.ok(
      feature.edits.every((entry) => entry.requires === I18N_CONFIG),
      `${feature.id}: every edit needs the locale config, so a project from before i18n skips it`
    );
  }
});

test("a language feature's comment-out is the one the locale toggle makes", async (t) => {
  const toggle = languages.length > 0 ? await loadLocaleToggle() : undefined;

  if (!toggle) {
    t.skip("no language feature is here, or scripts/sanity-migrations/lib/locales.ts is not");
    return;
  }

  const committed = read(I18N_CONFIG);

  for (const feature of languages) {
    const id = feature.language ?? "";
    const edits = feature.edits.filter((entry) => entry.file === I18N_CONFIG).flatMap((entry) => entry.edits);
    // The other locale mode has the entry commented out, so the round trip starts from it switched back on.
    const source: string = readLocaleConfig(committed)?.active.includes(id)
      ? committed
      : toggle.enableCommentedLocales(committed, [id]).source;
    const keep = (readLocaleConfig(source)?.active ?? []).filter((locale) => locale !== id);

    assert.equal(applyEdits(source, edits, I18N_CONFIG), toggle.disableLocales(source, keep).source, feature.id);
    assert.deepEqual(toggle.listLocales(applyEdits(source, edits, I18N_CONFIG))?.commented, [id]);
  }
});

test("findSelectionConflicts refuses a language feature for the default locale", () => {
  const feature = { ...FEATURES[0], id: "language:en", language: "en" } as (typeof FEATURES)[number];

  assert.match(findSelectionConflicts([feature], ON_DISK, { defaultLocale: "en" })[0] ?? "", /default locale/);
  assert.deepEqual(findSelectionConflicts([feature], ON_DISK, { defaultLocale: "fr" }), []);
  assert.deepEqual(findSelectionConflicts([feature], ON_DISK), []);
});

/** What the trim may import statically: `trim:update` restores only its own folder, and these always ship beside it. */
const STATIC_IMPORTS = ["../lib/cli", "../lib/sanity-client", "../sanity-dataset/lib", "../sanity-dataset/dataset-picker"];

test("the trim statically imports nothing a project from before this trim might not have", () => {
  const folder = join(root, "scripts", "trim-features");
  const reaching: string[] = [];

  for (const name of readdirSync(folder).filter((entry) => /\.tsx?$/.test(entry))) {
    const file = ts.createSourceFile(name, readFileSync(join(folder, name), "utf8"), ts.ScriptTarget.Latest, true);

    for (const statement of file.statements) {
      const specifier =
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;
      const isPackage = specifier !== undefined && !specifier.startsWith(".") && !specifier.startsWith("~");

      if (specifier === undefined || isPackage || specifier.startsWith("./") || STATIC_IMPORTS.includes(specifier)) {
        continue;
      }

      reaching.push(`${name} imports ${specifier}`);
    }
  }

  assert.deepEqual(reaching, []);
});

/** Files as they were before i18n, from the last commit without `sanity/i18n.ts`, for every file whose anchors i18n moved. */
const PRE_I18N = join(import.meta.dirname, "fixtures", "pre-i18n");

function preI18nFiles(dir = ""): string[] {
  return readdirSync(join(PRE_I18N, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = dir ? `${dir}/${entry.name}` : entry.name;

    return entry.isDirectory() ? preI18nFiles(path) : [path.replace(/\.fixture$/, "")];
  });
}

test("a project cut before i18n still trims every file whose anchors i18n moved", () => {
  const captured = preI18nFiles();
  // Everything else as it is here: only the locale config marks the shape.
  const before = (path: string) => path !== I18N_CONFIG && exists(path);
  const failures: string[] = [];

  for (const feature of FEATURES) {
    for (const entry of feature.edits.filter((candidate) => isInScope(candidate, before) && captured.includes(candidate.file))) {
      const source = readFileSync(join(PRE_I18N, `${entry.file}.fixture`), "utf8");

      for (const { edit, matches } of verifyEdits(source, entry.edits, entry.file)) {
        if (!(matches === 0 && isSatisfiedWhenAbsent(edit, source, entry.file))) {
          failures.push(`${feature.id} · ${entry.file}: ${describeEdit(edit)} matched ${matches} times`);
        }
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("every old-shape variant is proven against its captured file, where it matches exactly once", () => {
  const captured = preI18nFiles();

  for (const feature of FEATURES) {
    for (const entry of feature.edits.filter((candidate) => candidate.requiresAbsent)) {
      assert.ok(captured.includes(entry.file), `${feature.id} · ${entry.file}: no pre-i18n fixture to prove it against`);

      const source = readFileSync(join(PRE_I18N, `${entry.file}.fixture`), "utf8");

      assert.deepEqual(verifyEdits(source, entry.edits, entry.file), [], `${feature.id} · ${entry.file}`);
    }
  }
});
