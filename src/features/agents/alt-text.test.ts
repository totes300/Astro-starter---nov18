import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { RequestHandler } from "@sanity/client";
import { FUNCTION_CAP_MS } from "~/lib/function-cap";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS, type Locale } from "~/sanity/i18n";
import { AgentActionTripwireError, agentActionOf } from "~/sanity/test-support/agent-actions";
import { createFakeContentLake } from "~/sanity/test-support/fake-content-lake";
import { AGENT_TIMEOUT_MS, createAgentClient } from "./agent-client";
import {
  type AltTextArms,
  type AltTextPatch,
  altTextArms,
  altTextOutcome,
  altTextPatch,
  altTextWrite,
  buildDescriptionSourceUrl,
  DESCRIBE_RESERVE_MS,
  describeAsset,
  describeBacklog,
  describeLanguages,
  describeTimeout,
  directCredit,
  generateAltText,
  isDescribableAsset,
  isImageAssetId,
  MAX_ALT_TEXT_LENGTH,
  MIN_DESCRIBE_MS,
  missingAltTextLocales,
  normalizeAltText,
  type StoredAltText,
  unclaimedArms,
} from "./alt-text";
import { ASSET_ID, describingLake, imageAsset } from "./alt-text-fixtures";

// Typed as a plain string: with one locale, `LOCALE_IDS` narrows to the default's literal.
const SECONDARY: string = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;

const EVERY_LANGUAGE = Object.fromEntries(LOCALE_IDS.map((locale) => [locale, `A red bicycle (${locale})`]));

describe("normalizeAltText", () => {
  it("keeps a clean description untouched", () => {
    assert.equal(
      normalizeAltText("Sanity Studio showing a nested structure list resolving into a second pane"),
      "Sanity Studio showing a nested structure list resolving into a second pane"
    );
  });

  it("keeps quoted text inside the description", () => {
    assert.equal(
      normalizeAltText("Certificate reading “Site of the Day. Aug 02, 2026”"),
      "Certificate reading “Site of the Day. Aug 02, 2026”"
    );
  });

  it("unwraps a fully quoted line", () => {
    assert.equal(normalizeAltText('"Portrait of a woman carrying a basket"'), "Portrait of a woman carrying a basket");
    assert.equal(normalizeAltText("“Portrait of a woman carrying a basket”"), "Portrait of a woman carrying a basket");
  });

  it("drops openers that only restate the medium", () => {
    assert.equal(normalizeAltText("Image of a red bicycle leaning on a wall"), "A red bicycle leaning on a wall");
    assert.equal(normalizeAltText("This image shows a red bicycle"), "A red bicycle");
  });

  it("keeps openers that carry information", () => {
    assert.equal(normalizeAltText("Film still of a man in a tweed jacket"), "Film still of a man in a tweed jacket");
    assert.equal(normalizeAltText("Screenshot of the awards page"), "Screenshot of the awards page");
  });

  it("takes the first non-empty line and drops the trailing period", () => {
    assert.equal(normalizeAltText("\n  A red bicycle.\n\nLet me know if you want another version."), "A red bicycle");
  });

  it("truncates at a word boundary without leaving punctuation dangling", () => {
    const result = normalizeAltText(`${"word ".repeat(60)}tail`);

    assert.ok(result.length <= MAX_ALT_TEXT_LENGTH);
    assert.ok(!result.endsWith(" "));
    assert.equal(result.slice(-1), "d");
  });

  it("returns an empty string when there is nothing usable", () => {
    assert.equal(normalizeAltText("   \n  "), "");
    assert.equal(normalizeAltText('""'), "");
  });
});

describe("buildDescriptionSourceUrl", () => {
  it("caps the source image so a full-size original never reaches the model", () => {
    const url = new URL(buildDescriptionSourceUrl("https://cdn.sanity.io/images/p/production/abc-3840x2160.png"));

    assert.equal(url.searchParams.get("w"), "1024");
    assert.equal(url.searchParams.get("fit"), "max");
    assert.equal(url.searchParams.get("fm"), "jpg");
  });
});

describe("isDescribableAsset", () => {
  it("accepts raster assets served over https", () => {
    assert.equal(isDescribableAsset({ url: "https://cdn.sanity.io/a.png", extension: "png" }), true);
  });

  it("rejects svgs and assets with no url", () => {
    assert.equal(isDescribableAsset({ url: "https://cdn.sanity.io/a.svg", extension: "svg" }), false);
    assert.equal(isDescribableAsset({ url: "https://cdn.sanity.io/a.svg", extension: "SVG" }), false);
    assert.equal(isDescribableAsset({ url: undefined, extension: "png" }), false);
  });
});

