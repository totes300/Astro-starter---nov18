import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLabelsPrompt, LABEL_BATCH_SIZE, LABEL_MAX_LENGTH, validateLabelsResult } from "./labels";
import { TEST_LOCALES } from "./test-fixtures";

const [english, ...targets] = TEST_LOCALES as [{ id: string; title: string }, ...{ id: string; title: string }[]];
const labels = [
  { id: "category-publishing", text: "Publishing" },
  { id: "category-content-modelling", text: "Content modelling with Sanity" },
];
const expected = { ids: labels.map(({ id }) => id), languages: targets.map(({ id }) => id) };

describe("buildLabelsPrompt", () => {
  it("asks for JSON at temperature 0, with the exact shape, every language and only the phrases in play", () => {
    const prompt = buildLabelsPrompt({
      labels,
      from: english,
      to: targets,
      styleGuide: "Friendly.",
      protectedPhrases: ["Sanity", "Figma"],
    });

    assert.equal(prompt.format, "json");
    assert.equal(prompt.temperature, 0);
    assert.match(prompt.instruction, /JSON/);
    assert.ok(
      prompt.instruction.includes('{"category-publishing":{"it":"<the name in Italiano>","de":"<the name in Deutsch>"}}'),
      "an example of the exact shape"
    );
    assert.deepEqual(prompt.instructionParams, {
      labels: {
        type: "constant",
        value: '{"category-publishing":"Publishing","category-content-modelling":"Content modelling with Sanity"}',
      },
      from: { type: "constant", value: "English" },
      languages: { type: "constant", value: "it (Italiano), de (Deutsch)" },
      phrases: { type: "constant", value: "Sanity" },
      styleGuide: { type: "constant", value: "Friendly." },
    });
  });

  it("takes 1 to 50 labels and at least one language", () => {
    const many = Array.from({ length: LABEL_BATCH_SIZE + 1 }, (_, index) => ({ id: `c${index}`, text: "Name" }));

    assert.throws(() => buildLabelsPrompt({ labels: [], from: english, to: targets }));
    assert.throws(() => buildLabelsPrompt({ labels: many, from: english, to: targets }));
    assert.throws(() => buildLabelsPrompt({ labels, from: english, to: [] }));
  });
});

