import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEdits,
  describeEdit,
  type Edit,
  EditMatchError,
  type FileEdits,
  groupEdits,
  isInScope,
  isSatisfiedWhenAbsent,
  previewEdit,
  resolveEdits,
  spliceOut,
  verifyEdits,
} from "./edits";
import { loadLocaleToggle } from "./locale-toggle";

/** `assert.throws` returns nothing, and these tests assert on the match count the error carries. */
function catchEditError(source: string, edits: Edit[], fileName: string): EditMatchError {
  try {
    applyEdits(source, edits, fileName);
  } catch (error) {
    assert.ok(error instanceof EditMatchError, `expected an EditMatchError, got ${error}`);
    return error;
  }

  throw new assert.AssertionError({ message: "expected applyEdits to throw, but it returned" });
}

const SCHEMA_INDEX = `import { article } from "./documents/article";
import { blog } from "./documents/blog";
import { page } from "./documents/page";
import { sections } from "./page-sections";
// PLOP: Add Import

// All exported schema types will be added to Sanity as first-class citizens.
export const schemaTypes = [
  page,
  blog,
  article,
  // PLOP: Add Export
  ...sections,
];
`;

test("dropImport removes a whole single-specifier import statement", () => {
  const result = applyEdits(SCHEMA_INDEX, [{ kind: "dropImport", id: "article" }], "index.ts");

  assert.ok(!result.includes(`from "./documents/article"`));
  assert.ok(result.includes(`import { blog } from "./documents/blog";`));
});

test("dropImport removes one specifier from a multi-specifier clause and keeps the rest", () => {
  const source = `import { alpha, beta, gamma } from "./x";\n`;

  assert.equal(applyEdits(source, [{ kind: "dropImport", id: "beta" }], "x.ts"), `import { alpha, gamma } from "./x";\n`);
  assert.equal(applyEdits(source, [{ kind: "dropImport", id: "gamma" }], "x.ts"), `import { alpha, beta } from "./x";\n`);
  assert.equal(applyEdits(source, [{ kind: "dropImport", id: "alpha" }], "x.ts"), `import { beta, gamma } from "./x";\n`);
});

test("dropArrayElement removes the element and its trailing comma line", () => {
  const result = applyEdits(SCHEMA_INDEX, [{ kind: "dropArrayElement", arrayName: "schemaTypes", id: "blog" }], "index.ts");

  assert.ok(!/^\s*blog,$/m.test(result));
  assert.ok(result.includes("  page,\n  article,\n"));
});

test("dropArrayElement leaves an identically named import alone", () => {
  const result = applyEdits(SCHEMA_INDEX, [{ kind: "dropArrayElement", arrayName: "schemaTypes", id: "article" }], "index.ts");

  assert.ok(result.includes(`import { article } from "./documents/article";`));
});

const CONSTANTS = `export const SANITY_SINGLETON_BLOG_ID = "blog";

/** Path the blog index is served at. */
export const SANITY_BLOG_INDEX_URI = "/blog";

export const SINGLETON_IDS = {
  site: SANITY_SINGLETON_SITE_ID,
  blog: SANITY_SINGLETON_BLOG_ID,
  // PLOP: Add Singleton ID
} as const;

export const SINGLETON_ROUTES = {
  [SINGLETON_IDS.homepage]: "/",
  [SINGLETON_IDS.blog]: SANITY_BLOG_INDEX_URI,
} as const;
`;

test("dropObjectProperty removes an identifier key from an `as const` object", () => {
  const result = applyEdits(CONSTANTS, [{ kind: "dropObjectProperty", anchor: "SINGLETON_IDS", key: "blog" }], "c.ts");

  assert.ok(!result.includes("  blog: SANITY_SINGLETON_BLOG_ID,"));
  assert.ok(result.includes("  site: SANITY_SINGLETON_SITE_ID,"));
});

test("dropObjectProperty matches a computed member-access key by its property name", () => {
  const result = applyEdits(CONSTANTS, [{ kind: "dropObjectProperty", anchor: "SINGLETON_ROUTES", key: "blog" }], "c.ts");

  assert.ok(!result.includes("SANITY_BLOG_INDEX_URI,"));
  assert.ok(result.includes(`[SINGLETON_IDS.homepage]: "/",`));
});

test("dropVariableStatement takes the JSDoc written above the declaration with it", () => {
  const result = applyEdits(CONSTANTS, [{ kind: "dropVariableStatement", name: "SANITY_BLOG_INDEX_URI" }], "c.ts");

  assert.ok(!result.includes(`export const SANITY_BLOG_INDEX_URI = "/blog";`));
  assert.ok(!result.includes("Path the blog index is served at"));
  assert.ok(result.includes(`export const SANITY_SINGLETON_BLOG_ID = "blog";`));
  // Only the declaration goes; the reference in SINGLETON_ROUTES is a separate edit's job, and
  // leaving it is what makes a half-specified manifest fail typecheck instead of passing quietly.
  assert.ok(result.includes("[SINGLETON_IDS.blog]: SANITY_BLOG_INDEX_URI,"));
});

