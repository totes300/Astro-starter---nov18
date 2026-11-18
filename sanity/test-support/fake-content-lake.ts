// A real `@sanity/client` whose requests an in-memory dataset answers, queries through groq-js.
// An Agent Action that reaches it throws the shared tripwire, so a test can never spend AI credits.

import { createClient, type RequestHandler, type RequestHandlerOptions, type SanityClient } from "@sanity/client";
import { evaluate, parse } from "groq-js";
import { agentActionTripwire } from "./agent-actions";

export type FakeDocument = { _id: string; _type: string; _rev?: string; [field: string]: unknown };

type Mutation = Record<string, unknown>;

type FakeContentLake = {
  /** A client with the edit client's settings: no CDN, published perspective, a token. */
  client: SanityClient;
  get(id: string): FakeDocument | undefined;
  documents(): FakeDocument[];
  /** Every mutation batch committed, in order, as the client serialized it. */
  mutations: Mutation[][];
  /** Every Actions API batch committed, in order. */
  actions: Mutation[][];
};

/** The shape `@sanity/client` reads off a failed mutation: a status code on the error. */
function apiError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode, responseBody: JSON.stringify({ error: { description: message } }) });
}

type Segment = string | number | { key: string };

const PATH_TOKEN = /\[_key\s*==\s*["']([^"']*)["']\]|\[(-?\d+)\]|\[["']([^"']*)["']\]|([^.[\]]+)/g;

function parsePath(path: string): Segment[] {
  return [...path.matchAll(PATH_TOKEN)].map(([, key, index, quoted, bare]) => {
    if (key !== undefined) {
      return { key };
    }

    if (index !== undefined) {
      return Number(index);
    }

    return quoted ?? bare ?? "";
  });
}

type Container = Record<string, unknown> | unknown[];

function childOf(container: Container, segment: Segment): unknown {
  if (Array.isArray(container)) {
    return typeof segment === "number"
      ? container[segment]
      : container.find((item) => (item as { _key?: unknown })?._key === (segment as { key: string }).key);
  }

  return typeof segment === "string" ? container[segment] : undefined;
}

function indexOf(array: unknown[], segment: Segment): number {
  if (typeof segment === "number") {
    return segment < 0 ? array.length + segment : segment;
  }

  return array.findIndex((item) => (item as { _key?: unknown })?._key === (segment as { key: string }).key);
}

/** The container holding the path's last segment, creating plain objects on the way when `create` is set. */
function parentOf(document: FakeDocument, segments: Segment[], create: boolean): Container | undefined {
  let current: Container = document;

  for (const segment of segments.slice(0, -1)) {
    let next = childOf(current, segment);

    if ((next === undefined || next === null) && create && typeof segment === "string" && !Array.isArray(current)) {
      next = {};
      current[segment] = next;
    }

    if (typeof next !== "object" || next === null) {
      return undefined;
    }

    current = next as Container;
  }

  return current;
}

function writeAt(document: FakeDocument, path: string, value: unknown, onlyIfMissing: boolean) {
  const segments = parsePath(path);
  const last = segments.at(-1);
  const parent = parentOf(document, segments, true);

  if (!parent || last === undefined) {
    return;
  }

  if (onlyIfMissing && childOf(parent, last) !== undefined) {
    return;
  }

  if (Array.isArray(parent)) {
    const index = indexOf(parent, last);

    if (index >= 0) {
      parent[index] = structuredClone(value);
    }

    return;
  }

  if (typeof last === "string") {
    parent[last] = structuredClone(value);
  }
}

function removeAt(document: FakeDocument, path: string) {
  const segments = parsePath(path);
  const last = segments.at(-1);
  const parent = parentOf(document, segments, false);

  if (!parent || last === undefined) {
    return;
  }

  if (Array.isArray(parent)) {
    const index = indexOf(parent, last);

    if (index >= 0) {
      parent.splice(index, 1);
    }

    return;
  }

  if (typeof last === "string") {
    delete parent[last];
  }
}

const PATCH_OPERATIONS = new Set(["id", "ifRevisionID", "set", "setIfMissing", "unset", "inc", "dec", "insert"]);

