// The ghost guard as a rule over every query's tree: a scan or a reference that could reach a document in a language
// the site no longer serves must pass a locale filter first. The rules: docs/features/internationalization.md

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { parse } from "groq-js";
import { AGENT_MARKDOWN_STATE_QUERY } from "~/features/agents/markdown-eligibility";
import { BASIC_AUTH_STATE_QUERY } from "~/features/auth/basic-auth-state";
import { run } from "~/features/utils/common";
import { I18N_DOCUMENT_TYPES } from "~/sanity/constants";
import { GUARDED_REFERENCES } from "~/sanity/ghost-references";
import { DEFAULT_LOCALE } from "~/sanity/i18n";
import {
  ConfiguredLocaleFilter,
  configuredReference,
  DefaultLocaleFilter,
  LocaleFilter,
  LocaleOrDefaultFilter,
  ParentLocaleFilter,
} from "./fragment";
import { HOMEPAGE_LOCALES_QUERY } from "./homepage-locales-state";
import { type InventoriedQuery, inventoryQueries, TYPEGEN_PATHS } from "./query-inventory";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The proxy states' queries: plain strings, so typegen never sees them, in their env-free modules. */
const STATE_QUERIES: Record<string, string> = { BASIC_AUTH_STATE_QUERY, AGENT_MARKDOWN_STATE_QUERY, HOMEPAGE_LOCALES_QUERY };

/** References into translated types, by their path from the document or object holding them; the schema test closes the list. */
const WATCHED_REFERENCES = [...new Set(GUARDED_REFERENCES.map(({ path }) => path))];

type Node = { type: string } & Record<string, unknown>;

/** Scans over `*` reviewed to stay unguarded, keyed by where they sit in their query, with why and what holds instead. */
const EXEMPT_SCANS: Record<string, { why: string; holds: (tree: Node) => boolean }> = {
  "BASIC_AUTH_STATE_QUERY > protectedPaths": {
    why: "a deny-list: guarding it could only open a page, so a protected ghost answers 401, then 404",
    holds: (tree) => !contains(tree, (node) => node.type === "Parameter" && node.name === "locales"),
  },
  "AGENT_MARKDOWN_STATE_QUERY > routes": {
    why: "projects every routed document, never filters, and marks a ghost excluded and gated",
    holds: (tree) => contains(tree, isNotConfigured),
  },
  "LlmsTxtServeQuery > gated": {
    why: "the gated set must name ghosts, so stored llms.txt drops its links to them",
    holds: (tree) => contains(tree, isNotConfigured),
  },
};

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

const isEverything = (value: unknown) => isNode(value) && value.type === "Everything";

const bare = (node: Node): Node => (node.type === "Group" && isNode(node.base) ? bare(node.base) : node);

const filterTree = (fragment: string) => (parse(`*[${fragment}]`) as unknown as { expr: Node }).expr;

const LOCALE_FILTERS = [ConfiguredLocaleFilter, LocaleFilter, DefaultLocaleFilter, LocaleOrDefaultFilter].map(filterTree);
const CONFIGURED_FILTER = filterTree(ConfiguredLocaleFilter);
const PARENT_LOCALE_FILTER = filterTree(ParentLocaleFilter);

const same = (node: Node, fragment: Node) => isDeepStrictEqual(bare(node), bare(fragment));

const isNotConfigured = (node: Node) => node.type === "Not" && isNode(node.base) && same(node.base, CONFIGURED_FILTER);

function contains(node: unknown, match: (node: Node) => boolean): boolean {
  if (Array.isArray(node)) {
    return node.some((child) => contains(child, match));
  }

  if (!isNode(node)) {
    return false;
  }

  return match(node) || Object.values(node).some((child) => contains(child, match));
}

function conjuncts(node: Node): Node[] {
  const inner = bare(node);

  if (inner.type === "And" && isNode(inner.left) && isNode(inner.right)) {
    return [...conjuncts(inner.left), ...conjuncts(inner.right)];
  }

  return [node];
}

function literalStrings(node: unknown): string[] | null {
  if (!isNode(node)) {
    return null;
  }

  if (node.type === "Value" && typeof node.value === "string") {
    return [node.value];
  }

  if (node.type === "Array" && Array.isArray(node.elements)) {
    const values = node.elements.map((element: { value?: unknown }) => (isNode(element.value) ? element.value.value : null));

    return values.every((value): value is string => typeof value === "string") ? values : null;
  }

  return null;
}