const STRUCTURE = `export function buildStructure(S) {
  return S.list().items([
    S.listItem().title("Pages").child(S.documentTypeList("page")),

    // Blog: the index singleton plus its articles.
    S.listItem()
      .title("Blog")
      .icon(() => <>📰</>)
      .child(
        S.list()
          .title("Blog")
          .items([S.listItem().title("Articles")])
      ),

    S.divider(),

    S.listItem().title("Settings"),
  ]);
}
`;

test("dropCallInArray deletes the whole balanced chain plus its comment", () => {
  const result = applyEdits(STRUCTURE, [{ kind: "dropCallInArray", anchor: "items", title: "Blog" }], "s.tsx");

  assert.ok(!result.includes("📰"));
  assert.ok(!result.includes("Blog: the index singleton"));
  assert.ok(result.includes(`S.listItem().title("Pages")`));
  assert.ok(result.includes("S.divider(),"));
});

test("dropCallInArray reaches a nested array of the same name", () => {
  const result = applyEdits(STRUCTURE, [{ kind: "dropCallInArray", anchor: "items", title: "Articles" }], "s.tsx");

  assert.ok(!result.includes("Articles"));
  assert.ok(result.includes("📰"));
});

test("dropCallInArray refuses an ambiguous title rather than picking one", () => {
  const ambiguous = `const x = S.list().items([S.listItem().title("Blog"), S.listItem().title("Blog")]);\n`;
  const error = catchEditError(ambiguous, [{ kind: "dropCallInArray", anchor: "items", title: "Blog" }], "s.tsx");

  assert.equal(error.matches, 2);
});

const GROUPED = `const items = [
    S.listItem().title("Pages"),

    S.divider(),

    S.listItem().title("Submissions"),

    S.divider(),

    S.listItem().title("Settings"),
  ];
`;

const countDividers = (source: string) => source.match(/S\.divider\(\)/g)?.length ?? 0;

test("dropCallInArray takes the divider a removed group leaves next to another", () => {
  const result = applyEdits(GROUPED, [{ kind: "dropCallInArray", anchor: "items", title: "Submissions" }], "s.tsx");

  assert.equal(countDividers(result), 1);
  assert.ok(!/\n[ \t]*\n[ \t]*\n/.test(result), "no two blank lines in a row");
  assert.ok(result.includes(`S.listItem().title("Settings")`));
});

test("dropCallInArray takes a divider left first or last", () => {
  const result = applyEdits(GROUPED, [{ kind: "dropCallInArray", anchor: "items", title: "Settings" }], "s.tsx");

  assert.equal(countDividers(result), 1);
  assert.ok(result.trimEnd().endsWith(`S.listItem().title("Submissions"),\n  ];`));
});

test("dropCallInArray leaves the dividers of an array it removes nothing from", () => {
  const source = `const items = [S.divider(), S.divider(), S.listItem().title("Pages")];\nconst other = S.list().items([S.listItem().title("Blog")]);\n`;
  const result = applyEdits(source, [{ kind: "dropCallInArray", anchor: "items", title: "Blog" }], "s.tsx");

  assert.equal(countDividers(result), 2);
});

test("dropStringFromArray removes one tag from a tags array", () => {
  const source = `const x = { tags: [\n  PAGE,\n  "article",\n  "person",\n] };\n`;
  const result = applyEdits(source, [{ kind: "dropStringFromArray", anchor: "tags", value: "article" }], "x.ts");

  assert.ok(!result.includes(`"article"`));
  assert.ok(result.includes(`"person"`));
});

test("dropObjectFromArray removes a reference target by its `type`", () => {
  const source = `const f = { to: [{ type: "page" }, { type: "legalPage" }, { type: "article" }] };\n`;
  const result = applyEdits(source, [{ kind: "dropObjectFromArray", anchor: "to", property: "type", value: "article" }], "f.ts");

  assert.equal(result, `const f = { to: [{ type: "page" }, { type: "legalPage" }] };\n`);
});

test("dropLines removes every matching Markdown line when a count is given", () => {
  const source = "- [A](./a.md)\n- [B](./b.md)\n- [A again](./a.md)\n";
  const result = applyEdits(source, [{ kind: "dropLines", contains: "./a.md", count: 2 }], "README.md");

  assert.equal(result, "- [B](./b.md)\n");
});

test("applyEdits throws when a matcher hits zero times", () => {
  const error = catchEditError(SCHEMA_INDEX, [{ kind: "dropImport", id: "nope" }], "index.ts");

  assert.equal(error.matches, 0);
  assert.match(error.message, /matched 0 times, expected exactly 1 in index\.ts/);
});

test("applyEdits throws when a matcher hits twice", () => {
  const source = `const list = [\n  "dup",\n  "dup",\n];\n`;
  const error = catchEditError(source, [{ kind: "dropStringFromArray", anchor: "list", value: "dup" }], "l.ts");

  assert.equal(error.matches, 2);
});

