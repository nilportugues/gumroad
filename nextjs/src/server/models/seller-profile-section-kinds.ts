// The STI subclasses of SellerProfileSection (app/models/seller_profile_*_section.rb) as ProfileSectionsController writes them: each kind's
// json_data keys and the schema in lib/json_schemas/ that validates them.
import type { SellerProfileSection } from "@prisma/client";

import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import { featuredSectionValid, hashOf, productsSectionValid } from "./seller-profile-products-sections.ts";
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

export type SectionKind = { rubyClass: string; keys: readonly string[]; valid: (hash: Hash) => boolean };

const kind = (rubyClass: string, keys: readonly string[], valid: SectionKind["valid"]): [string, SectionKind] => [
  rubyClass,
  { rubyClass, keys, valid },
];

export const SECTION_KINDS: ReadonlyMap<string, SectionKind> = new Map([
  kind(
    "SellerProfileProductsSection",
    ["default_product_sort", "shown_products", "show_filters", "add_new_products"],
    productsSectionValid,
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

function sectionModel(section: SectionKind) {
  return defineModel<SellerProfileSection>({
    rubyClass: section.rubyClass,
    prismaModel: "SellerProfileSection",
    delegate: (tx) => tx.sellerProfileSection as never,
    validations: [
      belongsToRequired<SellerProfileSection>(SELLER),
      {
        name: "validate_json_data",
        run(record) {
          // JSON::Validator's messages are not reproduced.
          if (!section.valid(hashOf(record.get("json_data"))))
            throw new NotPortedError(
              `a ${section.rubyClass} whose json_data breaks its schema`,
              "app/models/seller_profile_section.rb",
            );
        },
      },
    ],
  });
}

export function sectionModelFor(rubyClass: string) {
  const section = SECTION_KINDS.get(rubyClass);
  if (section === undefined)
    throw new NotPortedError(`a ${rubyClass} profile section`, "app/models/seller_profile_section.rb");
  if (!models.has(rubyClass)) models.set(rubyClass, sectionModel(section));
  return models.get(rubyClass)!;
}
