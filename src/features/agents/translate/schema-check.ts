import type { SanityClient } from "@sanity/client";
import { AiTranslationDeployedSchemaQuery } from "~/features/agents/query";
import { CONDITIONAL_PATHS } from "~/sanity/ai-translation/fields";
import type { SchemaCheck } from "~/sanity/ai-translation/wire";
import { I18N_DOCUMENT_TYPES } from "~/sanity/constants";
import { fetchSanity } from "../../../sanity/lib/fetch";
import { RAW } from "./shared";

const SCHEMA_CHECK_TTL_MS = 60_000;

type SchemaField = {
  name?: string;
  type?: string;
  fields?: SchemaField[];
  of?: SchemaField[];
  marks?: { annotations?: SchemaField[] };
};

/** An array's `of` is one value (a union for several members); a union's is the list of them. */
type ExtractValue = {
  type?: string;
  name?: string;
  of?: ExtractValue | ExtractValue[];
  attributes?: Record<string, { value?: ExtractValue }>;
};

type ExtractEntry = { type?: string; name?: string; value?: ExtractValue; attributes?: Record<string, { value?: ExtractValue }> };

const STRING_TYPES = new Set(["string", "text", "url", "email", "date", "datetime"]);
const OBJECT_TYPES = new Set(["object", "image", "file", "slug", "reference", "crossDatasetReference", "geopoint", "document"]);
const KINDS = new Set(["string", "number", "boolean", "array", "object"]);
const EXTRACT_SYSTEM_FIELDS = new Set(["_id", "_type", "_createdAt", "_updatedAt", "_rev"]);

/** A deployed field as JSON sees it: named types resolved, `text` and `url` read as strings, assets and slugs as objects. */
function deployedKind(type: string | undefined, types: ReadonlyMap<string, SchemaField>, seen = new Set<string>()): string {
  if (!type) {
    return "unknown";
  }

  if (STRING_TYPES.has(type)) {
    return "string";
  }

  if (OBJECT_TYPES.has(type)) {
    return "object";
  }

  if (KINDS.has(type)) {
    return type;
  }

  const named = types.get(type);

  return named && !seen.has(type) ? deployedKind(named.type, types, new Set([...seen, type])) : "unknown";
}

function extractKind(
  value: ExtractValue | undefined,
  types: ReadonlyMap<string, ExtractEntry>,
  seen = new Set<string>()
): string {
  if (!value?.type) {
    return "unknown";
  }

  if (value.type === "inline" && value.name) {
    const named = types.get(value.name);

    if (!named || seen.has(value.name)) {
      return "unknown";
    }

    return named.type === "document" ? "object" : extractKind(named.value, types, new Set([...seen, value.name]));
  }

  if (value.type === "union") {
    const kinds = new Set(membersOf(value).map((member) => extractKind(member, types, seen)));

    return kinds.size === 1 ? ([...kinds][0] as string) : "unknown";
  }

  return KINDS.has(value.type) ? value.type : "unknown";
}

function extractAttributes(entry: ExtractEntry | ExtractValue | undefined): Record<string, { value?: ExtractValue }> {
  return entry?.attributes ?? {};
}

/** A rule's `[]` steps into an array's members: each may hold the rest of the path. */
const ARRAY_MEMBER = "[]";

/** Where a nameless node's fields, members and marks are declared: on itself, else on the named type it is. */
function deployedNode(node: SchemaField, types: ReadonlyMap<string, SchemaField>): SchemaField {
  let current = node;
  const seen = new Set<string>();

  while (!current.fields && !current.of && current.type && !seen.has(current.type)) {
    const named = types.get(current.type);

    if (!named) {
      break;
    }

    seen.add(current.type);
    current = named;
  }

  return current;
}

// A deployed block lists its inline objects in `of` and its annotations in `marks`, which the stored block holds as these.
const SPAN: SchemaField = { type: "span", fields: [{ name: "text", type: "string" }] };

function deployedPathExists(node: SchemaField, path: readonly string[], types: ReadonlyMap<string, SchemaField>): boolean {
  const [segment, ...rest] = path;

  if (segment === undefined) {
    return true;
  }

  const here = deployedNode(node, types);

  if (segment === ARRAY_MEMBER) {
    return (here.of ?? []).some((member) => deployedPathExists(member, rest, types));
  }

  if (here.type === "block" && segment === "children") {
    return deployedPathExists({ type: "array", of: [SPAN, ...(here.of ?? [])] }, rest, types);
  }

  if (here.type === "block" && segment === "markDefs") {
    return deployedPathExists({ type: "array", of: here.marks?.annotations ?? [] }, rest, types);
  }

  const field = here.fields?.find(({ name }) => name === segment);

  return field ? deployedPathExists(field, rest, types) : false;
}

function membersOf(value: ExtractValue): ExtractValue[] {
  if (Array.isArray(value.of)) {
    return value.of;
  }
  if (value.of) {
    return [value.of];
  }
  return [];
}