test("applyEdits writes nothing when any one edit in the batch fails to match", () => {
  const error = catchEditError(
    SCHEMA_INDEX,
    [
      { kind: "dropImport", id: "article" },
      { kind: "dropImport", id: "missing" },
    ],
    "index.ts"
  );

  assert.deepEqual(error.edit, { kind: "dropImport", id: "missing" });
});

test("applyEdits transforms only the frontmatter of a component", () => {
  const source = `---
import MediaSection from "./MediaSection.astro";
import CtaSection from "./CtaSection.astro";

const sections = {
  mediaSectionField: MediaSection,
  ctaSectionField: CtaSection,
};
---

<div class="mediaSectionField">{Astro.props.docId}</div>
`;

  const result = applyEdits(
    source,
    [
      { kind: "dropImport", id: "MediaSection" },
      { kind: "dropObjectProperty", anchor: "sections", key: "mediaSectionField" },
    ],
    "PageSections.astro"
  );

  assert.ok(!result.includes("./MediaSection.astro"));
  assert.ok(!result.includes("mediaSectionField: MediaSection"));
  assert.ok(result.includes(`<div class="mediaSectionField">{Astro.props.docId}</div>`));
  assert.ok(result.includes("ctaSectionField: CtaSection,"));
});

test("verifyEdits reports only the edits that did not match exactly once", () => {
  const unresolved = verifyEdits(
    SCHEMA_INDEX,
    [
      { kind: "dropImport", id: "article" },
      { kind: "dropImport", id: "ghost" },
    ],
    "index.ts"
  );

  assert.equal(unresolved.length, 1);
  assert.deepEqual(unresolved[0]?.edit, { kind: "dropImport", id: "ghost" });
});

test("describeEdit renders every edit kind as one readable line", () => {
  assert.equal(describeEdit({ kind: "dropImport", id: "article" }), "remove the import of `article`");
  assert.equal(
    describeEdit({ kind: "dropArrayElement", arrayName: "schemaTypes", id: "article" }),
    "remove `article` from `schemaTypes`"
  );
  assert.equal(describeEdit({ kind: "dropLines", contains: "./a.md", count: 2 }), 'remove the lines containing "./a.md"');
});

test("replaceText rewrites a GROQ type list in place", () => {
  const source = 'const Q = `*[_type in ["page", "article", "person"]]{ _id }`;\n';
  const result = applyEdits(
    source,
    [{ kind: "replaceText", find: '"page", "article", "person"', with: '"page"', label: "narrow the type list" }],
    "q.ts"
  );

  assert.equal(result, 'const Q = `*[_type in ["page"]]{ _id }`;\n');
});

test("replaceText with an empty replacement deletes the block", () => {
  const source = "keep\nDROP ME\nkeep\n";

  assert.equal(applyEdits(source, [{ kind: "replaceText", find: "DROP ME\n", with: "" }], "x.ts"), "keep\nkeep\n");
});

test("replaceText counts every occurrence, so an under-specified matcher fails", () => {
  const source = "a\na\n";
  const error = catchEditError(source, [{ kind: "replaceText", find: "a\n", with: "" }], "x.ts");

  assert.equal(error.matches, 2);
  assert.equal(applyEdits(source, [{ kind: "replaceText", find: "a\n", with: "", count: 2 }], "x.ts"), "");
});

test("dropCallStatement removes a colocated test block by the name in its title", () => {
  const source = `import { test } from "node:test";

test("blogLd identifies the index", () => {
  assert.ok(true);
});

test("webPageLd stays", () => {
  assert.ok(true);
});
`;

  const result = applyEdits(source, [{ kind: "dropCallStatement", fn: "test", titleContains: "blogLd" }], "s.test.ts");

  assert.ok(!result.includes("blogLd"));
  assert.ok(result.includes(`test("webPageLd stays"`));
});

test("dropCallStatement removes an it block inside a describe whole, its options and closing paren included", () => {
  const source = `describe("actions", () => {
  it("keeps the open-page actions", () => {
    assert.ok(true);
  });

  it("offers Translate with AI", { skip: true }, () => {
    assert.ok({ nested: true });
  });
});
`;

  const result = applyEdits(source, [{ kind: "dropCallStatement", fn: "it", titleContains: "Translate with AI" }], "a.test.ts");

  assert.equal(
    result,
    `describe("actions", () => {
  it("keeps the open-page actions", () => {
    assert.ok(true);
  });

});
`
  );
});

test("spliceOut refuses to merge a replacement with an overlapping deletion", () => {
  assert.throws(
    () =>
      spliceOut("abcdef", [
        { start: 1, end: 4 },
        { start: 2, end: 5, text: "X" },
      ]),
    /Overlapping edits/
  );
});

