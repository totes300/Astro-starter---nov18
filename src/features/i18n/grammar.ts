// Plural and list rules the dictionaries share. Its own module, so a dictionary never imports the registry
// in `strings.ts` that imports the dictionary.

/** `1 article`, `2 articles`: the noun by the language's own plural rules, so French reads `0 article`. */
export function counted(language: string, one: string, other: string): (count: number) => string {
  const rules = new Intl.PluralRules(language);

  return (count) => `${count} ${rules.select(count) === "one" ? one : other}`;
}

/** `a, b, and c` with the language's own conjunction. Pass the bare id: `en-GB` drops the serial comma. */
export function joinList(language: string, items: readonly string[]): string {
  return new Intl.ListFormat(language, { type: "conjunction" }).format(items);
}
