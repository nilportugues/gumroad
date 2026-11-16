// Installment#featured_image_url, #message_snippet and #tags: the readings of a post's HTML the blog
// index shows. Parsed the way Nokogiri::HTML.fragment does (see loofah.ts).
import { squish } from "../search/plaintext.ts";
import { html4Fragment } from "./loofah.ts";
import { allElements, type ElementNode, textContent } from "./libxml2-tree.ts";
import { stripTags } from "./sanitizer.ts";

const SNIPPET_LENGTH = 200;
const OMISSION = "...";
const isElement = (node: { type: string }): node is ElementNode => node.type === "element";

const isBlank = (value: string | null | undefined) => value == null || value.trim() === "";

// String#truncate(length, separator: " ", omission: "..."), counted in characters.
export function truncateAtSeparator(text: string, length: number, separator: string, omission = OMISSION): string {
  const chars = Array.from(text);
  if (chars.length <= length) return text;
  const room = length - Array.from(omission).length;
  // rindex(separator, room): the last separator that starts at or before `room`.
  let stop = room;
  for (let i = Math.min(room, chars.length - 1); i >= 0; i--) {
    if (chars[i] === separator) {
      stop = i;
      break;
    }
  }
  return `${chars.slice(0, stop).join("")}${omission}`;
}

export function messageSnippet(message: string | null): string {
  if (isBlank(message)) return "";
  // `Hello<br/>World` becomes `Hello World`.
  const spaced = message!.split(/<\/p>|<br\s*\/?>/iu).join(" ");
  return truncateAtSeparator(squish(stripTags(spaced)), SNIPPET_LENGTH, " ");
}

export function featuredImageUrl(message: string | null): string | null {
  if (isBlank(message)) return null;
  const first = html4Fragment(message!).children.find(isElement);
  if (first?.name !== "figure") return null;
  const image = allElements(first).find((element) => element.name === "img");
  return image?.attributes.find((attribute) => attribute.name === "src")?.value ?? null;
}

const WORD = "[\\p{L}\\p{M}\\p{Nd}\\p{Pc}]";

// ActiveSupport's String#titleize over String#underscore and #humanize, with no custom inflections.
export function titleize(word: string): string {
  const underscored = word
    .replace(/([A-Z\d]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z\d])([A-Z])/gu, "$1_$2")
    .replaceAll("-", "_")
    .toLowerCase();
  let human = underscored.replace(/^_+/u, "").replace(/_id$/u, "").replaceAll("_", " ");
  // Onigmo's \w and \b are Unicode-aware on UTF-8 strings; JavaScript's are ASCII-only.
  human = human.replace(new RegExp(`^${WORD}`, "u"), (match) => match.toUpperCase());
  return human.replace(new RegExp(`(?<!${WORD})(?<!${WORD}['’\`()])[a-z]`, "gu"), (match) => match.toUpperCase());
}

// Installment#normalize_tag
function normalizeTag(raw: string): string {
  const withoutHash = raw.startsWith("#") ? raw.slice(1) : raw;
  return titleize(squish(withoutHash.replace(/([^\p{L}\p{M}\p{Nd} \t\r\n\f\v])/gu, " $1 ")));
}

export function messageTags(message: string | null): string[] {
  if (isBlank(message)) return [];
  const last = html4Fragment(message!).children.filter(isElement).at(-1);
  if (last?.name !== "p") return [];
  const tags = textContent(last).split(/[ \t\n\v\f\r]+/u).filter((tag) => tag !== "");
  if (!tags.every((tag) => tag.startsWith("#"))) return [];
  return [...new Set(tags.map(normalizeTag))];
}
