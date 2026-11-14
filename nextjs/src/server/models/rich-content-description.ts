// The pure half of app/models/rich_content.rb that reads or rewrites a page's description: the file embeds in order, the removal of a file's
// embeds, the license key block, and the blocked link schemes. Golden: __fixtures__/rich-content-description.golden.json
// (scripts/golden/rich-content-description.rb).
//
// Rails runs these on whatever the JSON column holds. A description is only ever written through the schema validation, so a node is a
// hash and its `content`, `marks` and `attrs` have the shapes the schema gives; `isPlainDescription` is the check that a stored value is
// one of those, and a caller that sees anything else hands the request back instead of guessing what Ruby's duck typing would do.
import { decrypt } from "../../lib/obfuscate-ids.ts";

export type DescriptionNode = Record<string, unknown>;

export const FILE_EMBED_NODE_TYPE = "fileEmbed";
export const FILE_EMBED_GROUP_NODE_TYPE = "fileEmbedGroup";
export const LICENSE_KEY_NODE_TYPE = "licenseKey";
const COMMON_CONTAINER_NODE_TYPES = ["orderedList", "bulletList", "listItem", "blockquote"];
const FILE_EMBED_CONTAINER_NODE_TYPES = [FILE_EMBED_GROUP_NODE_TYPE, ...COMMON_CONTAINER_NODE_TYPES];
const BLOCKED_HREF_SCHEMES = ["javascript", "data", "vbscript", "file", "blob"];
const LINK_NODE_TYPES = ["link", "tiptap-link", "button"];
const URL_ATTRS_BY_NODE_TYPE: Record<string, string> = {
  link: "href",
  "tiptap-link": "href",
  button: "href",
  image: "link",
  mediaEmbed: "url",
};
// The WHATWG URL parser strips C0 control characters and spaces, so the pattern has to name them.
// eslint-disable-next-line no-control-regex
const URL_CLEANUP_LEADING_TRAILING = /^[\u0000- ]+|[\u0000- ]+$/gu;
const URL_CLEANUP_TAB_OR_NEWLINE = /[\t\n\r]/gu;

const isObject = (value: unknown): value is DescriptionNode =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// A description every method below reads the way Ruby does: an array of hashes whose `content` is an array of the same, whose `attrs` is a
// hash, whose `marks` are hashes with a string type, and whose embed ids are strings or absent.
export function isPlainDescription(nodes: unknown): nodes is DescriptionNode[] {
  if (!Array.isArray(nodes)) return false;
  return nodes.every((node) => {
    if (!isObject(node)) return false;
    if ("type" in node && typeof node.type !== "string") return false;
    if ("attrs" in node && !isObject(node.attrs)) return false;
    if (isObject(node.attrs) && "id" in node.attrs && node.attrs.id !== null && typeof node.attrs.id !== "string")
      return false;
    if ("content" in node && !isPlainDescription(node.content)) return false;
    if (
      "marks" in node &&
      (!Array.isArray(node.marks) ||
        !node.marks.every(
          (mark) => isObject(mark) && typeof mark.type === "string" && (!("attrs" in mark) || isObject(mark.attrs)),
        ))
    )
      return false;
    return true;
  });
}

// ActiveSupport's `present?` for a string id.
const presentString = (value: unknown): value is string => typeof value === "string" && !/^[\p{Z}\s]*$/u.test(value);

// ObfuscateIds.decrypt(id): the id, 0 for ciphertext that decrypts to non-digits, nil for what is not a ciphertext.
const decryptedId = (value: unknown): number | null => (presentString(value) ? decrypt(value) : null);

function selectFileEmbedIds(node: DescriptionNode): (number | null)[] {
  if (node.type === FILE_EMBED_NODE_TYPE) {
    const attrs = node.attrs;
    return [isObject(attrs) ? decryptedId(attrs.id) : null];
  }
  // Ruby also asks `content.to_s.include?("fileEmbed")`, a shortcut that cannot change the result.
  if (FILE_EMBED_CONTAINER_NODE_TYPES.includes(node.type as string) && Array.isArray(node.content))
    return (node.content as DescriptionNode[]).flatMap(selectFileEmbedIds);
  return [];
}