describe("isImageAssetId", () => {
  it("accepts the ids Sanity gives image assets", () => {
    assert.equal(isImageAssetId("image-a3f9c1e2b4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9-3840x2160-png"), true);
    assert.equal(isImageAssetId("image-Tb9Ew8CXIwaY6R1kjMvI0uRR-2000x3000-jpg"), true);
  });

  it("refuses anything else before a read or a patch could use it", () => {
    for (const value of [
      undefined,
      42,
      "",
      "drafts.image-abc-1x1-png",
      "file-abc-pdf",
      "siteSettings",
      "image-abc-1x1-png\n",
      "image-abc-1x1-png*",
      "image-../x-1x1-png",
      `image-${"a".repeat(200)}-1x1-png`,
    ]) {
      assert.equal(isImageAssetId(value), false, JSON.stringify(value));
    }
  });
});

describe("altTextArms", () => {
  it("treats a legacy plain string as the default language's arm", () => {
    assert.deepEqual(altTextArms("A red bicycle"), { [DEFAULT_LOCALE]: "A red bicycle" });
  });

  it("returns nothing for an absent or malformed value", () => {
    for (const value of [null, undefined, {}, ["A red bicycle"]] as StoredAltText[]) {
      assert.deepEqual(altTextArms(value), {}, JSON.stringify(value));
    }
  });

  it("keeps an explicitly empty arm: a decorative image is described, not missing", () => {
    assert.deepEqual(altTextArms({ [DEFAULT_LOCALE]: "" }), { [DEFAULT_LOCALE]: "" });
    assert.equal(missingAltTextLocales({ [DEFAULT_LOCALE]: "" }).includes(DEFAULT_LOCALE), false);
  });

  it("ignores keys that are not configured languages, and arms that are not text", () => {
    assert.deepEqual(altTextArms({ zz: "Una bicicletta", [DEFAULT_LOCALE]: null }), {});
  });
});

describe("missingAltTextLocales", () => {
  it("lists every configured language for a new asset, a cleared field or an empty object", () => {
    for (const value of [null, undefined, {}, { [DEFAULT_LOCALE]: null }]) {
      assert.deepEqual(missingAltTextLocales(value), [...LOCALE_IDS], JSON.stringify(value));
    }
  });

  it("lists nothing for an asset described in every language", () => {
    assert.deepEqual(missingAltTextLocales(EVERY_LANGUAGE), []);
  });

  it("treats a legacy string as covering the default language only", () => {
    assert.deepEqual(
      missingAltTextLocales("A red bicycle"),
      LOCALE_IDS.filter((locale) => locale !== DEFAULT_LOCALE)
    );
  });

  it("lists only the languages added after the asset was described", { skip: !IS_I18N_ENABLED }, () => {
    assert.deepEqual(
      missingAltTextLocales({ [DEFAULT_LOCALE]: "A red bicycle" }),
      LOCALE_IDS.filter((locale) => locale !== DEFAULT_LOCALE)
    );
    assert.deepEqual(
      missingAltTextLocales({ [SECONDARY]: "A red bicycle" }),
      LOCALE_IDS.filter((locale) => locale !== SECONDARY)
    );
  });
});

const OPEN = { deadline: Number.POSITIVE_INFINITY };

/** The request arrives at 0 on the test clock, so it answers by the function cap; descriptions end by `WINDOW`. */
const DEADLINE = FUNCTION_CAP_MS;
const WINDOW = DEADLINE - DESCRIBE_RESERVE_MS;

describe("describeTimeout", () => {
  it("gives a description the time left before the save reserve, capped at the agent timeout", () => {
    assert.equal(describeTimeout(DEADLINE, 0), Math.min(WINDOW, AGENT_TIMEOUT_MS));
    assert.equal(describeTimeout(DEADLINE, 20_000), WINDOW - 20_000);
    assert.equal(describeTimeout(Number.POSITIVE_INFINITY, 0), AGENT_TIMEOUT_MS);
  });

  it("starts nothing with less than the minimum left, so a description never runs into the function cap", () => {
    assert.equal(describeTimeout(DEADLINE, WINDOW - MIN_DESCRIBE_MS), MIN_DESCRIBE_MS);
    assert.equal(describeTimeout(DEADLINE, WINDOW - MIN_DESCRIBE_MS + 1), 0);
    assert.ok(DESCRIBE_RESERVE_MS > 0 && MIN_DESCRIBE_MS > 0);
  });
});