test("dropFieldByName removes a whole defineField by its name, whatever its body says", () => {
  const source = `const schema = {
  fields: [
    defineField({ name: "title", type: "string" }),
    defineField({
      group: "emailNotifications",
      name: "notify",
      type: "array",
      description: "Anything at all in here, edited freely by the project.",
      of: [defineArrayMember({ type: "string" })],
    }),
    defineField({ name: "body", type: "text" }),
  ],
};
`;

  const result = applyEdits(source, [{ kind: "dropFieldByName", anchor: "fields", name: "notify" }], "s.tsx");

  assert.ok(!result.includes("emailNotifications"));
  assert.ok(!result.includes("edited freely"));
  assert.ok(result.includes(`defineField({ name: "title", type: "string" }),`));
  assert.ok(result.includes(`defineField({ name: "body", type: "text" }),`));
});

test("dropFieldByName ignores a nested field of the same name in another array", () => {
  const source = `const a = { fields: [defineField({ name: "x" })] };\nconst b = { other: [defineField({ name: "x" })] };\n`;
  const result = applyEdits(source, [{ kind: "dropFieldByName", anchor: "fields", name: "x" }], "s.tsx");

  assert.ok(result.includes(`const b = { other: [defineField({ name: "x" })] };`));
});

test("isSatisfiedWhenAbsent separates a name that is simply not there from a span it cannot read", () => {
  // Nothing to remove is the desired end state for anything that names one specific thing.
  assert.ok(isSatisfiedWhenAbsent({ kind: "dropImport", id: "MediaSection" }));
  assert.ok(isSatisfiedWhenAbsent({ kind: "dropArrayElement", arrayName: "sections", id: "mediaSection" }));
  assert.ok(isSatisfiedWhenAbsent({ kind: "dropObjectProperty", anchor: "_sections", key: "mediaSectionField" }));
  assert.ok(isSatisfiedWhenAbsent({ kind: "dropFieldByName", anchor: "fields", name: "notify" }));

  // A span that is not found may be absent, or present in a shape this cannot recognise.
  assert.ok(!isSatisfiedWhenAbsent({ kind: "replaceText", find: "a", with: "b" }));
  assert.ok(!isSatisfiedWhenAbsent({ kind: "dropLines", contains: "x" }));
});

test("replaceText matches across a reflow, because whitespace is not what identifies the span", () => {
  // A project that broke a one-line GROQ type list over several lines changed nothing about what the
  // query means, so the anchor should survive it.
  const reflowed = `const Q = \`*[
    _type in [
      "page",
      "article",
      "person"
    ]
  ]\`;
`;

  const result = applyEdits(reflowed, [{ kind: "replaceText", find: `"article", "person"`, with: `"person"` }], "q.ts");

  assert.ok(!result.includes(`"article"`));
  assert.ok(result.includes(`"person"`));
});

test("replaceText still refuses an anchor that a reflow made ambiguous", () => {
  const source = `const a = ["x", "y"];\nconst b = ["x",\n  "y"];\n`;
  const error = catchEditError(source, [{ kind: "replaceText", find: `"x", "y"`, with: "" }], "s.ts");

  assert.equal(error.matches, 2);
});

test("replaceText treats regex metacharacters in the matcher as literal text", () => {
  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: the `${…}` is the literal text under test.
  const source = "const q = `${TYPE}[0].uri (current)`;\n";
  const result = applyEdits(source, [{ kind: "replaceText", find: "${TYPE}[0].uri (current)", with: "ok" }], "q.ts");
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of the literal fixture.

  assert.equal(result, "const q = `ok`;\n");
});

test("an optional text matcher is satisfied when its span is gone, because its removal was cosmetic", () => {
  // A comment above a branch being removed elsewhere. Rewording it must not stop the trim.
  assert.ok(isSatisfiedWhenAbsent({ kind: "replaceText", find: "// why", with: "", optional: true }));
  assert.ok(isSatisfiedWhenAbsent({ kind: "dropLines", contains: "// why", optional: true }));

  // Optional buys nothing when the anchor is ambiguous rather than missing.
  const source = `const a = ["x", "y"];\nconst b = ["x", "y"];\n`;
  const error = catchEditError(source, [{ kind: "replaceText", find: `"x", "y"`, with: "", optional: true }], "s.ts");

  assert.equal(error.matches, 2);
});

test("dropJsonKey rewrites the document rather than cutting the key's line", () => {
  const source = `{\n  "cta-section": "aaa",\n  "text-section": "bbb"\n}\n`;
  const result = applyEdits(source, [{ kind: "dropJsonKey", key: "text-section" }], "manifest.json");

  // Cutting the last line would have left `"cta-section": "aaa",` holding a trailing comma.
  assert.equal(result, `{\n  "cta-section": "aaa"\n}\n`);
  assert.deepEqual(JSON.parse(result), { "cta-section": "aaa" });
});

test("dropJsonKey composes, so trimming two sections at once still leaves valid JSON", () => {
  const source = `{\n  "a": "1",\n  "b": "2",\n  "c": "3"\n}\n`;
  const result = applyEdits(
    source,
    [
      { kind: "dropJsonKey", key: "b" },
      { kind: "dropJsonKey", key: "c" },
    ],
    "m.json"
  );

  assert.deepEqual(JSON.parse(result), { a: "1" });
});