const readsOwn = (node: unknown, name: string) =>
  isNode(node) && node.type === "AccessAttribute" && node.name === name && node.base === undefined;

/** The params a scan may pin `_id` to, each with where its ids come from: a new one is reviewed here before it counts. */
const ID_PIN_PARAMS: Record<string, string> = {
  docId: "a page's own `_id`, from the guarded route query that rendered it",
  ids: "the versions the guarded agent Markdown backlog listed",
  assetId: "an image asset, which has no language",
};

/** Params holding one whole document, read as a passing scan's would be: each reviewed here, with why its language is served. */
const DOCUMENT_PARAMS: Record<string, string> = {
  document: "a translation Translate with AI is about to write, into a target language the route checked is configured",
};

const isDocumentParam = (node: Node) =>
  node.type === "Parameter" && typeof node.name === "string" && Object.hasOwn(DOCUMENT_PARAMS, node.name);

/** `_id == "x"`, `_id == $id`, `_id in $ids` or a literal list: known documents, or ones another guarded read listed. */
function isIdPin(node: Node): boolean {
  if (node.type !== "OpCall" || (node.op !== "==" && node.op !== "in") || !readsOwn(node.left, "_id") || !isNode(node.right)) {
    return false;
  }

  const { right } = node;

  return right.type === "Parameter"
    ? typeof right.name === "string" && Object.hasOwn(ID_PIN_PARAMS, right.name)
    : literalStrings(right) !== null;
}

/** `_type == "x"` or `_type in [...]` naming only types with no `language`, which therefore hold no ghost. */
function isUntranslatedTypePin(node: Node): boolean {
  if (node.type !== "OpCall" || (node.op !== "==" && node.op !== "in") || !readsOwn(node.left, "_type")) {
    return false;
  }

  const types = literalStrings(node.right);

  return types !== null && types.length > 0 && types.every((type) => !I18N_DOCUMENT_TYPES.includes(type));
}

type Context = {
  /** Where in the query: its name, then the attributes leading to the node. */
  label: string;
  /** `@` is a document a passing scan let through, so a `ParentLocaleFilter` below it is too. */
  parentGuarded: boolean;
  /** `@`'s path from the document or object the scope reads (see `pathOf`); null when no field path leads there. */
  path: string | null;
  /** Reference paths a `configuredReference()` around this node already checked. */
  guarded: ReadonlySet<string>;
  /** Inside the filter of a passing scan, which decides membership and projects nothing. */
  inPredicate: boolean;
};

const joinPath = (base: string, name: string) => (base ? `${base}.${name}` : name);

/** An array's members, however they are picked or filtered, share one path; a scan's documents keep the root's. */
const memberOf = (path: string | null) => (path === null || path === "" || path.endsWith("[]") ? path : `${path}[]`);

/**
 * `node`'s path from the document or object its scope reads: field names joined by `.`, `[]` for an array's members,
 * `->` once a reference resolves (a chain reads on from the referenced document). Null for anything but a field path.
 */
function pathOf(node: unknown, context: Context): string | null {
  if (!isNode(node)) {
    return null;
  }

  switch (node.type) {
    case "This":
      return context.path;
    case "Parent":
      return "^";
    case "Everything":
      return "";
    case "Parameter":
      return isDocumentParam(node) ? "" : null;
    // `| order(...)` and `| score(...)` keep the documents they are given.
    case "Group":
    case "PipeFuncCall":
      return pathOf(node.base, context);
    case "Deref": {
      const base = pathOf(node.base, context);

      return base === null ? null : `${base}->`;
    }
    case "AccessAttribute": {
      const base = node.base === undefined ? context.path : pathOf(node.base, context);

      return base === null || typeof node.name !== "string" ? null : joinPath(base, node.name);
    }
    case "ArrayCoerce":
    case "Filter":
    case "Slice":
    case "AccessElement":
      return memberOf(pathOf(node.base, context));
    default:
      return null;
  }
}