describe("describeLanguages", () => {
  const saving = (log: string[]) => async (locale: Locale) => {
    log.push(`save ${locale}`);
    return true;
  };

  it("describes each language in that language, and saves it before the next one starts", async () => {
    const log: string[] = [];
    const run = await describeLanguages(
      LOCALE_IDS,
      {
        describe: async (locale) => {
          log.push(`describe ${locale}`);
          return `A red bicycle (${locale})`;
        },
        save: saving(log),
      },
      OPEN
    );

    assert.deepEqual(
      log,
      LOCALE_IDS.flatMap((locale) => [`describe ${locale}`, `save ${locale}`])
    );
    assert.deepEqual(run, { written: EVERY_LANGUAGE, described: LOCALE_IDS.length, stopped: false });
  });

  it("leaves out a language that came back empty, and one the save did not write", async () => {
    const empty = await describeLanguages(
      LOCALE_IDS,
      { describe: async (locale) => (locale === DEFAULT_LOCALE ? "" : "Una bicicletta"), save: async () => true },
      OPEN
    );
    const claimed = await describeLanguages(LOCALE_IDS, { describe: async () => "A red bicycle", save: async () => false }, OPEN);

    assert.equal(DEFAULT_LOCALE in empty.written, false);
    assert.deepEqual(claimed.written, {});
    assert.equal(claimed.described, LOCALE_IDS.length);
  });

  it("starts no description once the request is aborted, and keeps the ones already saved", async () => {
    const controller = new AbortController();
    const log: string[] = [];
    const run = await describeLanguages(
      LOCALE_IDS,
      {
        describe: async (locale) => {
          log.push(`describe ${locale}`);
          controller.abort();
          return "A red bicycle";
        },
        save: saving(log),
      },
      { ...OPEN, signal: controller.signal }
    );

    assert.deepEqual(log, [`describe ${LOCALE_IDS[0]}`, `save ${LOCALE_IDS[0]}`]);
    assert.deepEqual(Object.keys(run.written), [LOCALE_IDS[0]]);
    assert.equal(run.stopped, LOCALE_IDS.length > 1);
  });

  it("starts no description without the minimum time left", async () => {
    let clock = 0;
    let started = 0;
    const run = await describeLanguages(
      LOCALE_IDS,
      {
        describe: async () => {
          started += 1;
          clock += WINDOW - MIN_DESCRIBE_MS + 1;
          return "A red bicycle";
        },
        save: async () => true,
      },
      { deadline: DEADLINE, now: () => clock }
    );

    assert.equal(started, 1);
    assert.deepEqual(Object.keys(run.written), [LOCALE_IDS[0]]);
    assert.equal(run.stopped, LOCALE_IDS.length > 1);
  });

  it("ends the run at a description the day's credit limit refused, keeping what it saved", async () => {
    const reason = "Today's limit is reached.";
    const log: string[] = [];
    const run = await describeLanguages(
      [...LOCALE_IDS, ...LOCALE_IDS],
      {
        describe: async (locale) => {
          log.push(`describe ${locale}`);
          return log.length === 1 ? "A red bicycle" : { stop: "daily_cap", reason };
        },
        save: saving(log),
      },
      OPEN
    );

    assert.deepEqual(log, [`describe ${LOCALE_IDS[0]}`, `save ${LOCALE_IDS[0]}`, `describe ${LOCALE_IDS[1] ?? LOCALE_IDS[0]}`]);
    assert.deepEqual(run, {
      written: { [LOCALE_IDS[0] as string]: "A red bicycle" },
      described: 1,
      stopped: true,
      capped: reason,
    });
  });
});

