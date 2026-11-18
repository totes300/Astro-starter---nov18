// Read off disk: the endpoints import `astro:env`, which only resolves in Vite. Each rule is one a public form endpoint
// must keep, so a new form cannot skip the request guard or the human check.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const API_DIR = path.resolve("src/pages/api");

function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);

    return statSync(file).isDirectory() ? filesIn(file) : [file];
  });
}

const ENDPOINTS = filesIn(API_DIR)
  .filter((file) => /\.ts$/.test(file) && !file.endsWith(".test.ts"))
  .map((file) => ({ path: path.relative(API_DIR, file).replaceAll(path.sep, "/"), text: readFileSync(file, "utf8") }));

const FORM_ENDPOINTS = ENDPOINTS.filter((file) => file.text.includes("readFormPost("));

test("the public form endpoints are the ones the guard knows", () => {
  assert.deepEqual(FORM_ENDPOINTS.map((file) => file.path).sort(), ["contact-form.ts"]);
});

test("no endpoint reads a form body around the request guard", () => {
  const offenders = ENDPOINTS.filter((file) => /\.formData\(\)/.test(file.text)).map((file) => file.path);

  assert.deepEqual(offenders, [], "read a public form's body with readFormPost from ~/features/forms/form-post");
});

test("a form endpoint checks Turnstile, and refuses every post while the secret is unset", () => {
  for (const file of FORM_ENDPOINTS) {
    assert.match(file.text, /verifyTurnstile\(/, file.path);
    assert.match(file.text, /if \(!TURNSTILE_SECRET_KEY\)[\s\S]*?return formUnavailable\(/, file.path);
  }
});

test("a form endpoint answers the guard's refusal, then checks Turnstile before anything is validated or written", () => {
  for (const file of FORM_ENDPOINTS) {
    const guard = file.text.indexOf("readFormPost(context)");
    const answer = file.text.indexOf("if (formData instanceof Response)");
    const human = file.text.indexOf("verifyTurnstile(");
    const firstUse = file.text.search(/\.check\(formData\)|\.create\(/);

    assert.ok(guard !== -1 && answer > guard && human > answer, file.path);
    assert.ok(firstUse === -1 || human < firstUse, `${file.path}: Turnstile runs before the body is used`);
  }
});
