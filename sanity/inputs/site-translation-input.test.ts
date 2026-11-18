// The panel's markup and wiring that a pure rule cannot show: read from its source, since the Studio is not rendered here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const panel = readFileSync(join(import.meta.dirname, "site-translation-input.tsx"), "utf8");
const run = readFileSync(join(import.meta.dirname, "site-translation-run.tsx"), "utf8");

describe("the whole-site panel", () => {
  it("makes the page list the tab panel of the selected filter", () => {
    assert.match(panel, /<Stack id=\{listId\} role="tabpanel" aria-labelledby=\{`\$\{listId\}-\$\{filter\}`\}/);
    assert.match(panel, /<Tab\s[^>]*id=\{`\$\{listId\}-\$\{option\.id\}`\}[^>]*aria-controls=\{listId\}/);
  });

  it("says what its spinner is doing in a live region that stays mounted", () => {
    assert.match(panel, /<SrOnly as="div" aria-live="polite"[^>]*>\s*\{panelBusyCopy\(/);
  });

  it("gives way to the off note through the shared off switch, and offers Try again only when it can help", () => {
    assert.match(panel, /useTranslateSwitchedOff\(\)/);
    assert.match(panel, /showsSwitchedOff\(isOff, run\)/);
    assert.match(panel, /canRetryPlan\(props\.failure\.code\)/);
  });

  it("loads its plan, links, updates links and acts on saved results through the shared layer", () => {
    assert.match(panel, /useTranslationPlan\(PLAN_REQUEST\)/);
    assert.match(panel, /useLinkTranslation\(onChanged\)/);
    assert.match(panel, /<LinkTranslationControl/);
    assert.doesNotMatch(panel, /linkConfirmCopy\(/, "the link confirm comes from the control the dialog shares");
    assert.match(panel, /useUpdateLinks\(reload\)/);
    assert.match(run, /useSavedResultActions\(props\.onChanged\)/);
    assert.match(run, /<SavedResultControls/);
    assert.match(run, /applyWarning\(row, item\.language, \{ forced: saved\.needsOverwrite\.has\(key\) \}\)/);
  });

  it("publishes the AI drafts the plan lists, not a run's", () => {
    assert.match(run, /draftsToPublish\(response\)/);
    assert.doesNotMatch(run, /draftsToPublish\(run\)|summary\.drafts/);
  });
});
