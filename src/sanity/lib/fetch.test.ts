import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SanityClient } from "@sanity/client";
import { parse } from "groq-js";
import { inventoryQueries } from "~/features/i18n/query-inventory";
import { DEFAULT_LOCALE, LOCALE_IDS } from "~/sanity/i18n";
import { fetchSanity, minifyGroq } from "./fetch";

type FetchCall = { query: string; params: Record<string, unknown>; options: unknown };

/** Records what the seam hands the client, which is what the Content Lake would receive. */
function stubClient(calls: FetchCall[]) {
  return {
    fetch: async (query: string, params: Record<string, unknown>, options: unknown) => {
      calls.push({ query, params, options });
      return null;
    },
  } as unknown as SanityClient;
}

test("fetchSanity binds the default language and every configured locale when the caller passes no params", async () => {
  const calls: FetchCall[] = [];

  await fetchSanity(stubClient(calls), "*[]");

  assert.deepEqual(calls[0]?.params, { language: DEFAULT_LOCALE, locales: LOCALE_IDS });
});

test("fetchSanity keeps the caller's params and options, and never lets them widen the locales", async () => {
  const calls: FetchCall[] = [];
  const signal = AbortSignal.timeout(1000);

  await fetchSanity(stubClient(calls), "*[_id == $id]", { id: "x", locales: ["zz"] }, { signal });

  assert.deepEqual(calls[0]?.params, { id: "x", language: DEFAULT_LOCALE, locales: LOCALE_IDS });
  assert.deepEqual(calls[0]?.options, { signal });
});

test("fetchSanity refuses a language the site does not serve before any request", async () => {
  const calls: FetchCall[] = [];

  assert.throws(() => fetchSanity(stubClient(calls), "*[]", { language: "zz" }), /configured locale/);
  assert.equal(calls.length, 0);
});

test("fetchSanity sends the minified query", async () => {
  const calls: FetchCall[] = [];

  await fetchSanity(stubClient(calls), '*[_type == "page"] // pages only\n{ title }');

  assert.equal(calls[0]?.query, '*[_type=="page"]{title}');
});

describe("minifyGroq", () => {
  it("drops comments and the whitespace no token needs", () => {
    assert.equal(
      minifyGroq(
        '// header\n*[\n  _type == "page" // the pages\n  && defined(uri.current)\n] | order(_createdAt desc) {\n  title\n}'
      ),
      '*[_type=="page"&&defined(uri.current)]|order(_createdAt desc){title}'
    );
  });

  it("keeps a space wherever dropping it would fuse two tokens", () => {
    assert.equal(minifyGroq("$a in $b"), "$a in $b");
    assert.equal(minifyGroq("a - -1"), "a- -1");
    assert.equal(minifyGroq("a * *b"), "a* *b");
    assert.equal(minifyGroq("a = =b, c - >d, e / /f"), "a= =b,c- >d,e/ /f");
    assert.equal(minifyGroq("[0 ... 5]"), "[0 ... 5]");
    assert.equal(minifyGroq("fn frag::link($value) = $value{ ...x }"), "fn frag::link($value)=$value{...x}");
  });

  it("leaves both quote styles verbatim, comment markers, runs of spaces and newlines included", () => {
    const strings = ['"a // not a comment"', "'two  spaces'", '"line\nbreak"', "'https://example.com'"];

    for (const literal of strings) {
      assert.equal(minifyGroq(`*[title == ${literal}]`), `*[title==${literal}]`);
    }
  });

  it("reads an escaped quote or backslash as part of the string", () => {
    const query = String.raw`*[a == "say \"hi\" // x" && b == 'it\'s' && c == "\\" ] // end`;

    assert.equal(minifyGroq(query), String.raw`*[a=="say \"hi\" // x"&&b=='it\'s'&&c=="\\"]`);
  });

  it("drops GROQ's whitespace only: a character it does not read as a space stays where it was", () => {
    assert.equal(minifyGroq("1 // c\r\n +\r\n2"), "1+2");
    assert.equal(minifyGroq("$a in\u0085$b"), "$a in $b");
    assert.equal(minifyGroq("$a   in $b"), "$a in $b");
    assert.equal(minifyGroq("*[a == 1]﻿"), "*[a==1]﻿");
  });

  it("leaves an unterminated string as it is", () => {
    assert.equal(minifyGroq('*[a == "open  // still a string'), '*[a=="open  // still a string');
  });

  it("changes no query's meaning: every query typegen finds parses to the same tree minified", async () => {
    const { queries, errors } = await inventoryQueries();

    assert.deepEqual(errors, []);
    assert.ok(queries.length > 0);

    for (const { name, query } of queries) {
      assert.deepEqual(parse(minifyGroq(query)), parse(query), name);
    }
  });
});

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCANNED_DIRS = ["src", "templates"];
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".astro", ".hbs"];
const SCANNED_ROOT_FILES = ["astro.config.mjs"];