/** A named type's own value, followed until it is one: an `inline` points at a type entry, or at a document. */
function extractNode(value: ExtractValue, types: ReadonlyMap<string, ExtractEntry>): ExtractValue | undefined {
  let current: ExtractValue | undefined = value;
  const seen = new Set<string>();

  while (current?.type === "inline" && current.name && !seen.has(current.name)) {
    const named = types.get(current.name);

    seen.add(current.name);
    current = named?.type === "document" ? named : named?.value;
  }

  return current?.type === "inline" ? undefined : current;
}

function localPathExists(
  value: ExtractValue | undefined,
  path: readonly string[],
  types: ReadonlyMap<string, ExtractEntry>
): boolean {
  const here = value ? extractNode(value, types) : undefined;
  const [segment, ...rest] = path;

  if (!here) {
    return false;
  }

  if (segment === undefined) {
    return true;
  }

  if (here.type === "union") {
    return membersOf(here).some((member) => localPathExists(member, path, types));
  }

  if (segment === ARRAY_MEMBER) {
    return here.type === "array" && membersOf(here).some((member) => localPathExists(member, rest, types));
  }

  return localPathExists(here.attributes?.[segment]?.value, rest, types);
}

/** Field names and JSON kinds of every translated type, plus the conditional copy a request opens, against the local extract. */
export function schemaDrift(options: {
  deployed: unknown;
  local: unknown;
  types?: readonly string[];
  conditionalPaths?: Readonly<Record<string, readonly (readonly string[])[]>>;
}): string[] {
  const deployed = (Array.isArray(options.deployed) ? options.deployed : []) as SchemaField[];
  const local = (Array.isArray(options.local) ? options.local : []) as ExtractEntry[];
  const deployedTypes = new Map(deployed.filter(({ name }) => name).map((type) => [type.name as string, type]));
  const localTypes = new Map(local.filter(({ name }) => name).map((type) => [type.name as string, type]));
  const drift: string[] = [];

  for (const type of options.types ?? I18N_DOCUMENT_TYPES) {
    const here = localTypes.get(type);

    if (here?.type !== "document") {
      continue;
    }

    const there = deployedTypes.get(type);

    if (!there) {
      drift.push(`${type}: not in the deployed schema`);
      continue;
    }

    const localFields = Object.entries(extractAttributes(here)).filter(([name]) => !EXTRACT_SYSTEM_FIELDS.has(name));
    const deployedFields = new Map((there.fields ?? []).map((field) => [field.name ?? "", field]));

    for (const [name, attribute] of localFields) {
      const field = deployedFields.get(name);

      if (!field) {
        drift.push(`${type}.${name}: missing from the deployed schema`);
        continue;
      }

      const localKind = extractKind(attribute.value, localTypes);
      const remoteKind = deployedKind(field.type, deployedTypes);

      if (localKind !== "unknown" && remoteKind !== "unknown" && localKind !== remoteKind) {
        drift.push(`${type}.${name}: ${remoteKind} in the deployed schema, ${localKind} here`);
      }
    }

    for (const name of deployedFields.keys()) {
      if (name && !localFields.some(([own]) => own === name)) {
        drift.push(`${type}.${name}: in the deployed schema, removed here`);
      }
    }

    for (const path of (options.conditionalPaths ?? CONDITIONAL_PATHS)[type] ?? []) {
      const [first] = path;
      const reported = first !== undefined && !deployedFields.has(first);

      if (!reported && localPathExists(here, path, localTypes) && !deployedPathExists(there, path, deployedTypes)) {
        drift.push(`${type}.${path.join(".")}: opened by every request, missing from the deployed schema`);
      }
    }
  }

  return [...new Set(drift)].sort();
}

export async function checkDeployedSchema(client: SanityClient, local: unknown): Promise<SchemaCheck> {
  const deployed = await fetchSanity<{ _updatedAt?: string; schema?: unknown } | null>(
    client,
    AiTranslationDeployedSchemaQuery,
    {},
    RAW
  );

  if (!deployed || deployed.schema === undefined || deployed.schema === null) {
    return { deployedAt: null, drift: ["No schema is deployed for Agent Actions."] };
  }

  try {
    const parsed: unknown = typeof deployed.schema === "string" ? JSON.parse(deployed.schema) : deployed.schema;

    return { deployedAt: deployed._updatedAt ?? null, drift: schemaDrift({ deployed: parsed, local }) };
  } catch {
    return { deployedAt: deployed._updatedAt ?? null, drift: ["The deployed schema could not be read."] };
  }
}

let lastPassingCheck: { at: number; check: SchemaCheck } | undefined;

/** The plan reads it fresh; a run of pairs reuses a pass for a minute. Drift is never cached: a deploy clears it at once. */
export async function deployedSchemaCheck(
  client: SanityClient,
  loadLocal: () => Promise<unknown>,
  { fresh = false, now = Date.now() }: { fresh?: boolean; now?: number } = {}
): Promise<SchemaCheck> {
  if (!fresh && lastPassingCheck && now - lastPassingCheck.at < SCHEMA_CHECK_TTL_MS) {
    return lastPassingCheck.check;
  }

  const raw = await loadLocal();
  const check = await checkDeployedSchema(client, typeof raw === "string" ? JSON.parse(raw) : raw);

  lastPassingCheck = check.drift.length === 0 ? { at: now, check } : undefined;

  return check;
}
