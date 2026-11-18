// What the trim reads of the project's languages: LOCALES by AST, and the translated types from sanity/constants.ts.
// A project cut before i18n has no sanity/i18n.ts, and every language stage is skipped there.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import type { Unresolved } from "./edits";
import { LANGUAGE_ID, type LanguageRemovalConfig, type LocaleConfig } from "./language-removal";

export const I18N_CONFIG = "sanity/i18n.ts";

const CONSTANTS = "sanity/constants.ts";

const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
/** A field translated in place, or one nested a level down in an object (`seoMetadata.title`). */
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** A candidate: `// { id: "it", ... },` alone on its line, optionally followed by a line comment. */
const CANDIDATE_LINE = /^([ \t]*)\/\/[ \t]*(\{.*?\})[ \t]*,?[ \t]*(\/\/.*)?$/;

export type LocaleList = { defaultLocale: string; active: string[]; commented: string[] };

export type I18nContext = LocaleList & {
  i18nTypes: string[];
  localizedFields: Record<string, string[]>;
};

/** No context and no problem: a project from before i18n. A problem: languages the trim cannot read. */
export type I18nLoad = { context?: I18nContext; problem?: string };

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;

  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }

  return current;
}

function initializersOf(file: ts.SourceFile, name: string): ts.Expression[] {
  const found: ts.Expression[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      found.push(unwrap(node.initializer));
    }

    ts.forEachChild(node, visit);
  };

  visit(file);

  return found;
}

function idOf(node: ts.Expression): string | undefined {
  if (!ts.isObjectLiteralExpression(node)) {
    return undefined;
  }

  const property = node.properties.find(
    (candidate) =>
      candidate.name && (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) && candidate.name.text === "id"
  );

  return property && ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer)
    ? property.initializer.text
    : undefined;
}

/** The commented text, when it is a whole `{ id: "..." }` object an uncomment turns back into a valid entry. */
function candidateId(entry: string): string | undefined {
  const text = `(${entry});`;
  const file = ts.createSourceFile("candidate.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const [statement] = file.statements;
  const { diagnostics = [] } = ts.transpileModule(text, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.Latest },
  });

  if (file.statements.length !== 1 || !statement || !ts.isExpressionStatement(statement) || diagnostics.length > 0) {
    return undefined;
  }

  return idOf(unwrap(statement.expression));
}

/** Active ids, commented candidates inside the array and the literal `DEFAULT_LOCALE`; undefined when LOCALES is computed. */
export function readLocaleConfig(source: string): LocaleList | undefined {
  const file = ts.createSourceFile("i18n.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const arrays = initializersOf(file, "LOCALES");
  const [array] = arrays;

  if (arrays.length !== 1 || !array || !ts.isArrayLiteralExpression(array)) {
    return undefined;
  }

  const ids = array.elements.map((element) => idOf(unwrap(element)));

  if (ids.some((id) => id === undefined)) {
    return undefined;
  }

  const active = ids as string[];
  const insideEntry = (index: number) => array.elements.some((element) => index >= element.getStart(file) && index < element.end);
  const commented: string[] = [];
  const close = array.end - 1;
  let start = source.indexOf("\n", array.getStart(file) + 1) + 1;

  while (start > 0 && start < close) {
    const newline = source.indexOf("\n", start);
    const end = newline === -1 ? source.length : newline;
    const line = source.slice(start, source[end - 1] === "\r" ? end - 1 : end);
    const match = end <= close && !insideEntry(start) ? CANDIDATE_LINE.exec(line) : null;
    const id = match ? candidateId(match[2] ?? "") : undefined;

    if (id !== undefined && !active.includes(id) && !commented.includes(id)) {
      commented.push(id);
    }

    start = newline === -1 ? 0 : newline + 1;
  }

  const [defaultInitializer] = initializersOf(file, "DEFAULT_LOCALE");
  const defaultLocale = defaultInitializer && ts.isStringLiteral(defaultInitializer) ? defaultInitializer.text : active[0];

  return defaultLocale === undefined ? undefined : { defaultLocale, active, commented };
}

function isNameList(value: unknown, pattern: RegExp): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && pattern.test(entry));
}

