// Shared by the AI translation tests: three locales passed as arguments, so `sanity/i18n.ts` never decides a result,
// the one Agent Actions tripwire every test client carries, and a mark listed for one suite.

import { after, before } from "node:test";
import { TRANSLATED_MARKS } from "./fields";
import type { TranslationLanguage } from "./style-guide";

export { agentActionTripwire } from "../test-support/agent-actions";

export const TEST_DEFAULT_LOCALE = "en";

export const TEST_LOCALES: readonly TranslationLanguage[] = [
  { id: "en", title: "English" },
  { id: "it", title: "Italiano" },
  { id: "de", title: "Deutsch" },
];

/** Lists `type` in `TRANSLATED_MARKS`, which ships empty, for the tests of the suite that calls this. */
export function listTranslatedMark(type: string): void {
  const marks = TRANSLATED_MARKS as Set<string>;

  before(() => {
    marks.add(type);
  });

  after(() => {
    marks.delete(type);
  });
}
