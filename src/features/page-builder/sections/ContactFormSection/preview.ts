import type { ComponentProps } from "astro/types";
import { definePreview } from "~/features/page-builder/section-preview";
import { sampleRichText } from "~/features/page-builder/section-preview-samples";
import type ContactForm from "./ContactForm.astro";

export const preview = definePreview<ComponentProps<typeof ContactForm>>({
  props: {
    eyebrow: "Lorem ipsum",
    headline: "Lorem ipsum dolor sit amet",
    text: sampleRichText(
      "contact-form-text",
      "Lorem ipsum dolor sit amet consectetur. At congue vitae leo et gravida scelerisque at, dapibus lectus aliquam neque diam."
    ),
  },
});
