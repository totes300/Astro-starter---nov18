// Studio copy is read by editors, who never run a command: every `npm run` it names is a developer's step.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { AGENT_ERROR_MESSAGES } from "./ai-translation/agent-errors";
import { TRANSLATE_MESSAGES } from "./ai-translation/wire";

const ROOT = import.meta.dirname;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return entry.name === "test-support" ? [] : sourceFiles(path);
    }

    const isSource = /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") && entry.name !== "types.ts";

    return isSource ? [path] : [];
  });
}

const COMMENT = /^\s*(\/\/|\/\*|\*)/;

/** Each `npm run` in code (not comments), with the sentence before it on its line. */
function commandMentions(source: string): { line: number; sentence: string }[] {
  return source.split("\n").flatMap((text, index) => {
    if (COMMENT.test(text)) {
      return [];
    }

    return [...text.matchAll(/npm run/g)].map((match) => {
      const before = text.slice(0, match.index);
      const start = Math.max(before.lastIndexOf(". "), before.lastIndexOf('"'), before.lastIndexOf("`"), before.lastIndexOf(">"));

      return { line: index + 1, sentence: before.slice(start + 1) };
    });
  });
}

describe("copy that names a command", () => {
  for (const file of sourceFiles(ROOT)) {
    const mentions = commandMentions(readFileSync(file, "utf8"));

    if (mentions.length === 0) {
      continue;
    }

    it(`asks a developer to run it: ${relative(ROOT, file)}`, () => {
      for (const { line, sentence } of mentions) {
        assert.match(sentence, /ask a developer/i, `line ${line}: "${sentence.trim()} npm run" names no developer`);
      }
    });
  }

  it("never starts a sentence with Run npm, or puts a command after a colon", () => {
    for (const message of [...Object.values(TRANSLATE_MESSAGES), ...Object.values(AGENT_ERROR_MESSAGES)]) {
      assert.doesNotMatch(message, /\bRun npm\b|:\s*npm run/, message);
    }
  });

  it("names the token a developer checks when the server cannot run AI actions", () => {
    assert.match(AGENT_ERROR_MESSAGES.unauthorized, /SANITY_API_EDIT_TOKEN/);
  });
});