test("dropJsonKey is satisfied when the key is already absent, like every other structural kind", () => {
  assert.ok(isSatisfiedWhenAbsent({ kind: "dropJsonKey", key: "gone" }));

  const source = `{\n  "a": "1"\n}\n`;

  assert.deepEqual(verifyEdits(source, [{ kind: "dropJsonKey", key: "gone" }], "m.json"), [
    { edit: { kind: "dropJsonKey", key: "gone" }, matches: 0 },
  ]);
});

test("a registry written with `satisfies` is as reachable as one written with `as const`", () => {
  // Both wrap the literal in an expression node; peeling only one made the newer registries invisible.
  const asConst = `const _r = {\n  "a": 1,\n  "b": 2,\n} as const;\n`;
  const satisfies = `const _r = {\n  "a": 1,\n  "b": 2,\n} satisfies Record<string, number>;\n`;
  const drop: Edit[] = [{ kind: "dropObjectProperty", anchor: "_r", key: "a" }];

  for (const source of [asConst, satisfies]) {
    const result = applyEdits(source, drop, "r.ts");

    assert.ok(!result.includes(`"a"`));
    assert.ok(result.includes(`"b"`));
  }
});

test("an import loses its statement when the same batch removes every name it binds", () => {
  // Leaving `import {} from "…"` behind points at a module the same trim has just deleted.
  const source = `import { FEED_MIME, FEED_PATH } from "~/features/feed/constants";\nimport { other } from "./x";\n\nconst a = 1;\n`;
  const drop: Edit[] = [
    { kind: "dropImport", id: "FEED_MIME" },
    { kind: "dropImport", id: "FEED_PATH" },
  ];

  assert.equal(applyEdits(source, drop, "s.ts"), `import { other } from "./x";\n\nconst a = 1;\n`);
});

test("an import keeps its statement when a name it binds survives the batch", () => {
  const source = `import { KEEP, GONE } from "./x";\n\nconst a = 1;\n`;

  assert.equal(applyEdits(source, [{ kind: "dropImport", id: "GONE" }], "s.ts"), `import { KEEP } from "./x";\n\nconst a = 1;\n`);
});

test("dropExport takes one name out of a clause, or the statement when it is the only one", () => {
  const many = `export { KEEP, GONE } from "./x";\n\nconst a = 1;\n`;
  assert.equal(applyEdits(many, [{ kind: "dropExport", id: "GONE" }], "s.ts"), `export { KEEP } from "./x";\n\nconst a = 1;\n`);

  const sole = `export { GONE } from "./x";\n\nconst a = 1;\n`;
  assert.equal(applyEdits(sole, [{ kind: "dropExport", id: "GONE" }], "s.ts"), `\nconst a = 1;\n`);

  // Structural, so a clause reflowed one-per-line is the same anchor.
  const reflowed = `export {\n  KEEP,\n  GONE,\n};\n`;
  assert.ok(!applyEdits(reflowed, [{ kind: "dropExport", id: "GONE" }], "s.ts").includes("GONE"));
});

test("dropUnionMember takes one literal and the bar that joined it, wherever it sits", () => {
  const source = `type MediaType = "image" | "lottie" | "rive";
type Fragment = {
  type?: "lottie" | "image" | null;
};
`;
  const once = applyEdits(source, [{ kind: "dropUnionMember", anchor: "MediaType", value: "lottie" }]);
  const both = applyEdits(once, [{ kind: "dropUnionMember", anchor: "type", value: "lottie" }]);

  assert.equal(
    both,
    `type MediaType = "image" | "rive";
type Fragment = {
  type?: "image" | null;
};
`
  );
});

test("dropSwitchCase removes the clause and its body, and nothing else", () => {
  const source = `function preview(type: string) {
  switch (type) {
    case "image":
      return 1;
    case "lottie": {
      return 2;
    }
    default:
      return 0;
  }
}
`;

  assert.equal(
    applyEdits(source, [{ kind: "dropSwitchCase", value: "lottie" }]),
    `function preview(type: string) {
  switch (type) {
    case "image":
      return 1;
    default:
      return 0;
  }
}
`
  );
});

test("dropFieldByName removes a field that is only spread in behind an option", () => {
  const source = `const fields = [
  defineField({ name: "type" }),
  ...(withLottieOptions
    ? [
        defineField({ name: "lottieOptions" }),
      ]
    : []),
  defineField({ name: "image" }),
];
`;

  assert.equal(
    applyEdits(source, [{ kind: "dropFieldByName", anchor: "fields", name: "lottieOptions" }]),
    `const fields = [
  defineField({ name: "type" }),
  defineField({ name: "image" }),
];
`
  );
});

test("dropExport removes the whole clause once every name in it is dropped by the batch", () => {
  const source = `export { LottieFileInput, RiveFileInput } from "./inputs";
export const kept = 1;
`;

  assert.equal(
    applyEdits(source, [
      { kind: "dropExport", id: "LottieFileInput" },
      { kind: "dropExport", id: "RiveFileInput" },
    ]),
    "export const kept = 1;\n"
  );
});

