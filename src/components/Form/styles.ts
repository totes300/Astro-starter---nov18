/** The control's own styling, shared by every field: the shell owns the pill, the control owns the text. */
export const FIELD_CONTROL_CLASS =
  "w-full min-w-0 flex-1 bg-transparent text-body-10 text-ink leading-none outline-none " +
  "placeholder:text-ink-muted disabled:cursor-not-allowed disabled:text-ink-muted";

/** `relative` so the adornment still paints over a control stretched across the box to widen its hit area. */
export const FIELD_ADORNMENT_CLASS = "pointer-events-none relative ml-auto size-16 text-ink-muted";

/** A group's label and every error message: the label size, set in from the pill's curve. */
export const FIELD_CHIP_CLASS = "text-eyebrow";

/** An error under its field, inset to line up with the text inside the pill. */
export const FIELD_ERROR_CLASS = `${FIELD_CHIP_CLASS} px-22 text-danger empty:hidden`;
