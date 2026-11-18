import { type ArrayRule, defineField, type ObjectFieldProps, type StringRule, type ValidationContext } from "sanity";
import type { LocalizedDocumentType, LocalizedFieldName } from "../../constants";
import { DEFAULT_LOCALE, getStudioLocaleTitle, LOCALES } from "../../i18n";
import { createRichTextField } from "./create-rich-text";

type LocalizedValue = Partial<Record<string, unknown>>;

type LocalizedCheck = (value: LocalizedValue | undefined, context: ValidationContext) => Promise<true | string> | true | string;

type LocalizedFieldOptions<T extends LocalizedDocumentType> = {
  /** `LOCALIZED_FIELDS` must list `name` under it: the language removal reads that list to clean a dropped locale. */
  documentType: T;
  /** The registry path; a nested one (`seoMetadata.title`) defines the field under its last segment. */
  name: LocalizedFieldName<T>;
  title: string;
  description?: string;
  group?: string;
  /** `richText`: one portable text array per locale, stacked, since two columns are too narrow to edit one. */
  type?: "string" | "text" | "richText";
  rows?: number;
  /** Required in the default locale only: another language falls back to it. */
  required?: boolean;
  validate?: LocalizedCheck;
  hidden?: (context: { document?: Record<string, unknown> }) => boolean;
};

/** One locale: the object's header and frame go, so its one input reads as a plain field under the object's title. */
function SingleLocaleField(props: ObjectFieldProps) {
  return props.children;
}

/** A shared document's field translated in place as `{ en, it }`; read in GROQ with `localized()` (or `localizedBlocks()`). */
export function createLocalizedField<T extends LocalizedDocumentType>(options: LocalizedFieldOptions<T>) {
  return localizedFieldFor(options, LOCALES);
}

/** The field for `locales`, so both locale modes are tested whichever one is configured. */
export function localizedFieldFor<T extends LocalizedDocumentType>(
  { name, title, description, group, type = "string", rows, required = false, validate, hidden }: LocalizedFieldOptions<T>,
  locales: readonly { readonly id: string }[]
) {
  const isSingle = locales.length === 1;
  // The pass-through hides the object's own validation markers, so one locale checks on its input instead.
  const inputCheck = isSingle ? validate : undefined;
  const inputRule =
    (isRequired: boolean) =>
    <R extends StringRule | ArrayRule<unknown[]>>(rule: R): R => {
      // Both rule kinds share `required` and `custom`; the union only hides that from TypeScript.
      const base = (isRequired ? rule.required() : rule) as StringRule;

      return (
        inputCheck ? base.custom((_value, context) => inputCheck(context.parent as LocalizedValue | undefined, context)) : base
      ) as R;
    };

  return defineField({
    name: (name as string).split(".").at(-1) as string,
    title,
    description,
    group,
    type: "object",
    ...(hidden ? { hidden } : {}),
    // Side by side from a second locale, so a translation is read against its source; rich text stacks.
    options: { collapsible: false, columns: isSingle || type === "richText" ? 1 : 2 },
    ...(isSingle ? { components: { field: SingleLocaleField } } : {}),
    validation:
      validate && !isSingle
        ? (R) => R.custom((value, context) => validate(value as LocalizedValue | undefined, context))
        : undefined,
    fields: locales.map(({ id }) => {
      const label = isSingle ? { title, description } : { title: getStudioLocaleTitle(id) };
      const rule = inputRule(required && id === DEFAULT_LOCALE);

      if (type === "richText") {
        return createRichTextField({ name: id, ...label, validation: (R) => rule(R) });
      }

      return type === "text"
        ? defineField({ name: id, ...label, type: "text", rows: rows ?? 2, validation: (R) => rule(R) })
        : defineField({ name: id, ...label, type: "string", validation: (R) => rule(R) });
    }),
  });
}