/** The reference `configuredReference(path)` checks, when the node is one. */
function configuredReferenceTarget(node: Node): Node | null {
  const { op, left, right } = node;

  if (node.type !== "OpCall" || op !== "in" || !isNode(right) || right.type !== "Parameter" || right.name !== "locales") {
    return null;
  }

  if (!isNode(left) || left.type !== "FuncCall" || left.name !== "coalesce" || !Array.isArray(left.args)) {
    return null;
  }

  const [read, fallback] = left.args as unknown[];

  if (!isNode(read) || read.name !== "language" || !isNode(read.base) || read.base.type !== "Deref") {
    return null;
  }

  return isNode(fallback) && fallback.value === DEFAULT_LOCALE && isNode(read.base.base) ? read.base.base : null;
}

/** The path `configuredReference(path)` checks, when the node is one. */
function configuredReferencePath(node: Node, context: Context): string | null {
  const target = configuredReferenceTarget(node);

  return target ? pathOf(target, context) : null;
}

function guardedPathsIn(condition: unknown, context: Context): string[] {
  return isNode(condition) ? conjuncts(condition).flatMap((part) => configuredReferencePath(bare(part), context) ?? []) : [];
}

const isWatched = (path: string) => WATCHED_REFERENCES.some((watched) => path === watched || path.endsWith(`.${watched}`));

/** `exempted` counts each exempt label's scans: an exemption covers the one scan it was reviewed for, never a second. */
type Findings = { scans: string[]; references: string[]; exempted: Map<string, number> };