test("dropStringFromArray takes a count, for a value repeated across a schema's arrays", () => {
  const source = `const a = visibleIfType(["videoMux", "videoFile"]);
const b = visibleIfType(["videoMux", "videoUrl"]);
`;

  assert.equal(
    applyEdits(source, [{ kind: "dropStringFromArray", anchor: "visibleIfType", value: "videoMux", count: 2 }]),
    `const a = visibleIfType(["videoFile"]);
const b = visibleIfType(["videoUrl"]);
`
  );
});

test("dropArrayElement removes a call by the name it is made through, options and all", () => {
  const source = `export default defineConfig({
  plugins: [
    structureTool(),
    muxInput({
      tool: { title: "Mux" },
    }),
    visionTool(),
  ],
});
`;

  assert.equal(
    applyEdits(source, [{ kind: "dropArrayElement", arrayName: "plugins", id: "muxInput" }]),
    `export default defineConfig({
  plugins: [
    structureTool(),
    visionTool(),
  ],
});
`
  );
});

const MEDIA_GROQ = `lottieOptions{
  loop,
},
...select(
  type == "image" => {
    "lottie": null,
    "rive": null,
  },
  type == "lottie" && defined(lottieFile.asset) => {
    "rive": null,
    "lottie": { "url": lottieFile.asset->url, "cover": \${image("cover")} },
  },
  type == "rive" => {
    "lottie": null,
  },
)
`;

test("dropBlock takes a brace-balanced GROQ block by its opener, whatever is inside it", () => {
  const edits: Edit[] = [
    { kind: "dropBlock", opens: "lottieOptions{" },
    { kind: "dropBlock", opens: 'type == "lottie"' },
    { kind: "dropLines", contains: '"lottie": null,', every: true, optional: true },
  ];

  assert.equal(
    applyEdits(MEDIA_GROQ, edits, "fragment.ts"),
    `...select(
  type == "image" => {
    "rive": null,
  },
  type == "rive" => {
  },
)
`
  );
});

test("removals that thin the same padding apply in either order", () => {
  const rive: Edit[] = [
    { kind: "dropBlock", opens: 'type == "rive"' },
    { kind: "dropLines", contains: '"rive": null,', every: true, optional: true },
  ];
  const lottie: Edit[] = [
    { kind: "dropBlock", opens: "lottieOptions{" },
    { kind: "dropBlock", opens: 'type == "lottie"' },
    { kind: "dropLines", contains: '"lottie": null,', every: true, optional: true },
  ];
  const both = applyEdits(MEDIA_GROQ, [...rive, ...lottie], "fragment.ts");

  assert.equal(applyEdits(applyEdits(MEDIA_GROQ, rive, "fragment.ts"), lottie, "fragment.ts"), both);
  assert.equal(applyEdits(applyEdits(MEDIA_GROQ, lottie, "fragment.ts"), rive, "fragment.ts"), both);
  assert.deepEqual(verifyEdits(MEDIA_GROQ, [{ kind: "dropLines", contains: '"rive": null,', every: true }], "fragment.ts"), []);
});

test("dropJsonKey reaches one level down, for a script in package.json", () => {
  const source = `${JSON.stringify({ name: "x", scripts: { dev: "astro dev", "sanity:project-setup": "node setup.ts" } }, null, 2)}\n`;

  assert.deepEqual(
    JSON.parse(applyEdits(source, [{ kind: "dropJsonKey", key: "sanity:project-setup", in: "scripts" }], "package.json")),
    { name: "x", scripts: { dev: "astro dev" } }
  );
});

// `trim:verify` resolves one feature at a time, so only a combined plan can show one group deciding another's fate.
test("groupEdits judges each group's requires before merging, in either order", () => {
  const file = "src/features/agents/llms-txt-resources.ts";
  const source = "- [RSS feed](/feed.xml)\n- [OpenAPI description](/openapi.json)\n- [Sitemap](/sitemap.xml)\n";
  const blog: FileEdits = { file, requires: "src/features/feed", edits: [{ kind: "dropLines", contains: "[RSS feed](" }] };
  const openapi: FileEdits = { file, edits: [{ kind: "dropLines", contains: "[OpenAPI description](" }] };
  const withoutFeed = source.replace("- [RSS feed](/feed.xml)\n", "");

  for (const groups of [
    [blog, openapi],
    [openapi, blog],
  ]) {
    const noFeed = groupEdits(groups, (path) => path === file);
    const resolution = resolveEdits(
      noFeed,
      (path) => path === file,
      () => withoutFeed
    );

    assert.deepEqual(resolution.unresolved, []);
    assert.equal(applyEdits(withoutFeed, resolution.applicable[0].edits, file), "- [Sitemap](/sitemap.xml)\n");

    const [merged] = groupEdits(groups, () => true);

    assert.equal(merged.requires, undefined);
    assert.equal(applyEdits(source, merged.edits, file), "- [Sitemap](/sitemap.xml)\n");
  }
});