describe("altTextOutcome", () => {
  const run = (written: AltTextArms, described: number, stopped = false) => ({ written, described, stopped });
  const written = { [DEFAULT_LOCALE]: "A red bicycle" };

  it("is described once nothing is owed, and skipped when editors wrote every language meanwhile", () => {
    assert.deepEqual(altTextOutcome(run(written, 1), []), { status: "described" });
    assert.equal(altTextOutcome(run({}, 1), []).status, "skipped");
  });

  it("says the day's credit limit stopped it, failed when nothing was described and partial when some was", () => {
    const capped = { ...run(written, 1, true), capped: "Today's limit is reached." };

    assert.deepEqual(altTextOutcome({ ...capped, written: {}, described: 0 }, [DEFAULT_LOCALE]), {
      status: "failed",
      reason: "Today's limit is reached.",
      code: "daily_cap",
    });
    assert.equal(altTextOutcome(capped, [SECONDARY as Locale]).status, "partial");
    assert.equal(altTextOutcome(capped, [SECONDARY as Locale]).code, "daily_cap");
    assert.deepEqual(altTextOutcome(capped, []), { status: "described" }, "nothing owed: the limit changed nothing");
  });

  it("is partial when the deadline or an abort stopped it, and failed when a description failed", () => {
    assert.equal(altTextOutcome(run(written, 1, true), [SECONDARY as Locale]).status, "partial");
    assert.equal(altTextOutcome(run({}, 0, true), [DEFAULT_LOCALE]).status, "partial");
    assert.deepEqual(altTextOutcome(run(written, 1), [SECONDARY as Locale]), {
      status: "failed",
      reason: "Some languages are still missing alt text.",
    });
    assert.deepEqual(altTextOutcome(run({}, 0), [DEFAULT_LOCALE]), {
      status: "failed",
      reason: "Sanity AI could not describe this image.",
    });
  });
});

describe("describeAsset", () => {
  const options = (clock: { now: number }) => ({
    guidance: "",
    force: false,
    deadline: DEADLINE,
    now: () => clock.now,
  });

  it("saves every missing language, each before the next description starts", async () => {
    const { lake, clock, calls, client } = describingLake([imageAsset()]);

    const result = await describeAsset(client, ASSET_ID, options(clock));

    assert.deepEqual(result, { _id: ASSET_ID, status: "described", altText: EVERY_LANGUAGE[DEFAULT_LOCALE] });
    assert.deepEqual(
      calls.map(({ locale }) => locale),
      [...LOCALE_IDS]
    );
    assert.deepEqual(
      calls.map(({ asset }) => Object.keys(altTextArms(asset))),
      LOCALE_IDS.map((_, index) => LOCALE_IDS.slice(0, index))
    );
    assert.deepEqual(altTextArms(lake.get(ASSET_ID)?.altText as StoredAltText), EVERY_LANGUAGE);
  });

  it("gives each description only the time left before the deadline", async () => {
    const { clock, calls, client } = describingLake([imageAsset()], 1000);

    await describeAsset(client, ASSET_ID, options(clock));

    assert.deepEqual(
      calls.map(({ timeout }) => timeout),
      LOCALE_IDS.map((_, index) => WINDOW - index * 1000)
    );
  });

  it("stops before a language that would not fit, keeping the one it paid for", { skip: !IS_I18N_ENABLED }, async () => {
    const { lake, clock, calls, client } = describingLake([imageAsset()], WINDOW - MIN_DESCRIBE_MS + 1);

    const result = await describeAsset(client, ASSET_ID, options(clock));

    assert.equal(result.status, "partial");
    assert.equal(result.altText, EVERY_LANGUAGE[DEFAULT_LOCALE]);
    assert.equal(calls.length, 1);
    assert.deepEqual(altTextArms(lake.get(ASSET_ID)?.altText as StoredAltText), {
      [DEFAULT_LOCALE]: EVERY_LANGUAGE[DEFAULT_LOCALE],
    });
  });

  it("describes nothing once the deadline is too close, and says so", async () => {
    const { lake, clock, calls, client } = describingLake([imageAsset()]);

    clock.now = WINDOW - MIN_DESCRIBE_MS + 1;

    const result = await describeAsset(client, ASSET_ID, options(clock));

    assert.equal(result.status, "partial");
    assert.equal(result.altText, undefined);
    assert.equal(calls.length, 0);
    assert.equal(lake.get(ASSET_ID)?.altText, undefined);
  });
});

