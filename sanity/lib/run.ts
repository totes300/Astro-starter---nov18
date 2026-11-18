/**
 * Runs `fn` at once and returns its result: an inline block of early returns where an expression
 * is needed. The app has the same helper in `~/features/utils/common`; this copy keeps `sanity/`
 * free of the alias.
 */
export function run<T>(fn: () => T): T {
  return fn();
}