const LOCALES_FILE = "sanity/i18n.ts";

const commentOut = (value: string): Edit => ({ kind: "commentOutObjectInArray", anchor: "LOCALES", property: "id", value });

const localesConfig = (entries: string) => `/** The site's locales. */
export const LOCALES = [
${entries}
] as const;

export const DEFAULT_LOCALE = "en";
`;

const BILINGUAL = localesConfig(`  { id: "en", title: "English", region: "GB" },
  { id: "it", title: "Italiano", region: "IT" },
  // { id: "fr", title: "Français", region: "FR" },`);

test("commentOutObjectInArray folds the entry into the commented line and leaves its neighbours alone", () => {
  const result = applyEdits(BILINGUAL, [commentOut("it")], LOCALES_FILE);

  assert.equal(
    result,
    localesConfig(`  { id: "en", title: "English", region: "GB" },
  // { id: "it", title: "Italiano", region: "IT" },
  // { id: "fr", title: "Français", region: "FR" },`)
  );
  assert.equal(describeEdit(commentOut("it")), 'comment out `{ id: "it" }` in `LOCALES` (it stays as a candidate)');
  assert.deepEqual(previewEdit(commentOut("it"), BILINGUAL, LOCALES_FILE), ['// { id: "it", title: "Italiano", region: "IT" },']);
});

test("commentOutObjectInArray collapses a multi-line entry, keys it first and moves a trailing comment above", () => {
  const source = localesConfig(`  { id: "en", title: "English" },
  {
    title:
      "Italiano",
    region: "IT",
    id: "it",
  }, // until the copy is reviewed
  { id: "de", title: "Deutsch" }`);

  assert.equal(
    applyEdits(source, [commentOut("it")], LOCALES_FILE),
    localesConfig(`  { id: "en", title: "English" },
  // until the copy is reviewed
  // { id: "it", title: "Italiano", region: "IT" },
  { id: "de", title: "Deutsch" }`)
  );
});

test("commentOutObjectInArray takes the last entry, which owns no comma", () => {
  const source = localesConfig(`  { id: "en", title: "English" },
  { id: "it", title: "Italiano" }`);

  assert.equal(
    applyEdits(source, [commentOut("it")], LOCALES_FILE),
    localesConfig(`  { id: "en", title: "English" },
  // { id: "it", title: "Italiano" },`)
  );
});

test("commentOutObjectInArray is done once the entry is commented or gone, and only then", () => {
  const commented = applyEdits(BILINGUAL, [commentOut("it")], LOCALES_FILE);
  const missing = localesConfig(`  { id: "en", title: "English" },`);

  for (const source of [commented, missing]) {
    assert.deepEqual(
      verifyEdits(source, [commentOut("it")], LOCALES_FILE).map(({ matches }) => matches),
      [0]
    );
    assert.ok(isSatisfiedWhenAbsent(commentOut("it"), source, LOCALES_FILE));
  }

  // Without the source there is nothing to read, so nothing to call done.
  assert.ok(!isSatisfiedWhenAbsent(commentOut("it")));
  assert.ok(!isSatisfiedWhenAbsent(commentOut("it"), BILINGUAL, LOCALES_FILE));
});

test("commentOutObjectInArray reports a computed list as work for a human, never as done", () => {
  const computed = `const BASE = [{ id: "en" }];
export const LOCALES = [...BASE, { id: "it", title: "Italiano" }] as const;
`;
  const helper = `export const LOCALES = pickLocales(["en", "it"]);
`;

  for (const source of [computed, helper]) {
    const [failure] = verifyEdits(source, [commentOut("it")], LOCALES_FILE);

    assert.equal(failure?.matches, 0);
    assert.match(failure?.reason ?? "", /not one literal array/);
    assert.ok(!isSatisfiedWhenAbsent(commentOut("it"), source, LOCALES_FILE));
  }
});

test("commentOutObjectInArray refuses an entry it cannot fold into a line of its own, and says why", () => {
  const cases: [string, RegExp][] = [
    [`  { id: "en" }, { id: "it", title: "Italiano" },`, /shares a line/],
    [
      `  { id: "en" },
  { id: "it", title: "Italiano" }
  ,{ id: "de" },`,
      /shares a line/,
    ],
    [
      `  { id: "en" },
  { id: "it", /* reviewed */ title: "Italiano" },`,
      /comment or a template literal/,
    ],
    [
      `  { id: "en" },
  {
    id: "it",
    // native review pending
    title: "Italiano",
  },`,
      /comment or a template literal/,
    ],
    [
      `  { id: "en" },
  { id: "it", title: \`Italiano\` },`,
      /comment or a template literal/,
    ],
  ];

  for (const [entries, reason] of cases) {
    const source = localesConfig(entries);
    const [failure] = verifyEdits(source, [commentOut("it")], LOCALES_FILE);

    assert.equal(failure?.matches, 0, entries);
    assert.match(failure?.reason ?? "", reason, entries);
    assert.ok(!isSatisfiedWhenAbsent(commentOut("it"), source, LOCALES_FILE), entries);
  }
});

