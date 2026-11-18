// Rides on every published query as an unused GROQ parameter. Sanity's CDN keys on the full URL, so a
// value it has never seen is a guaranteed miss: freshness is this value, never the CDN's own invalidation.

export const CONTENT_VERSION_PARAM = "contentVersion";

/** What a fresh store answers before the first publish has ever bumped it. */
export const INITIAL_CONTENT_VERSION = "0";

export type ContentVersionStore = {
  get(): Promise<string | null>;
  set(version: string): Promise<void>;
};

export type ContentVersion = {
  read(): Promise<string>;
  /** Never joins a read already in flight, which may have started before a bump. */
  readFresh(): Promise<string>;
  /** Rejects when the store does not hand the new value back, so the caller can fail and be retried. */
  bump(): Promise<string>;
};

/** In memory: the store's contract without a database, for tests. */
export function createMemoryVersionStore(): ContentVersionStore {
  let version: string | null = null;

  return {
    get: async () => version,
    set: async (next) => {
      version = next;
    },
  };
}

/** Sortable by time so a value is legible in logs; the suffix separates publishes within one tick. */
export function nextContentVersion(now = Date.now()): string {
  return `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Deduped while in flight within one render, never memoized and never across requests: a Worker cannot wait on I/O
 * another request started, and the runtime cancels a request left waiting on one as hung. `scope` names the render.
 */
export function createContentVersion(
  store: ContentVersionStore,
  scope: () => object | undefined = () => undefined
): ContentVersion {
  const pending = new WeakMap<object, Promise<string>>();

  async function readFresh(): Promise<string> {
    return (await store.get()) ?? INITIAL_CONTENT_VERSION;
  }

  return {
    read() {
      const key = scope();

      if (!key) {
        return readFresh();
      }

      const inFlight = pending.get(key);

      if (inFlight) {
        return inFlight;
      }

      const read = readFresh().finally(() => pending.delete(key));

      pending.set(key, read);

      return read;
    },
    readFresh,
    async bump() {
      const version = nextContentVersion();

      await store.set(version);

      // A store may swallow its own failed write; only reading the value back catches a lost bump.
      if ((await readFresh()) !== version) {
        throw new Error("content version: the store did not keep the bump");
      }

      return version;
    },
  };
}