describe("validateLabelsResult", () => {
  const good = {
    "category-publishing": { it: "Pubblicazione", de: "Veröffentlichung" },
    "category-content-modelling": { it: " Modellazione dei contenuti con Sanity ", de: "Inhaltsmodellierung mit Sanity" },
  };

  it("accepts exactly the ids and languages asked for, trimmed, from an object or a JSON string", () => {
    for (const result of [good, JSON.stringify(good)]) {
      const check = validateLabelsResult(result, expected);

      assert.equal(check.ok, true);
      assert.deepEqual(check.problems, []);
      assert.equal(check.labels["category-content-modelling"]?.it, "Modellazione dei contenuti con Sanity");
    }
  });

  it("rejects an invented id, a missing one, a missing or extra language, and anything that is not a JSON object", () => {
    const invented = validateLabelsResult({ ...good, "category-other": { it: "Altro", de: "Andere" } }, expected);
    const missing = validateLabelsResult({ "category-publishing": good["category-publishing"] }, expected);
    const noGerman = validateLabelsResult({ ...good, "category-publishing": { it: "Pubblicazione" } }, expected);
    const french = validateLabelsResult(
      { ...good, "category-publishing": { ...good["category-publishing"], fr: "Publication" } },
      expected
    );

    assert.equal(invented.ok, false);
    assert.deepEqual(invented.problems, ["The answer has 1 id(s) that were not asked for."]);
    assert.deepEqual(missing.problems, ['"category-content-modelling" is missing.']);
    assert.deepEqual(noGerman.problems, ['"category-publishing" in de is empty.']);
    assert.deepEqual(french.problems, ['"category-publishing" has 1 language(s) that were not asked for.']);
    assert.deepEqual(Object.keys(noGerman.labels), ["category-content-modelling"], "only fully valid ids are kept");
    assert.equal(validateLabelsResult("not json", expected).ok, false);
    assert.equal(validateLabelsResult(["a"], expected).ok, false);
  });

  it("names each id whose answer failed, so the others can still be written", () => {
    const noGerman = validateLabelsResult({ ...good, "category-publishing": { it: "Pubblicazione" } }, expected);
    const blankGerman = validateLabelsResult({ ...good, "category-publishing": { it: "Pubblicazione", de: " " } }, expected);
    const invented = validateLabelsResult({ ...good, "category-other": { it: "Altro", de: "Andere" } }, expected);

    assert.deepEqual(noGerman.invalid, [], "a language left out was never answered, so it is no failed name");
    assert.deepEqual(noGerman.missing, ["category-publishing"]);
    assert.deepEqual(blankGerman.invalid, ["category-publishing"]);
    assert.deepEqual(blankGerman.missing, []);
    assert.deepEqual(invented.invalid, [], "an id not asked for is a problem, not a failed name");
    assert.deepEqual(Object.keys(invented.labels).sort(), ["category-content-modelling", "category-publishing"]);
  });

  it("tells an id left out from one that failed, and blames no name for an answer that is not an object", () => {
    const dropped = validateLabelsResult({ "category-publishing": good["category-publishing"] }, expected);
    const refused = validateLabelsResult({}, expected);
    const garbled = validateLabelsResult({ ...good, "category-publishing": "Pubblicazione" }, expected);

    assert.deepEqual(dropped.missing, ["category-content-modelling"]);
    assert.deepEqual(dropped.invalid, [], "never answered, so never a failed name");
    assert.deepEqual(refused.missing, expected.ids);
    assert.deepEqual(refused.invalid, []);
    assert.deepEqual(garbled.missing, ["category-publishing"], "not one name per language: asked again");

    for (const answer of ["not json", ["a"], null]) {
      const check = validateLabelsResult(answer, expected);

      assert.deepEqual([check.invalid, check.missing], [[], []], JSON.stringify(answer));
      assert.equal(check.ok, false);
    }
  });

  it("fails every id given another's name while their source names differ, and keeps genuine twins", () => {
    const sources = { "category-publishing": "Publishing", "category-content-modelling": "Content modelling with Sanity" };
    const offers = { it: "Offerte", de: "Angebote" };
    const injected = validateLabelsResult(
      { "category-publishing": offers, "category-content-modelling": offers },
      {
        ...expected,
        sources,
      }
    );
    const oneLanguage = validateLabelsResult(
      { ...good, "category-content-modelling": { ...good["category-content-modelling"], de: " veröffentlichung " } },
      { ...expected, sources }
    );
    const twins = validateLabelsResult(
      { "category-publishing": offers, "category-content-modelling": offers },
      { ...expected, sources: { "category-publishing": "Offers", "category-content-modelling": " offers" } }
    );

    assert.deepEqual(injected.invalid, expected.ids);
    assert.deepEqual(injected.labels, {});
    assert.ok(
      injected.problems.every((problem) => !problem.includes("Offerte")),
      "the model's text never reaches a message"
    );
    assert.deepEqual(oneLanguage.invalid, expected.ids, "one shared language is enough, in any letter case");
    assert.deepEqual(twins.invalid, [], "the same source name may share a translation");
    assert.deepEqual(
      validateLabelsResult({ "category-publishing": offers, "category-content-modelling": offers }, expected).invalid,
      []
    );
  });

  it("rejects markup, line breaks and names over the length cap, without echoing them", () => {
    for (const bad of [
      "<b>Pubblicazione</b>",
      "**Pubblicazione**",
      "[Pubblicazione](https://x)",
      "`code`",
      "Riga\nnuova",
      "x".repeat(LABEL_MAX_LENGTH + 1),
    ]) {
      const check = validateLabelsResult({ ...good, "category-publishing": { it: bad, de: "Veröffentlichung" } }, expected);

      assert.equal(check.ok, false, bad);
      assert.ok(
        check.problems.every((problem) => !problem.includes(bad)),
        "the model's text never reaches a message"
      );
    }
  });
});