test("commentOutObjectInArray refuses two active entries with the same value as ambiguous", () => {
  const source = localesConfig(`  { id: "en" },
  { id: "it", title: "Italiano" },
  { id: "it", title: "Italian" },`);

  assert.equal(catchEditError(source, [commentOut("it")], LOCALES_FILE).matches, 2);
});

test("resolveEdits carries the reason for an entry it could not fold", () => {
  const source = localesConfig(`  { id: "en" }, { id: "it" },`);
  const { unresolved, applicable } = resolveEdits(
    [{ file: LOCALES_FILE, edits: [commentOut("it")] }],
    () => true,
    () => source
  );

  assert.deepEqual(applicable, []);
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0]?.reason ?? "", /shares a line/);
});

test("the comment-out is the toggle's: it re-enables to the original entry, and matches the toggle's own output", async (t) => {
  const toggle = await loadLocaleToggle();

  if (!toggle) {
    t.skip("scripts/sanity-migrations/lib/locales.ts is not here");
    return;
  }

  const sources = [
    BILINGUAL,
    localesConfig(`  { id: "en", title: "English" },
  { id: "it", title: "Italiano", region: "IT" }, // reviewed
  { id: "de", title: "Deutsch" },`),
    localesConfig(`  { id: "en", title: "English" },
  {
    region: "IT",
    id: "it",
    title: "Italiano",
  },`),
    localesConfig(`  { id: "en", title: "English" },
  { id: "it", title: "Italiano" }`),
    localesConfig(`  { id: "en" }, { id: "it" },`),
    localesConfig(`  { id: "en" },
  { id: "it", /* x */ title: "Italiano" },`),
    `export const LOCALES = [...BASE, { id: "it" }] as const;
`,
  ];

  for (const source of sources) {
    const toggled = toggle.disableLocales(source, ["en", "de"]);
    const [failure] = verifyEdits(source, [commentOut("it")], LOCALES_FILE);

    if (toggled.refused.length > 0) {
      assert.equal(failure?.matches, 0, source);
      assert.equal(toggled.source, source);
      continue;
    }

    const commented = applyEdits(source, [commentOut("it")], LOCALES_FILE);

    assert.equal(commented, toggled.source, source);
    assert.ok(toggle.listLocales(commented)?.commented.includes("it"), source);
    assert.deepEqual(toggle.enableCommentedLocales(commented, ["it"]).enabled, ["it"]);
    assert.deepEqual(toggle.listLocales(toggle.enableCommentedLocales(commented, ["it"]).source), toggle.listLocales(source));
  }
});

test("the dictionary registry loses its import and its key, inline or one per line", () => {
  const multiline = `import { italian } from "~/features/i18n/dictionaries/it";
import { DEFAULT_LOCALE } from "~/sanity/i18n";

const UI_STRINGS: Record<string, UiStrings> = {
  en,
  it: italian,
};
`;
  const inline = `import { it } from "./dictionaries/it";

const UI_STRINGS: Record<string, UiStrings> = { en, it };
`;

  assert.equal(
    applyEdits(
      multiline,
      [
        { kind: "dropImport", id: "italian" },
        { kind: "dropObjectProperty", anchor: "UI_STRINGS", key: "it" },
      ],
      "strings.ts"
    ),
    `import { DEFAULT_LOCALE } from "~/sanity/i18n";

const UI_STRINGS: Record<string, UiStrings> = {
  en,
};
`
  );
  assert.equal(
    applyEdits(
      inline,
      [
        { kind: "dropImport", id: "it" },
        { kind: "dropObjectProperty", anchor: "UI_STRINGS", key: "it" },
      ],
      "strings.ts"
    ),
    "\nconst UI_STRINGS: Record<string, UiStrings> = { en };\n"
  );
});

test("a group for the old shape of an anchor runs only where the marker of the new shape is absent", () => {
  const file = "query.ts";
  const marker = "sanity/i18n.ts";
  const current: FileEdits = { file, requires: marker, edits: [{ kind: "replaceText", find: "new();", with: "" }] };
  const old: FileEdits = { file, requiresAbsent: marker, edits: [{ kind: "replaceText", find: "old();", with: "" }] };

  assert.ok(isInScope(current, () => true));
  assert.ok(!isInScope(old, () => true));
  assert.ok(isInScope(old, () => false));
  assert.ok(!isInScope(current, () => false));

  for (const [hasMarker, source, expected] of [
    [true, "new();keep();", "keep();"],
    [false, "old();keep();", "keep();"],
  ] as const) {
    const exists = (path: string) => path === file || (hasMarker && path === marker);
    const grouped = groupEdits([current, old], exists);
    const resolution = resolveEdits([current, old], exists, () => source);

    assert.deepEqual(resolution.unresolved, []);
    assert.equal(grouped.length, 1);
    assert.equal(applyEdits(source, grouped[0].edits, file), expected);
  }
});