function inspect(name: string, query: string): Findings {
  const findings: Findings = { scans: [], references: [], exempted: new Map() };
  // Dereferences whose documents a `ConfiguredLocaleFilter` filters before anything reads them.
  const filtered = new WeakSet<Node>();

  function verdict(expr: Node, context: Context): boolean {
    const parts = conjuncts(expr);

    return parts.some(
      (part) =>
        LOCALE_FILTERS.some((filter) => same(part, filter)) ||
        (context.parentGuarded && same(part, PARENT_LOCALE_FILTER)) ||
        isIdPin(bare(part)) ||
        isUntranslatedTypePin(bare(part))
    );
  }

  /** Whether the documents `node` yields all passed a guard, which a `^` below them can then rely on. */
  function yieldsGuarded(node: unknown, context: Context): boolean {
    if (!isNode(node)) {
      return false;
    }

    if (node.type === "This") {
      return context.parentGuarded;
    }

    if (isDocumentParam(node)) {
      return true;
    }

    if (["AccessElement", "Slice", "Group", "PipeFuncCall", "ArrayCoerce"].includes(node.type)) {
      return yieldsGuarded(node.base, context);
    }

    if (node.type === "Filter" && isNode(node.expr)) {
      if (isEverything(node.base)) {
        return verdict(node.expr, context);
      }

      return conjuncts(node.expr).some((part) => same(part, CONFIGURED_FILTER)) || yieldsGuarded(node.base, context);
    }

    return false;
  }

  /** The dereferences whose documents `node` returns as they are. */
  function markFiltered(node: unknown) {
    if (!isNode(node)) {
      return;
    }

    if (node.type === "Deref") {
      filtered.add(node);
    } else if (["Group", "AccessElement", "Slice", "ArrayCoerce", "Filter"].includes(node.type)) {
      markFiltered(node.base);
    } else if (node.type === "Map" || node.type === "FlatMap") {
      markFiltered(node.expr);
    }
  }

  /** A projection reads `@` as the value it projects, so paths below it go on from that value's own. */
  function scope(base: unknown, context: Context): Context {
    return {
      ...context,
      parentGuarded: yieldsGuarded(base, context),
      path: pathOf(base, context),
      guarded: new Set(),
      inPredicate: false,
    };
  }

  function guarding(context: Context, paths: string[]): Context {
    return paths.length > 0 ? { ...context, guarded: new Set([...context.guarded, ...paths]) } : context;
  }

  function visitFilter(node: Node, context: Context) {
    const expr = node.expr as Node;

    if (isEverything(node.base)) {
      const passes = verdict(expr, context);

      if (!passes && Object.hasOwn(EXEMPT_SCANS, context.label)) {
        findings.exempted.set(context.label, (findings.exempted.get(context.label) ?? 0) + 1);
      } else if (!passes) {
        findings.scans.push(context.label);
      }

      visit(expr, { ...context, parentGuarded: passes, path: "", guarded: new Set(), inPredicate: passes });

      return;
    }

    if (conjuncts(expr).some((part) => same(part, CONFIGURED_FILTER))) {
      markFiltered(node.base);
    }

    visit(node.base, context);
    visit(expr, { ...context, parentGuarded: yieldsGuarded(node.base, context), path: memberOf(pathOf(node.base, context)) });
  }

  function visitObject(attributes: Node[], context: Context) {
    attributes.forEach((attribute, index) => {
      if (attribute.type === "ObjectConditionalSplat") {
        visit(attribute.condition, context);
        visit(attribute.value, guarding(context, guardedPathsIn(attribute.condition, context)));

        return;
      }

      if (attribute.type !== "ObjectAttributeValue") {
        visit(attribute, context);

        return;
      }

      // A later `!(configuredReference(path)) => { <this key>: ... }` replaces this value whenever the reference is a ghost.
      const overridden = attributes.slice(index + 1).flatMap((later) => {
        const replaces =
          later.type === "ObjectConditionalSplat" &&
          isNode(later.value) &&
          Array.isArray(later.value.attributes) &&
          later.value.attributes.some((key: { name?: unknown }) => key.name === attribute.name);

        return replaces && isNode(later.condition)
          ? conjuncts(later.condition).flatMap((part) => {
              const inner = bare(part);

              return inner.type === "Not" && isNode(inner.base) ? (configuredReferencePath(bare(inner.base), context) ?? []) : [];
            })
          : [];
      });

      visit(attribute.value, { ...guarding(context, overridden), label: `${context.label} > ${String(attribute.name)}` });
    });
  }

  function visit(node: unknown, context: Context): void {
    if (Array.isArray(node)) {
      for (const child of node) {
        visit(child, context);
      }

      return;
    }

    if (!isNode(node)) {
      return;
    }

    const checked = configuredReferenceTarget(node);

    // A `configuredReference()` reads the target's `language` itself: that read is the guard, not a leak.
    if (checked) {
      visit(checked, context);

      return;
    }

    switch (node.type) {
      case "Everything":
        findings.scans.push(`${context.label} (unfiltered)`);
        return;
      case "Filter":
        visitFilter(node, context);
        return;
      case "Projection":
        visit(node.base, context);
        visit(node.expr, scope(node.base, context));
        return;
      case "Map":
      case "FlatMap":
        visit(node.base, context);
        visit(node.expr, {
          ...context,
          parentGuarded: yieldsGuarded(node.base, context),
          path: memberOf(pathOf(node.base, context)),
          guarded: new Set(),
        });
        return;
      case "Select":
        for (const alternative of node.alternatives as Node[]) {
          visit(alternative.condition, context);
          visit(alternative.value, guarding(context, guardedPathsIn(alternative.condition, context)));
        }

        visit(node.fallback, context);
        return;
      case "Object":
        visitObject(node.attributes as Node[], context);
        return;
      case "Deref": {
        const path = pathOf(node.base, context);

        // A reference reached through anything but a field path could be any of them, so it must be guarded too.
        if (!context.inPredicate && !filtered.has(node) && (path === null || (isWatched(path) && !context.guarded.has(path)))) {
          findings.references.push(`${context.label}: ${path ?? "(not a field path)"}->`);
        }

        visit(node.base, context);
        return;
      }
      default:
        for (const child of Object.values(node)) {
          visit(child, context);
        }
    }
  }

  visit(parse(query), { label: name, parentGuarded: false, path: "", guarded: new Set(), inPredicate: false });

  return findings;
}

/** Source files under `dir` with one of `extensions`, as paths from the root; tests stub reads, so they are left out. */
function sourceFiles(dir: string, extensions: string[]): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .map((file) => join(dir, file))
    .filter((file) => extensions.some((extension) => file.endsWith(extension)) && !file.endsWith(".test.ts"));
}

/** A Plop template with each `{{helper name}}` read as one identifier, so its code scans like the code it generates. */
const scaffolded = (source: string) => source.replace(/\{\{[^}]*\}\}/g, "Scaffolded");