// RichContent#embedded_product_file_ids_in_order
export function embeddedProductFileIds(nodes: DescriptionNode[]): number[] {
  const ids = nodes.flatMap(selectFileEmbedIds).filter((id): id is number => id !== null);
  return [...new Set(ids)];
}

// RichContent.reject_file_embeds
export function rejectFileEmbeds(nodes: DescriptionNode[], productFileIds: number[]): DescriptionNode[] {
  const kept: DescriptionNode[] = [];
  for (const node of nodes) {
    if (node.type === FILE_EMBED_NODE_TYPE) {
      const attrs = node.attrs;
      const decrypted = isObject(attrs) ? decryptedId(attrs.id) : null;
      if (decrypted !== null && productFileIds.includes(decrypted)) continue;
      kept.push(node);
    } else if (Array.isArray(node.content) && FILE_EMBED_CONTAINER_NODE_TYPES.includes(node.type as string)) {
      const remaining = rejectFileEmbeds(node.content as DescriptionNode[], productFileIds);
      if (node.type === FILE_EMBED_GROUP_NODE_TYPE && remaining.length === 0) continue;
      kept.push({ ...node, content: remaining });
    } else {
      kept.push(node);
    }
  }
  return kept;
}

// RichContent.has_license_key_in?
export function hasLicenseKeyIn(nodes: unknown): boolean {
  if (!Array.isArray(nodes)) return false;
  const contains = (node: DescriptionNode): boolean =>
    node.type === LICENSE_KEY_NODE_TYPE ||
    (COMMON_CONTAINER_NODE_TYPES.includes(node.type as string) &&
      Array.isArray(node.content) &&
      (node.content as DescriptionNode[]).some(contains));
  return (nodes as DescriptionNode[]).some(contains);
}

// RichContent#browser_canonicalized_scheme: the scheme a browser sees after its URL cleanup, lowercased, or null.
export function browserCanonicalizedScheme(href: string): string | null {
  const canonicalized = href.replace(URL_CLEANUP_LEADING_TRAILING, "").replace(URL_CLEANUP_TAB_OR_NEWLINE, "");
  return /^([a-zA-Z][a-zA-Z0-9+.-]*):/u.exec(canonicalized)?.[1]?.toLowerCase() ?? null;
}

// RichContent#collect_blocked_hrefs, then `uniq`: the schemes that are blocked, in the order the walk meets them. A value that is not a
// string prints in Ruby as `[...]`, `{...}`, a number or a keyword, none of which starts with a scheme.
export function blockedHrefSchemes(nodes: DescriptionNode[]): string[] {
  const found: string[] = [];
  const check = (href: unknown) => {
    if (typeof href !== "string") return;
    const scheme = browserCanonicalizedScheme(href);
    if (scheme !== null && BLOCKED_HREF_SCHEMES.includes(scheme)) found.push(scheme);
  };
  const walk = (list: DescriptionNode[]) => {
    for (const node of list) {
      const urlAttr = URL_ATTRS_BY_NODE_TYPE[node.type as string];
      if (urlAttr !== undefined && isObject(node.attrs)) check(node.attrs[urlAttr]);
      for (const mark of (node.marks as DescriptionNode[] | undefined) ?? []) {
        if (LINK_NODE_TYPES.includes(mark.type as string) && isObject(mark.attrs)) check(mark.attrs.href);
      }
      if (Array.isArray(node.content)) walk(node.content as DescriptionNode[]);
    }
  };
  walk(nodes);
  return [...new Set(found)];
}

// Ruby's Hash#== / Array#==: key order does not matter.
export function sameDescription(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, i) => sameDescription(item, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameDescription(a[key], b[key]));
  }
  return false;
}

// ProductBuild#file_embed_node
export function fileEmbedNode(fileExternalId: string, uid: string): DescriptionNode {
  return { type: FILE_EMBED_NODE_TYPE, attrs: { id: fileExternalId, uid } };
}