/** `LOCALIZED_FIELDS` as plain data, or undefined when its shape is anything but `{ type: ["field"] }`. */
function readLocalizedFields(value: unknown): Record<string, string[]> | undefined {
  if (value === undefined) {
    return {};
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value);

  if (!entries.every(([type, fields]) => TYPE_NAME.test(type) && isNameList(fields, FIELD_PATH))) {
    return undefined;
  }

  return Object.fromEntries(entries.map(([type, fields]) => [type, [...(fields as string[])]]));
}

/**
 * Read once, before anything is trimmed, so every plan in a run sees the same snapshot. A constants
 * module that imports app code cannot load here, and that reads as languages unreadable, never a crash.
 */
export async function loadI18nContext(root: string): Promise<I18nLoad> {
  const configPath = join(root, I18N_CONFIG);

  if (!existsSync(configPath)) {
    return {};
  }

  const locales = readLocaleConfig(readFileSync(configPath, "utf8"));

  if (!locales) {
    return { problem: `LOCALES in ${I18N_CONFIG} is not a literal array of { id } entries, so its languages cannot be read.` };
  }

  const invalid = [locales.defaultLocale, ...locales.active].find((locale) => !LANGUAGE_ID.test(locale));

  if (invalid !== undefined) {
    return { problem: `${I18N_CONFIG} configures ${JSON.stringify(invalid)}, which is not a language code.` };
  }

  let constants: Record<string, unknown>;

  try {
    constants = (await import(pathToFileURL(join(root, CONSTANTS)).href)) as Record<string, unknown>;
  } catch (error) {
    return {
      problem: `${CONSTANTS} could not be loaded (${error instanceof Error ? error.message : String(error)}), so the translated types are unknown.`,
    };
  }

  const i18nTypes = constants.I18N_DOCUMENT_TYPES;
  const localizedFields = readLocalizedFields(constants.LOCALIZED_FIELDS);

  if (!isNameList(i18nTypes, TYPE_NAME)) {
    return { problem: `${CONSTANTS} exports no I18N_DOCUMENT_TYPES list of type names, so no document can be read by language.` };
  }

  if (!localizedFields) {
    return { problem: `LOCALIZED_FIELDS in ${CONSTANTS} is not a map of types to field names.` };
  }

  return { context: { ...locales, i18nTypes: [...i18nTypes], localizedFields } };
}

/** The census reads every language against what is configured now. */
export function censusConfig(context: I18nContext): LocaleConfig {
  return {
    defaultLocale: context.defaultLocale,
    keep: context.active,
    i18nTypes: context.i18nTypes,
    localizedFields: context.localizedFields,
  };
}

/** A removal keeps what stays configured once `removed` is switched off. */
export function removalConfig(context: I18nContext, removed: readonly string[]): LanguageRemovalConfig {
  return { ...censusConfig(context), keep: context.active.filter((locale) => !removed.includes(locale)), removed };
}

/** The languages a run really switches off: one whose LOCALES comment-out was left to a person stays on, content and all. */
export function switchedOff(languages: readonly string[], unresolved: readonly Unresolved[]): string[] {
  const left = new Set(
    unresolved.flatMap(({ file, edit }) => (file === I18N_CONFIG && edit.kind === "commentOutObjectInArray" ? [edit.value] : []))
  );

  return languages.filter((language) => !left.has(language));
}

/** Of `removed`, what `sanity/i18n.ts` still configures; all of them when it is missing or cannot be read. */
export function stillConfigured(source: string | undefined, removed: readonly string[]): string[] {
  const active = source === undefined ? undefined : readLocaleConfig(source)?.active;

  return active ? removed.filter((language) => active.includes(language)) : [...removed];
}