/** `{ before | after | replace: "<path to an item>", items }`; an empty array takes the items at either end. */
function insertAt(document: FakeDocument, insert: Record<string, unknown>) {
  const [position, path] = Object.entries(insert).find(([key]) => ["before", "after", "replace"].includes(key)) ?? [];
  const items = structuredClone((insert.items ?? []) as unknown[]);
  const segments = parsePath(String(path ?? ""));
  const last = segments.at(-1);
  const list = parentOf(document, segments, false);

  if (!Array.isArray(list) || last === undefined) {
    throw new Error(`[fake-content-lake] Cannot insert at ${String(path)}: not an array item.`);
  }

  const index = indexOf(list, last);

  if (position === "replace") {
    list.splice(index, 1, ...items);
  } else {
    list.splice(position === "after" ? index + 1 : Math.max(index, 0), 0, ...items);
  }
}

function applyPatch(document: FakeDocument, patch: Record<string, unknown>) {
  const unsupported = Object.keys(patch).filter((operation) => !PATCH_OPERATIONS.has(operation));

  if (unsupported.length > 0) {
    throw new Error(`[fake-content-lake] Unsupported patch operation: ${unsupported.join(", ")}.`);
  }

  for (const [path, value] of Object.entries((patch.setIfMissing ?? {}) as Record<string, unknown>)) {
    writeAt(document, path, value, true);
  }

  for (const [path, value] of Object.entries((patch.set ?? {}) as Record<string, unknown>)) {
    writeAt(document, path, value, false);
  }

  for (const path of (patch.unset ?? []) as string[]) {
    removeAt(document, path);
  }

  for (const [operation, sign] of [
    ["inc", 1],
    ["dec", -1],
  ] as const) {
    for (const [path, amount] of Object.entries((patch[operation] ?? {}) as Record<string, number>)) {
      const segments = parsePath(path);
      const parent = parentOf(document, segments, true);
      const last = segments.at(-1);
      const current = parent && last !== undefined ? childOf(parent, last) : undefined;

      writeAt(document, path, (typeof current === "number" ? current : 0) + sign * amount, false);
    }
  }

  if (patch.insert) {
    insertAt(document, patch.insert as Record<string, unknown>);
  }
}

const isVersioned = (id: string) => id.startsWith("drafts.") || id.startsWith("versions.");

