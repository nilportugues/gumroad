// The STI subclasses of SellerProfileSection (app/models/seller_profile_*_section.rb) as ProfileSectionsController writes them: each kind's
// json_data keys and the schema in lib/json_schemas/ that validates them.
import type { SellerProfileSection } from "@prisma/client";

import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import {
  featuredSectionValid,
  hashOf,
  PRODUCT_SORTS,
  productsSectionValid,
} from "./seller-profile-products-sections.ts";
import { NotPortedError } from "./user.ts";

const SELLER: BelongsTo = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" };
// SellerProfileRichTextSection#limit_text_size is 500_000 serialized characters; JS counts UTF-16 units, so stop well short of it.
const RICH_TEXT_SAFE_LENGTH = 400_000;

type Hash = ReturnType<typeof hashOf>;

const isInteger = (value: unknown) => typeof value === "bigint" || Number.isInteger(value);
const onlyKey = (hash: Hash, key: string) => Object.keys(hash).length === 1 && key in hash;

const integerListValid = (key: string) => (hash: Hash) => {
  const list = hash[key];
  return (
    onlyKey(hash, key) && Array.isArray(list) && list.every(isInteger) && new Set(list.map(Number)).size === list.length
  );
};

function richTextValid(hash: Hash): boolean {
  const text = hash.text;
  if (!onlyKey(hash, "text") || text === null || typeof text !== "object" || Array.isArray(text)) return false;
  if (JSON.stringify(text).length > RICH_TEXT_SAFE_LENGTH)
    throw new NotPortedError(
      "a rich text section near its size limit",
      "app/models/seller_profile_rich_text_section.rb",
    );
  return true;
}

export type SectionKind = {
  rubyClass: string;
  keys: readonly string[];
  valid: (hash: Hash) => boolean;
  // JSON::Validator's messages for the one schema break a recording proves; null leaves the rest to Rails.
  messages?: (hash: Hash) => string[] | null;
};

const kind = (
  rubyClass: string,
  keys: readonly string[],
  valid: SectionKind["valid"],
  messages?: SectionKind["messages"],
): [string, SectionKind] => [rubyClass, { rubyClass, keys, valid, messages }];

// A non-boolean `show_filters` is the only break proven, and only when every other key is valid or missing. The type error comes
// first (properties are checked before `required`), then one message per missing required key in schema order.
function productsSectionMessages(hash: Hash): string[] | null {
  if (typeof hash.show_filters !== "string") return null;
  const shown = hash.shown_products;
  const checks: [string, boolean][] = [
    ["default_product_sort", PRODUCT_SORTS.includes(hash.default_product_sort as string)],
    [
      "shown_products",
      Array.isArray(shown) && shown.every(isInteger) && new Set(shown.map(Number)).size === shown.length,
    ],
    ["add_new_products", typeof hash.add_new_products === "boolean"],
  ];
  const missing: string[] = [];
  for (const [key, ok] of checks) {
    if (!(key in hash)) missing.push(key);
    else if (!ok) return null;
  }
  return [
    "The property '#/show_filters' of type string did not match the following type: boolean",
    ...missing.map((key) => `The property '#/' did not contain a required property of '${key}'`),
  ];
}

export const SECTION_KINDS: ReadonlyMap<string, SectionKind> = new Map([
  kind(
    "SellerProfileProductsSection",
    ["default_product_sort", "shown_products", "show_filters", "add_new_products"],
    productsSectionValid,
    productsSectionMessages,
  ),
  kind("SellerProfileFeaturedProductSection", ["featured_product_id"], featuredSectionValid),
  kind("SellerProfilePostsSection", ["shown_posts"], integerListValid("shown_posts")),
  kind(
    "SellerProfileSubscribeSection",
    ["button_label"],
    (hash) => onlyKey(hash, "button_label") && typeof hash.button_label === "string",
  ),
  kind("SellerProfileWishlistsSection", ["shown_wishlists"], integerListValid("shown_wishlists")),
  kind("SellerProfileRichTextSection", ["text"], richTextValid),
]);

const models = new Map<string, ReturnType<typeof sectionModel>>();

function sectionModel(section: SectionKind, explainBreaks: boolean) {
  return defineModel<SellerProfileSection>({
    rubyClass: section.rubyClass,
    prismaModel: "SellerProfileSection",
    delegate: (tx) => tx.sellerProfileSection as never,
    validations: [
      belongsToRequired<SellerProfileSection>(SELLER),
      {
        name: "validate_json_data",
        run(record) {
          const hash = hashOf(record.get("json_data"));
          if (section.valid(hash)) return;
          const messages = explainBreaks ? (section.messages?.(hash) ?? null) : null;
          if (messages !== null) {
            for (const message of messages) record.errors.add("base", message);
            return;
          }
          throw new NotPortedError(
            `a ${section.rubyClass} whose json_data breaks its schema`,
            "app/models/seller_profile_section.rb",
          );
        },
      },
    ],
  });
}

// `explainBreaks` turns the schema break `messages` proves into RecordInvalid; the batched profile editor answers a RecordInvalid
// differently from ProfileSectionsController, so it keeps handing the break back.
export function sectionModelFor(rubyClass: string, explainBreaks = false) {
  const section = SECTION_KINDS.get(rubyClass);
  if (section === undefined)
    throw new NotPortedError(`a ${rubyClass} profile section`, "app/models/seller_profile_section.rb");
  const key = `${rubyClass}:${explainBreaks}`;
  if (!models.has(key)) models.set(key, sectionModel(section, explainBreaks));
  return models.get(key)!;
}
