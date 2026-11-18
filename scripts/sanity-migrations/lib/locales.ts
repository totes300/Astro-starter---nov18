// The LOCALES comment toggle: a commented-out entry is a candidate language, so switching it back on is one uncomment.
// Source text in, source text out: it parses sanity/i18n.ts and never imports it.

import ts from "typescript";

const ANCHOR = "LOCALES";

const DEFAULT_ANCHOR = "DEFAULT_LOCALE";

/** A candidate: `// { id: "it", ... },` alone on its line, optionally followed by a line comment. */
const CANDIDATE_LINE = /^([ \t]*)\/\/[ \t]*(\{.*?\})[ \t]*,?[ \t]*(\/\/.*)?$/;

/** What may follow an entry on its last line: its comma and a line comment, nothing else. */
const LINE_TAIL = /^[ \t]*(,?)[ \t]*(\/\/.*)?$/;

const NOT_LITERAL = "LOCALES in sanity/i18n.ts is not a literal array of { id } entries, so no script can switch its languages.";

export type LocaleList = { active: string[]; commented: string[]; defaultLocale?: string };

export type Refusal = { id?: string; reason: string };

export type DisabledLocales = { source: string; disabled: string[]; refused: Refusal[] };

export type EnabledLocales = { source: string; enabled: string[] };

type Entry = { id: string; node: ts.ObjectLiteralExpression; idProperty: ts.ObjectLiteralElementLike };

type Candidate = { id: string; start: number; end: number; indent: string; entry: string; comment?: string };

type Parsed = { file: ts.SourceFile; entries: Entry[]; candidates: Candidate[]; defaultLocale?: string };

type Range = { start: number; end: number; text: string };

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

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
}

/** The entry's `id`, when it is a plain string literal; anything computed cannot be toggled by text. */
function entryOf(node: ts.Expression): Entry | undefined {
  if (!ts.isObjectLiteralExpression(node)) {
    return undefined;
  }

  const idProperty = node.properties.find((property) => propertyName(property.name) === "id");

  if (!idProperty || !ts.isPropertyAssignment(idProperty) || !ts.isStringLiteral(idProperty.initializer)) {
    return undefined;
  }

  return { id: idProperty.initializer.text, node, idProperty };
}

function isValidSyntax(text: string): boolean {
  const { diagnostics = [] } = ts.transpileModule(text, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.Latest },
  });

  return diagnostics.length === 0;
}