export function createFakeContentLake({ documents = [] as FakeDocument[], dataset = "test" } = {}): FakeContentLake {
  const store = new Map<string, FakeDocument>();
  const mutations: Mutation[][] = [];
  const actions: Mutation[][] = [];
  let revision = 0;

  const stamp = (document: FakeDocument, now: string): FakeDocument => ({
    _createdAt: now,
    ...document,
    _updatedAt: now,
    _rev: `rev-${++revision}`,
  });

  for (const document of documents) {
    store.set(document._id, stamp(structuredClone(document), new Date(0).toISOString()));
  }

  async function query(request: RequestHandlerOptions, url: URL) {
    const body = (request.body ?? {}) as { query?: string; params?: Record<string, unknown> };
    const text = body.query ?? url.searchParams.get("query") ?? "";
    const params: Record<string, unknown> = { ...body.params };

    for (const [name, value] of url.searchParams) {
      if (name.startsWith("$")) {
        params[name.slice(1)] = JSON.parse(value);
      }
    }

    const perspective = url.searchParams.get("perspective") ?? "raw";
    const visible = [...store.values()].filter((document) => perspective === "raw" || !isVersioned(document._id));
    const value = await evaluate(parse(text, { params }), { dataset: structuredClone(visible), params });

    return { result: await value.get(), ms: 0, query: text };
  }

  function mutate(request: RequestHandlerOptions) {
    const batch = ((request.body ?? {}) as { mutations?: Mutation[] }).mutations ?? [];
    const next = new Map(store);
    const now = new Date().toISOString();
    const results: { id: string; operation: string; document?: FakeDocument }[] = [];

    for (const mutation of batch) {
      const [[operation, argument]] = Object.entries(mutation) as [[string, Record<string, unknown>]];
      const id = String(argument.id ?? argument._id ?? "");
      const existing = next.get(id);

      if (operation === "create" && existing) {
        throw apiError(409, `Document by ID "${id}" already exists`);
      }

      if (operation === "create" || operation === "createOrReplace" || (operation === "createIfNotExists" && !existing)) {
        const created = stamp(structuredClone(argument) as FakeDocument, now);

        next.set(id, created);
        results.push({ id, operation: existing ? "update" : "create", document: created });
        continue;
      }

      if (operation === "createIfNotExists") {
        results.push({ id, operation: "none", document: existing });
        continue;
      }

      if (operation === "delete") {
        next.delete(id);
        results.push({ id, operation: "delete" });
        continue;
      }

      if (operation !== "patch") {
        throw new Error(`[fake-content-lake] Unsupported mutation: ${operation}.`);
      }

      if (!existing) {
        throw apiError(409, `Cannot modify document "${id}" because it does not exist`);
      }

      if (typeof argument.ifRevisionID === "string" && argument.ifRevisionID !== existing._rev) {
        throw apiError(
          409,
          `Document "${id}" has unexpected revision ID ("${existing._rev}"), expected "${argument.ifRevisionID}"`
        );
      }

      const patched = structuredClone(existing);

      applyPatch(patched, argument);
      next.set(id, stamp(patched, now));
      results.push({ id, operation: "update", document: next.get(id) });
    }

    store.clear();

    for (const [id, document] of next) {
      store.set(id, document);
    }

    mutations.push(structuredClone(batch));

    return { transactionId: `tx-${revision}`, results: structuredClone(results) };
  }

  function act(request: RequestHandlerOptions) {
    const batch = ((request.body ?? {}) as { actions?: Mutation[] }).actions ?? [];

    for (const action of batch) {
      const { actionType, draftId, publishedId, ifDraftRevisionId, ifPublishedRevisionId } = action as {
        actionType?: string;
        draftId?: string;
        publishedId?: string;
        ifDraftRevisionId?: string;
        ifPublishedRevisionId?: string;
      };
      const draft = draftId ? store.get(draftId) : undefined;

      if (actionType === "sanity.action.document.publish" && draft && typeof ifDraftRevisionId === "string") {
        if (ifDraftRevisionId !== draft._rev) {
          throw apiError(409, `Draft "${draft._id}" is at revision "${draft._rev}", expected "${ifDraftRevisionId}"`);
        }
      }

      if (actionType === "sanity.action.document.publish" && typeof ifPublishedRevisionId === "string") {
        const published = publishedId ? store.get(publishedId) : undefined;

        if (published?._rev !== ifPublishedRevisionId) {
          throw apiError(409, `"${publishedId}" is at revision "${published?._rev}", expected "${ifPublishedRevisionId}"`);
        }
      }

      if (actionType === "sanity.action.document.publish" && draft && publishedId) {
        store.set(publishedId, stamp({ ...structuredClone(draft), _id: publishedId }, new Date().toISOString()));
        store.delete(draft._id);
        continue;
      }

      if (actionType === "sanity.action.document.discard" && draftId) {
        store.delete(draftId);
        continue;
      }

      throw apiError(409, `[fake-content-lake] Cannot apply ${actionType ?? "an action"} here.`);
    }

    actions.push(structuredClone(batch));

    return { transactionId: `tx-${revision}` };
  }

  const answer = async (request: RequestHandlerOptions) => {
    const url = new URL(request.url ?? "", "http://fake.invalid");
    const [, , endpoint, operation] = url.pathname.split("/");

    if (endpoint === "data" && operation === "query") {
      return query(request, url);
    }

    if (endpoint === "data" && operation === "mutate") {
      return mutate(request);
    }

    if (endpoint === "data" && operation === "actions") {
      return act(request);
    }

    throw new Error(`[fake-content-lake] No fake for ${request.method ?? "GET"} ${url.pathname}.`);
  };
  const requestHandler: RequestHandler = (request) => agentActionTripwire(request, answer);

  const client = createClient({
    projectId: "fake",
    dataset,
    apiVersion: "2025-02-19",
    useCdn: false,
    token: "fake-token",
    perspective: "published",
    requestHandler,
  });

  return {
    client,
    get: (id) => (store.has(id) ? structuredClone(store.get(id)) : undefined),
    documents: () => structuredClone([...store.values()]),
    mutations,
    actions,
  };
}
