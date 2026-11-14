// Port of InertiaRails::MetaTag / MetaTagBuilder (inertia_rails 3.15.0) and PageMeta::Base, which
// produce the `_inertia_meta` prop the shared MetaTags component renders into <head>.
import { createHash } from "node:crypto";

import { type Attributes, contentTag, escapeHtml, html, SafeString, tagOptions } from "../erb/html.ts";

type TagData = Record<string, unknown>;
export type SerializedMetaTag = Record<string, unknown> & { tagName: string; headKey: string };

const LD_JSON_TYPE = "application/ld+json";
const DEFAULT_SCRIPT_TYPE = "text/plain";
// ActionView::Helpers::TagHelper::TagBuilder::UNARY_TAGS (Rails 8)
const UNARY_TAGS = new Set("area base br col embed hr img input keygen link meta source track wbr".split(" "));
const GENERATABLE_HEAD_KEY_PROPERTIES = ["name", "property", "http_equiv"] as const;

// ActiveSupport's String#parameterize with default options.
export function parameterize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/[^a-zA-Z0-9\-_]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase();
}

const camelizeLower = (key: string) => key.replace(/_([a-z\d])/gu, (_, letter: string) => letter.toUpperCase());

// Ruby's `compact_blank!`: nil, false, and empty strings/arrays/hashes are dropped.
function isBlank(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

export class MetaTag {
  readonly tagName: string;
  readonly headKey: string;
  private readonly tagData: TagData;
  private readonly tagType: unknown;

  constructor({
    tag_name,
    head_key,
    allow_duplicates = false,
    type,
    ...tagData
  }: TagData & { tag_name?: string; head_key?: string; allow_duplicates?: boolean; type?: unknown }) {
    if (tag_name === undefined && Object.keys(tagData).length === 1 && "title" in tagData) {
      this.tagName = "title";
      this.tagData = { inner_content: tagData.title };
    } else {
      this.tagName = tag_name ?? "meta";
      this.tagData = tagData;
    }
    this.tagType = this.tagName === "script" ? (type === LD_JSON_TYPE ? LD_JSON_TYPE : DEFAULT_SCRIPT_TYPE) : type;
    this.headKey = this.tagName === "title" ? "title" : (head_key ?? this.generateHeadKey(allow_duplicates));
  }

  get(key: string): unknown {
    if (key === "tag_name") return this.tagName;
    if (key === "head_key") return this.headKey;
    if (key === "type") return this.tagType;
    return this.tagData[key];
  }

  toJSON(): SerializedMetaTag {
    const result: Record<string, unknown> = { tagName: this.tagName, headKey: this.headKey, type: this.tagType };
    for (const [key, value] of Object.entries(this.tagData)) result[camelizeLower(key)] = value;
    for (const key of Object.keys(result)) if (isBlank(result[key])) delete result[key];
    return result as SerializedMetaTag;
  }

  // InertiaRails::MetaTag#to_tag: the tag as `erb_meta_tags` writes it, tagged with its head key for the client to dedupe by.
  // A string `inner_content` is escaped unless it is a SafeString (the seller's compiled `custom_styles` are html_safe).
  toTag(): SafeString {
    const { inner_content: inner, ...rest } = this.tagData;
    const attributes: Attributes = {};
    for (const [key, value] of Object.entries({ ...rest, type: this.tagType, inertia: this.headKey }))
      attributes[key.replaceAll("_", "-")] = value as Attributes[string];
    if (UNARY_TAGS.has(this.tagName)) return new SafeString(`<${this.tagName} ${tagOptions(attributes)}>`);
    let content: string | SafeString =
      inner === undefined || inner === null ? "" : inner instanceof SafeString ? inner : String(inner);
    if (this.tagName === "script" && inner !== null && typeof inner === "object" && !(inner instanceof SafeString))
      content = new SafeString(
        JSON.stringify(inner).replace(
          /[<>&\u2028\u2029]/gu,
          (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
        ),
      );
    return contentTag(this.tagName, content, attributes);
  }

  private digest(): string {
    // Ruby: tag_data.sort.map { "#{k}=#{v}" }.join("&"), keys being symbols sorted by name.
    const signature = Object.keys(this.tagData)
      .sort()
      .map(
        (key) =>
          `${key}=${this.tagData[key] === null || this.tagData[key] === undefined ? "" : String(this.tagData[key])}`,
      )
      .join("&");
    return createHash("md5").update(signature).digest("hex").slice(0, 8);
  }

  private generateHeadKey(allowDuplicates: boolean): string {
    if (this.tagName === "meta") {
      if ("charset" in this.tagData) return "meta-charset";
      for (const key of GENERATABLE_HEAD_KEY_PROPERTIES) {
        if (!(key in this.tagData)) continue;
        return ["meta", key, parameterize(String(this.tagData[key])), allowDuplicates ? this.digest() : null]
          .filter((part) => part !== null)
          .join("-");
      }
    }
    return `${this.tagName}-${this.digest()}`;
  }
}

// Insertion-ordered by head_key; re-adding a key replaces the tag in place, like a Ruby Hash.
export class MetaTagBuilder {
  private readonly tags = new Map<string, MetaTag>();

  set(options: TagData): this {
    const tag = new MetaTag(options);
    this.tags.set(tag.headKey, tag);
    return this;
  }

  remove(headKey: string): this {
    this.tags.delete(headKey);
    return this;
  }

  find(headKey: string): MetaTag | undefined {
    return this.tags.get(headKey);
  }

  keys(): string[] {
    return [...this.tags.keys()];
  }

  // A before_action declared again in a subclass runs last (Rails drops the earlier declaration), so
  // the tags it sets are created after the ones the callbacks that stayed in place set.
  moveToEnd(headKeys: string[]): this {
    for (const headKey of headKeys) {
      const tag = this.tags.get(headKey);
      if (!tag) continue;
      this.tags.delete(headKey);
      this.tags.set(headKey, tag);
    }
    return this;
  }

  toJSON(): SerializedMetaTag[] {
    return [...this.tags.values()].map((tag) => tag.toJSON());
  }

  // PageMeta::Base#erb_meta_tags
  toErb(): SafeString {
    return new SafeString([...this.tags.values()].map((tag) => html(tag.toTag())).join("\n"));
  }
}

export function defaultPageTitle(railsEnv: string): string {
  if (railsEnv === "production") return "Gumroad";
  if (railsEnv === "staging") return "Staging Gumroad";
  return "Local Gumroad";
}

// PageMeta::Base#page_title
export function pageTitle(meta: MetaTagBuilder, railsEnv: string): string {
  const tag = meta.find("title");
  if (!tag) return defaultPageTitle(railsEnv);
  const inner = tag.get("inner_content");
  const content = tag.get("content");
  if (!isBlank(inner)) return String(inner);
  if (!isBlank(content)) return String(content);
  return defaultPageTitle(railsEnv);
}
