import type { TranslateCode } from "~/sanity/ai-translation/wire";

const STATUS_BY_CODE: Partial<Record<TranslateCode, number>> = {
  bad_input: 400,
  style_guide_too_long: 400,
  not_a_source: 400,
  source_not_found: 404,
  no_saved_result: 404,
  document_not_found: 404,
  link_not_found: 404,
  missing_language: 409,
  schema_drift: 409,
  wrong_target_language: 409,
  unlinked_translation: 409,
  in_release: 409,
  needs_overwrite: 409,
  link_mismatch: 409,
  link_taken: 409,
  two_groups: 409,
  daily_cap: 429,
  rate_limited: 429,
  budget_exceeded: 429,
  timeout: 504,
  write_failed: 500,
  sanity_unavailable: 503,
};

const DONE = new Set(["translated", "skipped", "busy", "saved_result", "linked", "preview", "discarded"]);

/** 200 for every outcome the run store reads as done; a refusal or a failure keeps its own status, upstream ones 502. */
export function responseStatus(result: { status: string; code?: string }): number {
  if (DONE.has(result.status)) {
    return 200;
  }

  return STATUS_BY_CODE[result.code as TranslateCode] ?? 502;
}