/** Past a type argument list (`<T>`) opening at `index`, if there is one, and the whitespace around it. */
function afterTypeArguments(source: string, index: number): number {
  let at = index;

  while (/\s/.test(source.charAt(at))) {
    at++;
  }

  if (source.charAt(at) === "<") {
    for (let depth = 0; at < source.length; at++) {
      depth += run(() => {
        if (source.charAt(at) === "<") {
          return 1;
        }
        if (source.charAt(at) === ">") {
          return -1;
        }
        return 0;
      });

      if (depth === 0) {
        at++;
        break;
      }
    }
  }

  while (/\s/.test(source.charAt(at))) {
    at++;
  }

  return at;
}

/** The arguments of the call whose `(` is at `open`, split on its own commas, string literals read whole. */
function callArguments(source: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;

  for (let at = open; at < source.length; at++) {
    const char = source.charAt(at);

    if (char === '"' || char === "'" || char === "`") {
      const end = source.indexOf(char, at + 1);

      at = end === -1 ? source.length : end;
    } else if ("([{".includes(char)) {
      depth++;
    } else if (")]}".includes(char)) {
      depth--;

      if (depth === 0) {
        args.push(source.slice(start, at));

        return args;
      }
    } else if (char === "," && depth === 1) {
      args.push(source.slice(start, at));
      start = at + 1;
    }
  }

  return args;
}

/** The query each `loadQuery({ query })` and `fetchSanity(client, query)` call passes, as written. */
function queriesPassed(source: string): string[] {
  return [...source.matchAll(/(?<![\w$.])(loadQuery|fetchSanity)\b/g)].flatMap((match) => {
    const open = afterTypeArguments(source, (match.index ?? 0) + match[0].length);

    if (source.charAt(open) !== "(") {
      return [];
    }

    const args = callArguments(source, open);
    const query =
      match[1] === "loadQuery" ? /^\s*\{[\s\S]*?\bquery\s*:\s*([\w$]+)\s*[,}]/.exec(args[0] ?? "")?.[1] : args[1]?.trim();

    return [query && /^[\w$]+$/.test(query) ? query : `${match[1]}(${args.join(",").trim().slice(0, 60)})`];
  });
}

let queries: (InventoriedQuery & Findings)[] = [];

before(async () => {
  const inventory = await inventoryQueries();

  assert.deepEqual(inventory.errors, [], "typegen drops a query it cannot read, and so would this rule");

  queries = [
    ...inventory.queries,
    ...Object.entries(STATE_QUERIES).map(([name, query]) => ({ name, file: "proxy state", query })),
  ].map((entry) => ({ ...entry, ...inspect(entry.name, entry.query) }));
});

