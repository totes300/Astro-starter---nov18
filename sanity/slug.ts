import * as changeCase from "change-case";

// Latin letters with no combining mark to strip: NFD leaves them whole.
const UNDECOMPOSED_LATIN: Record<string, string> = {
  ß: "ss",
  ẞ: "SS",
  æ: "ae",
  Æ: "AE",
  ø: "o",
  Ø: "O",
  œ: "oe",
  Œ: "OE",
  đ: "d",
  Đ: "D",
  ł: "l",
  Ł: "L",
  þ: "th",
  Þ: "TH",
};

const UNDECOMPOSED_LATIN_PATTERN = new RegExp(`[${Object.keys(UNDECOMPOSED_LATIN).join("")}]`, "gu");

/** Only Latin marks are stripped: in Greek, Cyrillic or kana a mark is part of the letter (`й`, `が`). */
export function foldDiacritics(text: string): string {
  return text
    .normalize("NFD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .replace(UNDECOMPOSED_LATIN_PATTERN, (letter) => UNDECOMPOSED_LATIN[letter] ?? letter);
}

/** Folds after kebab-casing, so a ligature capital (`Æsir`) is not split as a word boundary. */
export function slugifyText(text: string): string {
  return foldDiacritics(changeCase.kebabCase(text));
}

/** Every segment slugified, so the suggestion always passes `uriFormatIssue`. */
export function suggestUri(uri: string): string {
  const segments = uri
    .split("/")
    .map((segment) => slugifyText(segment))
    .filter(Boolean);

  return `/${segments.join("/")}`;
}

// Caseless scripts (CJK) write in `Lo`, and some (Devanagari, Thai) write vowels as marks.
const URI_CHARACTER = /[\p{Ll}\p{Lo}\p{Lm}\p{M}\p{Nd}/-]/u;

/** Routes compare `uri.current` to the request path verbatim, so anything a browser would rewrite never matches. */
export function uriFormatIssue(uri: string): string | undefined {
  const problem = uriFormatProblem(uri);

  return problem ? `${problem} Use "${suggestUri(uri)}".` : undefined;
}

function uriFormatProblem(uri: string): string | undefined {
  if (!uri.startsWith("/")) {
    return 'A URI must start with "/".';
  }

  if (uri.includes("//")) {
    return 'A URI cannot contain "//".';
  }

  if (uri !== "/" && uri.endsWith("/")) {
    return 'A URI cannot end with "/".';
  }

  if (/[\p{Lu}\p{Lt}]/u.test(uri)) {
    return "A URI cannot contain capital letters.";
  }

  const invalid = [...new Set([...uri].filter((character) => !URI_CHARACTER.test(character)))];

  if (invalid.length) {
    return `A URI may only contain lowercase letters, digits, "-" and "/" (found ${invalid.map((character) => JSON.stringify(character)).join(", ")}).`;
  }

  return undefined;
}