describe("describeBacklog", () => {
  const SECOND_ASSET = "image-def456-10x10-jpg";
  const options = (clock: { now: number }) => ({
    guidance: "",
    force: false,
    deadline: DEADLINE,
    now: () => clock.now,
    limit: 3,
  });

  it("starts no image once too little time is left, and counts it as remaining", async () => {
    const { clock, calls, client } = describingLake([imageAsset(), imageAsset(SECOND_ASSET)]);

    clock.now = WINDOW - MIN_DESCRIBE_MS + 1;

    const batch = await describeBacklog(client, [{ _id: ASSET_ID }, { _id: SECOND_ASSET }], options(clock));

    assert.deepEqual(batch, { results: [], described: 0, remaining: 2 });
    assert.equal(calls.length, 0);
  });

  it("ends the batch at the deadline, counting a partly described image as progress but not as done", async () => {
    const { client, clock } = describingLake([imageAsset(), imageAsset(SECOND_ASSET)], WINDOW - MIN_DESCRIBE_MS + 1);

    const batch = await describeBacklog(client, [{ _id: ASSET_ID }, { _id: SECOND_ASSET }], options(clock));

    assert.deepEqual(
      batch.results.map(({ _id, status }) => [_id, status]),
      [[ASSET_ID, IS_I18N_ENABLED ? "partial" : "described"]]
    );
    assert.equal(batch.described, 1);
    assert.equal(batch.remaining, IS_I18N_ENABLED ? 2 : 1);
  });
});

/** What the Content Lake does with the patch, for the two path shapes it uses: the whole field, or one arm. */
function applied(document: { altText?: StoredAltText }, { operation, fields }: AltTextPatch): StoredAltText {
  let altText = document.altText;

  for (const [path, value] of Object.entries(fields)) {
    const arm = /^altText\['([^']+)'\]$/.exec(path)?.[1];

    if (path === "altText") {
      altText = operation === "set" || altText === undefined ? (value as StoredAltText) : altText;
    } else if (arm && altText && typeof altText === "object" && !Array.isArray(altText)) {
      altText = operation === "set" || altText[arm] === undefined ? { ...altText, [arm]: value } : altText;
    } else {
      throw new Error(`unexpected patch path ${path}`);
    }
  }

  return altText;
}

describe("altTextPatch", () => {
  it("writes only the described arms of a stored object, so another language's text survives", () => {
    assert.deepEqual(altTextPatch({ [DEFAULT_LOCALE]: "Kept", zz: "Kept too" }, { [SECONDARY]: "New" }), {
      operation: "setIfMissing",
      fields: { [`altText['${SECONDARY}']`]: "New" },
    });
  });

  it("never writes a plain string over a stored object, even with one language configured", () => {
    for (const stored of [{}, { [DEFAULT_LOCALE]: "Old" }]) {
      const patch = altTextPatch(stored, { [DEFAULT_LOCALE]: "New" });

      assert.deepEqual(patch.fields, { [`altText['${DEFAULT_LOCALE}']`]: "New" });
      assert.equal("altText" in patch.fields, false);
    }
  });

  it("keeps a plain string plain with one language configured", { skip: IS_I18N_ENABLED }, () => {
    assert.deepEqual(altTextPatch(undefined, { [DEFAULT_LOCALE]: "New" }), {
      operation: "setIfMissing",
      fields: { altText: "New" },
    });
    assert.deepEqual(altTextPatch("Old", { [DEFAULT_LOCALE]: "New" }, true), { operation: "set", fields: { altText: "New" } });
  });

  it("turns a legacy string into the default arm beside the new languages", { skip: !IS_I18N_ENABLED }, () => {
    assert.deepEqual(altTextPatch("Old", { [SECONDARY]: "New" }), {
      operation: "set",
      fields: { altText: { [DEFAULT_LOCALE]: "Old", [SECONDARY]: "New" } },
    });
    assert.deepEqual(altTextPatch(undefined, EVERY_LANGUAGE), { operation: "setIfMissing", fields: { altText: EVERY_LANGUAGE } });
  });

  it("lets a forced run replace the default arm a legacy string held", { skip: !IS_I18N_ENABLED }, () => {
    assert.deepEqual(altTextPatch("Old", EVERY_LANGUAGE, true), { operation: "set", fields: { altText: EVERY_LANGUAGE } });
  });

  it("lets a forced run overwrite the arms it described, and only those", () => {
    const stored = { [DEFAULT_LOCALE]: "Editor", zz: "Kept" };

    assert.deepEqual(applied({ altText: stored }, altTextPatch(stored, { [DEFAULT_LOCALE]: "New" }, true)), {
      [DEFAULT_LOCALE]: "New",
      zz: "Kept",
    });
  });
});