/** The commented text, if it is a whole `{ id: "..." }` object a later uncomment turns back into a valid entry. */
function candidateId(entry: string): string | undefined {
  const text = `(${entry});`;
  const file = ts.createSourceFile("candidate.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const [statement] = file.statements;

  if (file.statements.length !== 1 || !statement || !ts.isExpressionStatement(statement) || !isValidSyntax(text)) {
    return undefined;
  }

  return entryOf(unwrap(statement.expression))?.id;
}

function lineEndAt(source: string, index: number): number {
  const newline = source.indexOf("\n", index);
  const end = newline === -1 ? source.length : newline;

  return source[end - 1] === "\r" ? end - 1 : end;
}

function findCandidates(source: string, array: ts.ArrayLiteralExpression, file: ts.SourceFile, entries: Entry[]): Candidate[] {
  const candidates: Candidate[] = [];
  const open = array.getStart(file) + 1;
  const close = array.end - 1;
  const insideEntry = (index: number) => entries.some(({ node }) => index >= node.getStart(file) && index < node.end);
  let start = source.indexOf("\n", open) + 1;

  while (start > 0 && start < close) {
    const end = lineEndAt(source, start);
    const match = end <= close && !insideEntry(start) ? CANDIDATE_LINE.exec(source.slice(start, end)) : null;
    const id = match ? candidateId(match[2] ?? "") : undefined;

    if (match && id !== undefined) {
      candidates.push({ id, start, end, indent: match[1] ?? "", entry: match[2] ?? "", comment: match[3] });
    }

    start = source.indexOf("\n", end) + 1;
  }

  return candidates;
}

function parse(source: string): Parsed | undefined {
  const file = ts.createSourceFile("i18n.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const arrays = initializersOf(file, ANCHOR);
  const [array] = arrays;

  if (arrays.length !== 1 || !array || !ts.isArrayLiteralExpression(array)) {
    return undefined;
  }

  const entries = array.elements.map(entryOf);

  if (entries.some((entry) => entry === undefined)) {
    return undefined;
  }

  const known = entries as Entry[];
  const [defaultInitializer] = initializersOf(file, DEFAULT_ANCHOR);

  return {
    file,
    entries: known,
    candidates: findCandidates(source, array, file, known),
    defaultLocale: defaultInitializer && ts.isStringLiteral(defaultInitializer) ? defaultInitializer.text : undefined,
  };
}

function splice(source: string, ranges: readonly Range[]): string {
  return [...ranges]
    .sort((a, b) => b.start - a.start)
    .reduce((text, { start, end, text: replacement }) => `${text.slice(0, start)}${replacement}${text.slice(end)}`, source);
}

/** Active ids, commented candidates and the literal `DEFAULT_LOCALE`; undefined when LOCALES is not a literal array. */
export function listLocales(source: string): LocaleList | undefined {
  const parsed = parse(source);

  if (!parsed) {
    return undefined;
  }

  const active = parsed.entries.map(({ id }) => id);
  const commented = unique(parsed.candidates.map(({ id }) => id).filter((id) => !active.includes(id)));

  return { active, commented, defaultLocale: parsed.defaultLocale };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Uncomments every candidate inside LOCALES (or only `ids`), keeping its indent and any trailing comment. */
export function enableCommentedLocales(source: string, ids?: readonly string[]): EnabledLocales {
  const parsed = parse(source);

  if (!parsed) {
    return { source, enabled: [] };
  }

  const enabled: string[] = [];
  const ranges: Range[] = [];

  for (const { id, start, end, indent, entry, comment } of parsed.candidates) {
    const isActive = parsed.entries.some((active) => active.id === id);

    if (isActive || enabled.includes(id) || (ids && !ids.includes(id))) {
      continue;
    }

    enabled.push(id);
    ranges.push({ start, end, text: `${indent}${entry},${comment ? ` ${comment}` : ""}` });
  }

  return { source: splice(source, [...ranges, ...missingCommas(source, parsed, ranges)]), enabled };
}

/** A last entry written without its comma gets one when a candidate after it comes back, or the array stops parsing. */
function missingCommas(source: string, parsed: Parsed, enabled: readonly Range[]): Range[] {
  const commas = new Map<number, Range>();

  for (const { start } of enabled) {
    const before = parsed.entries.filter(({ node }) => node.end <= start).at(-1)?.node;
    const between = before ? enabled.some((range) => range.start > before.end && range.start < start) : true;

    if (before && !between && !isFollowedByComma(source, before.end)) {
      commas.set(before.end, { start: before.end, end: before.end, text: "," });
    }
  }

  return [...commas.values()];
}

/** Whether the next token after `index`, comments skipped, is a comma. */
function isFollowedByComma(source: string, index: number): boolean {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source, undefined, index);

  return scanner.scan() === ts.SyntaxKind.CommaToken;
}

/** A comment or a template literal would not survive being folded into one commented line. */
function hasCommentOrTemplate(text: string): boolean {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const refused = new Set([
    ts.SyntaxKind.SingleLineCommentTrivia,
    ts.SyntaxKind.MultiLineCommentTrivia,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
  ]);

  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (refused.has(token)) {
      return true;
    }
  }

  return false;
}

/** The one line an entry becomes: `id` first, then its other properties as written, whitespace folded. */
export function commentedEntry(entry: { id: string; properties: readonly string[] }): string {
  const properties = [`id: ${JSON.stringify(entry.id)}`, ...entry.properties.map((text) => text.replace(/\s*\n\s*/g, " "))];

  return `// { ${properties.join(", ")} },`;
}

function commentOut(source: string, parsed: Parsed, entry: Entry, isLast: boolean): Range | Refusal {
  const start = entry.node.getStart(parsed.file);
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = lineEndAt(source, entry.node.end);
  const indent = source.slice(lineStart, start);
  const tail = LINE_TAIL.exec(source.slice(entry.node.end, lineEnd));
  const ownLine = "it shares a line with other code, so it cannot become one commented line.";

  if (!/^[ \t]*$/.test(indent) || !tail || (!tail[1] && !isLast)) {
    return { id: entry.id, reason: ownLine };
  }

  if (hasCommentOrTemplate(entry.node.getText(parsed.file))) {
    return { id: entry.id, reason: "it contains a comment or a template literal, which one commented line cannot carry." };
  }

  const properties = entry.node.properties
    .filter((property) => property !== entry.idProperty)
    .map((property) => property.getText(parsed.file));
  const movedComment = tail[2] ? `${indent}${tail[2]}\n` : "";

  return { start: lineStart, end: lineEnd, text: `${movedComment}${indent}${commentedEntry({ id: entry.id, properties })}` };
}

/** Comments out every active entry outside `keep`, never the default: a trailing comment moves to its own line above. */
export function disableLocales(source: string, keep: readonly string[]): DisabledLocales {
  const parsed = parse(source);

  if (!parsed) {
    return { source, disabled: [], refused: [{ reason: NOT_LITERAL }] };
  }

  const defaultLocale = parsed.defaultLocale ?? parsed.entries[0]?.id;
  const disabled: string[] = [];
  const refused: Refusal[] = [];
  const ranges: Range[] = [];

  for (const [index, entry] of parsed.entries.entries()) {
    if (keep.includes(entry.id)) {
      continue;
    }

    if (entry.id === defaultLocale) {
      refused.push({ id: entry.id, reason: "it is the default locale, which is never switched off." });
      continue;
    }

    const outcome = commentOut(source, parsed, entry, index === parsed.entries.length - 1);

    if ("reason" in outcome) {
      refused.push(outcome);
    } else {
      ranges.push(outcome);
      disabled.push(entry.id);
    }
  }

  return { source: splice(source, ranges), disabled, refused };
}

/** The mode `source` does not run: several locales fold to the default, one locale enables its candidates. */
export function otherLocaleMode(source: string): DisabledLocales & EnabledLocales {
  const list = listLocales(source);

  if (!list) {
    return { source, enabled: [], disabled: [], refused: [{ reason: NOT_LITERAL }] };
  }

  if (list.active.length > 1) {
    const defaultLocale = list.defaultLocale ?? list.active[0] ?? "";

    return { ...disableLocales(source, [defaultLocale]), enabled: [] };
  }

  return { ...enableCommentedLocales(source), disabled: [], refused: [] };
}
