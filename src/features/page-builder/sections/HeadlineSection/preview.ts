import type { ComponentProps } from "astro/types";
import { definePreview } from "~/features/page-builder/section-preview";
import type Headline from "./Headline.astro";

// A screen tall, and the default frame is the capture's screen: a taller frame would only push the read off centre.
export const preview = definePreview<ComponentProps<typeof Headline>>({
  props: { headline: "A statement the page\nreads word by word" },
});