describe("the ghost guard over every query", () => {
  it("reads every query typegen reads", () => {
    const config = readFileSync(join(ROOT, "sanity.cli.ts"), "utf8");
    const declared = /typegen:\s*\{[\s\S]*?\bpath:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? "";

    assert.deepEqual(
      [...declared.matchAll(/"([^"]*)"/g)].map(([, path]) => path),
      TYPEGEN_PATHS,
      "sanity.cli.ts scans other paths"
    );
    assert.ok(queries.some(({ name }) => name === "PageQ") && queries.some(({ name }) => name === "SitemapQ"));
  });

  it("reads every query a page or an endpoint sends, so none is written where typegen cannot see it", () => {
    const seams = new Set([join("src", "sanity", "lib", "load-query.ts"), join("src", "sanity", "lib", "fetch.ts")]);
    const named = new Set(queries.map(({ name }) => name));
    const templates = sourceFiles("templates", [".hbs"]).map((file) => scaffolded(readFileSync(join(ROOT, file), "utf8")));
    const scaffoldedQueries = templates.flatMap((source) =>
      [...source.matchAll(/export const ([\w$]+)\s*=\s*defineQuery/g)].map(([, name]) => name)
    );
    let reads = 0;

    const unread = [...sourceFiles("src", [".ts", ".tsx", ".astro"]), ...sourceFiles("templates", [".hbs"])]
      .filter((file) => !seams.has(file))
      .flatMap((file) => {
        const source = readFileSync(join(ROOT, file), "utf8");
        const passed = queriesPassed(file.endsWith(".hbs") ? scaffolded(source) : source);
        const known = file.endsWith(".hbs") ? new Set([...named, ...scaffoldedQueries]) : named;

        reads += passed.length;

        return passed.filter((query) => !known.has(query)).map((query) => `${file}: ${query}`);
      });

    assert.ok(reads > 20 && named.has("PageQ"), "finds the reads");
    assert.deepEqual(unread, [], "pass a query `defineQuery` declares where typegen scans, by its own name");
  });

  it("reads every proxy state's query", () => {
    const states = sourceFiles("src", [".ts"]).flatMap((file) =>
      [
        ...readFileSync(join(ROOT, file), "utf8").matchAll(
          /(?<!function\s+)\bcreateProxySanityState\b\s*(?:<[^>]*>)?\s*\(\s*([^,)]*)/g
        ),
      ].map(([, query]) => query?.trim())
    );

    assert.ok(states.length > 0, "finds the states");
    assert.deepEqual(new Set(states), new Set(Object.keys(STATE_QUERIES)), "move a new state's query into an env-free module");
  });

  it("lets every scan over `*` through a locale filter, an `_id` pin or an untranslated type, unless it is exempt", () => {
    const unguarded = queries.flatMap(({ scans }) => scans);

    assert.deepEqual(unguarded, [], `add ${ConfiguredLocaleFilter} (or another locale filter) to each`);
  });

  it("reads a reference into a translated type only past configuredReference() or a guarded filter", () => {
    const unguarded = queries.flatMap(({ references }) => references);

    assert.deepEqual(unguarded, [], "wrap each in select(configuredReference(path) => ...)");
  });

  it("uses every exemption, and what each relies on instead still holds", () => {
    for (const [label, { why, holds }] of Object.entries(EXEMPT_SCANS)) {
      const query = queries.find(({ name }) => name === label.split(" > ")[0]);

      if (!query) {
        continue;
      }

      assert.ok(query.exempted.has(label), `${label} passes on its own now: drop the exemption`);
      assert.equal(query.exempted.get(label), 1, `${label} holds a second unguarded scan, which the exemption does not cover`);
      assert.ok(holds(parse(query.query) as unknown as Node), `${label}: ${why}`);
    }
  });

  it("starts scaffolded queries guarded", () => {
    const route = readFileSync(join(ROOT, "templates", "page-route", "queries.ts.hbs"), "utf8");
    const section = readFileSync(join(ROOT, "templates", "page-builder-section", "query.ts.hbs"), "utf8");

    assert.match(route, /uri\.current == \$uri && \$\{ConfiguredLocaleFilter\}/);
    assert.match(section, /\*\[_id == \$docId\]/);
  });
});

describe("the rule itself", () => {
  const guardedPage = `*[_type == "page" && uri.current == $uri && ${ConfiguredLocaleFilter}][0]`;

  it("flags a scan or a reference with no guard", () => {
    assert.deepEqual(inspect("Q", `*[_type == "page" && uri.current == $uri][0]`).scans, ["Q"]);
    assert.deepEqual(inspect("Q", `{ "list": *[defined(uri.current)].uri.current }`).scans, ["Q > list"]);
    assert.deepEqual(inspect("Q", `count(*)`).scans, ["Q (unfiltered)"]);
    assert.deepEqual(inspect("Q", `${guardedPage}{ "author": author->name }`).references, ["Q > author: author->"]);
    assert.deepEqual(inspect("Q", `${guardedPage}{ "links": links[]{ "href": internal.link->uri.current } }`).references, [
      "Q > links > href: links[].internal.link->",
    ]);
    assert.deepEqual(
      inspect(
        "Q",
        `${guardedPage}{ "a": *[_type == "translation.metadata" && references(^._id)].translations[].value->uri.current }`
      ).references,
      ["Q > a: translations[].value->"]
    );
  });

  it("trusts a parent locale only under a guarded parent", () => {
    // `site` and `page` are translated in every project, whatever a trim removed.
    const join = `{ "site": *[_type == "site" && ${ParentLocaleFilter}][0] }`;

    assert.deepEqual(inspect("Q", `${guardedPage}${join}`).scans, []);
    assert.deepEqual(inspect("Q", `*[_type == "page" && uri.current == $uri][0]${join}`).scans, ["Q", "Q > site"]);
  });

  it("trusts an `_id` pinned to a param only once the param's source is reviewed", () => {
    assert.deepEqual(inspect("Q", `*[_type == "page" && _id == $fromTheRequest][0]`).scans, ["Q"]);
    assert.deepEqual(inspect("Q", `*[_id == $docId][0]`).scans, []);
  });

  it("reads a reviewed document param as a guarded document, and any other param as no field path", () => {
    const projection = `{ "related": *[_type == "page" && ${ParentLocaleFilter}], "author": select(${configuredReference("author")} => author->name) }`;
    const reviewed = inspect("Q", `$document${projection}`);
    const unreviewed = inspect("Q", `$fromTheRequest${projection}`);

    assert.deepEqual([...reviewed.scans, ...reviewed.references], []);
    assert.deepEqual(inspect("Q", `$document{ "author": author->name }`).references, ["Q > author: author->"]);
    assert.deepEqual(unreviewed.scans, ["Q > related"]);
    assert.deepEqual(unreviewed.references, ["Q > author: (not a field path)->"]);
  });

  it("passes pins, untranslated types, every locale filter and every reference guard", () => {
    const passing = [
      `*[_id == $docId][0]`,
      `*[_id in $ids]{ _id }`,
      `*[_type == "articleCategory"]`,
      `*[_type in ["sanity.imageAsset", "translation.metadata"]]`,
      `*[_type == "site" && ${LocaleOrDefaultFilter}][0]`,
      `*[_type == "article" && ${LocaleFilter}]`,
      `*[_type == "article" && ${DefaultLocaleFilter}]`,
      `${guardedPage}{ "author": select(${configuredReference("author")} => author->{ name }) }`,
      `${guardedPage}{ "related": *[_type == "article" && ${ParentLocaleFilter} && author->name == "x"] }`,
      `${guardedPage}{ "a": (*[_type == "translation.metadata" && references(^._id)].translations[].value->)[${ConfiguredLocaleFilter}] }`,
      `${guardedPage}{ "l": appLink{ "href": internal.link->uri.current, type == "internal" && !(${configuredReference("internal.link")}) => { "href": "" } } }`,
    ];

    for (const query of passing) {
      const { scans, references } = inspect("Q", query);

      assert.deepEqual([...scans, ...references], [], query);
    }
  });

  it("does not trust an override that leaves the read key in place", () => {
    const query = `${guardedPage}{ "l": appLink{ "text": internal.link->title, !(${configuredReference("internal.link")}) => { "href": "" } } }`;

    assert.deepEqual(inspect("Q", query).references, ["Q > l > text: appLink.internal.link->"]);
  });

  it("follows a reference however its field path is reached, and flags one reached through anything else", () => {
    const unguarded: [projection: string, reference: string, label?: string][] = [
      [`{ "a": (author)->name }`, "author->"],
      [`{ "a": translations[0].value->uri.current }`, "translations[].value->"],
      [`{ "a": translations[_key == "x"].value->uri.current }`, "translations[].value->"],
      [`{ "a": translations[0..1].value->uri.current }`, "translations[].value->"],
      [`{ "a": translations[]{ "uri": value->uri.current } }`, "translations[].value->", "a > uri"],
      [
        `{ "a": *[_type == "translation.metadata" && references(^._id)][0].translations[].value->uri.current }`,
        "translations[].value->",
      ],
      [
        `{ "a": select(${configuredReference("appLink.internal.link")} => appLink.internal.link->author->name) }`,
        "appLink.internal.link->.author->",
      ],
      [`{ "a": select(${configuredReference("author")} => author->author->name) }`, "author->.author->"],
      [`{ "a": coalesce(author, editor)->name }`, "(not a field path)->"],
      [`{ "a": select(defined(author) => author)->name }`, "(not a field path)->"],
    ];

    for (const [projection, reference, label = "a"] of unguarded) {
      assert.deepEqual(inspect("Q", `${guardedPage}${projection}`).references, [`Q > ${label}: ${reference}`], projection);
    }
  });

  it("reads a scan nested inside a reference check", () => {
    const query = `${guardedPage}{ "a": select(coalesce(*[_type == "page"][0].author->language, "${DEFAULT_LOCALE}") in $locales => 1) }`;

    assert.deepEqual(inspect("Q", query).scans, ["Q > a"]);
  });

  it("watches every reference the schema test closes the list of", () => {
    for (const { path } of GUARDED_REFERENCES) {
      const query = `${guardedPage}{ "a": ${path.replaceAll("[]", "[0]")}->name }`;

      assert.equal(inspect("Q", query).references.length, 1, path);
    }
  });
});