const PROXY_STATE = join("src", "features", "sanity", "proxy-state.ts");
const BUILD_REDIRECTS = { "astro.config.mjs": "the build-time redirects read, pinned by `_id`" };

// Each read shape and the modules allowed to hold it, with why; a test stubs clients, so tests are not scanned.
const SEAMS: { pattern: RegExp; allowed: Record<string, string>; hint: string }[] = [
  {
    pattern: /\.fetch\s*[<(]/,
    allowed: {
      [join("src", "sanity", "lib", "fetch.ts")]: "the seam",
      [join("src", "worker.ts")]: "the front door calling the renderer entrypoint, not a Sanity client",
    },
    hint: "read through `fetchSanity()` or `loadQuery()`",
  },
  {
    pattern: /\.(?:getDocuments?|listen)\s*[<(]/,
    allowed: {},
    hint: "read through `fetchSanity()`, which binds the locale params",
  },
  {
    pattern: /data\/query\//,
    allowed: { [PROXY_STATE]: "binds the locale params on the URL", ...BUILD_REDIRECTS },
    hint: "use `createProxySanityState()`",
  },
  {
    pattern: /\b(?:api|apicdn)\.sanity\.io\b/,
    allowed: {
      [PROXY_STATE]: "binds the locale params on the URL",
      [join("src", "features", "api", "studio-auth.ts")]: "the Access and users APIs, which hold no content",
      [join("src", "lib", "security-headers.ts")]: "CSP origins, never requested",
      ...BUILD_REDIRECTS,
    },
    hint: "read through `fetchSanity()`: a raw request binds no locale params",
  },
  {
    pattern: /type:\s*["']groq["']/,
    allowed: {},
    hint: "an Agent Action's GROQ param reads unbound: fetch through `fetchSanity()` and pass a constant",
  },
];

function scannedFiles(): string[] {
  return [
    ...SCANNED_ROOT_FILES,
    ...SCANNED_DIRS.flatMap((dir) =>
      readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
        .map((file) => join(dir, file))
        .filter((file) => SCANNED_EXTENSIONS.some((extension) => file.endsWith(extension)) && !file.endsWith(".test.ts"))
    ),
  ];
}

test("no module reads Sanity around the seams, where `$language` and `$locales` would go unbound", () => {
  const offences = scannedFiles().flatMap((file) =>
    readFileSync(join(ROOT, file), "utf8")
      .split("\n")
      .flatMap((line, index) => {
        const read = SEAMS.find(({ pattern, allowed }) => pattern.test(line) && !(file in allowed));

        return read ? [`${file}:${index + 1} ${read.hint}`] : [];
      })
  );

  assert.deepEqual(offences, []);
});

test("each allowed module still holds its read, so the scan above is not passing on a moved one", () => {
  for (const { pattern, allowed } of SEAMS) {
    for (const file of Object.keys(allowed)) {
      assert.ok(existsSync(join(ROOT, file)), `${file} is gone: drop it from SEAMS`);
      assert.match(readFileSync(join(ROOT, file), "utf8"), pattern, file);
    }
  }
});
