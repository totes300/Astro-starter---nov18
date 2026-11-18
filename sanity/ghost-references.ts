// Every reference field into a translated type, and the read that keeps a ghost (a document in a language the
// site no longer serves) out of it. `ghost-references.test.ts` closes the list; the app's ghost guard test watches it.

export type GuardedReference = {
  /** The type declaring the field, or `*` for a field factory any type can carry. */
  owner: string;
  /** From the owner (or, for `*`, from the factory's object); `[]` marks an array member. */
  path: string;
  guardedBy: string;
};

export const GUARDED_REFERENCES: readonly GuardedReference[] = [
  { owner: "*", path: "internal.link", guardedBy: "LinkFn's last override: a ghost target reads as a deleted one" },
  { owner: "article", path: "author", guardedBy: 'select(configuredReference("author") => author->...) on every read' },
  {
    owner: "translation.metadata",
    path: "translations[].value",
    guardedBy: "AlternatesFragment filters the dereferenced translations with ConfiguredLocaleFilter",
  },
];