describe("an editor writing while the descriptions run", () => {
  // The route reads the asset, spends seconds per language, then re-reads and patches: an editor can type in between.
  const write = (current: StoredAltText, described: AltTextArms, landed: StoredAltText = current, force = false) => {
    const planned = altTextWrite(current, described, force);

    return planned ? applied({ altText: landed }, planned.patch) : landed;
  };

  it("drops a described arm the editor filled after the first read", () => {
    const owed = unclaimedArms({ [DEFAULT_LOCALE]: "Editor" }, EVERY_LANGUAGE);

    assert.deepEqual(
      Object.keys(owed),
      LOCALE_IDS.filter((locale) => locale !== DEFAULT_LOCALE)
    );
    assert.deepEqual(unclaimedArms("Editor", { [DEFAULT_LOCALE]: "New" }), {});
  });

  it("keeps the editor's text in every language they wrote, on an empty field or an object", () => {
    for (const editor of [{ [DEFAULT_LOCALE]: "Editor" }, { [SECONDARY]: "Editor" }]) {
      const result = write(editor, EVERY_LANGUAGE) as Record<string, unknown>;

      for (const [locale, text] of Object.entries(editor)) {
        assert.equal(result[locale], text, `${JSON.stringify(editor)}: ${locale}`);
      }
    }
  });

  it("adds nothing over text that lands between the re-read and the patch", () => {
    const landed = { [DEFAULT_LOCALE]: "Editor" };

    assert.deepEqual(write(undefined, EVERY_LANGUAGE, landed), landed);
    assert.deepEqual(write({}, { [DEFAULT_LOCALE]: "New" }, landed), landed);
  });

  it("keeps an arm the editor cleared on purpose", () => {
    const cleared = { [DEFAULT_LOCALE]: "" };

    assert.equal((write(cleared, EVERY_LANGUAGE) as Record<string, unknown>)[DEFAULT_LOCALE], "");
  });

  it("writes nothing once editors filled every language, unless forced", () => {
    const editor = Object.fromEntries(LOCALE_IDS.map((locale) => [locale, "Editor"]));

    assert.equal(altTextWrite(editor, EVERY_LANGUAGE, false), null);
    assert.deepEqual(write(editor, EVERY_LANGUAGE, editor, true), EVERY_LANGUAGE);
  });

  it("still fills the languages nobody wrote", { skip: !IS_I18N_ENABLED }, () => {
    assert.deepEqual(write({ [DEFAULT_LOCALE]: "Editor" }, EVERY_LANGUAGE), { ...EVERY_LANGUAGE, [DEFAULT_LOCALE]: "Editor" });
  });
});

describe("generateAltText", () => {
  const props = { imageUrl: "https://cdn.sanity.io/images/p/d/a.jpg" as const, filename: "a.jpg", locale: DEFAULT_LOCALE };

  it("calls Transform through the agent client it is handed", async () => {
    const lake = createFakeContentLake();

    await assert.rejects(generateAltText(createAgentClient(lake.client), props), AgentActionTripwireError);
  });

  it("normalizes what Transform answers", async () => {
    const lake = createFakeContentLake();
    const inner = lake.client.config().requestHandler as RequestHandler;
    const transform: RequestHandler = async (request, next) =>
      agentActionOf(request.url) === "transform" ? { altText: '"Photo of a red bicycle."' } : inner(request, next);

    const text = await generateAltText(createAgentClient(lake.client.withConfig({ requestHandler: transform })), props);

    assert.equal(text, "A red bicycle");
  });
});

describe("directCredit", () => {
  const agentClient = createAgentClient(createFakeContentLake().client);

  it("makes the one call with the time left as its timeout", async () => {
    const timeouts: unknown[] = [];

    const text = await directCredit(
      async (agent) => {
        timeouts.push(agent.config().timeout);

        return "A red bicycle";
      },
      { agentClient, label: "alt text", budget: () => 20_000 }
    );

    assert.equal(text, "A red bicycle");
    assert.deepEqual(timeouts, [20_000]);
  });

  it("starts nothing below the minimum, and leaves a failed language for the next run", async () => {
    const errors = mock.method(console, "error", () => {});

    try {
      let calls = 0;
      const failing = async () => {
        calls += 1;
        throw new Error("Sanity AI is down");
      };

      assert.deepEqual(await directCredit(failing, { agentClient, label: "alt text", budget: () => MIN_DESCRIBE_MS - 1 }), {
        stop: "out_of_time",
      });
      assert.equal(calls, 0);
      assert.equal(await directCredit(failing, { agentClient, label: "alt text", budget: () => MIN_DESCRIBE_MS }), "");
      assert.equal(calls, 1);
      assert.equal(errors.mock.callCount(), 1);
    } finally {
      errors.mock.restore();
    }
  });
});
