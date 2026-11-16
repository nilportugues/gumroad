// SellerProfilePostsSection (app/models/seller_profile_posts_section.rb) as SaveInstallmentService writes it: the posts a
// section shows, under `User#with_profile_sections_lock`. Golden: __fixtures__/save-installment.golden.json.
import { Prisma, type SellerProfileSection, type User } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { belongsToRequired, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import { transaction } from "./runtime/transaction.ts";
import { castRow, column, selectRows, table } from "./sql.ts";
import { NotPortedError } from "./user.ts";

const SELLER: BelongsTo = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" };
const POSTS_SECTION = "SellerProfilePostsSection";

// lib/json_schemas/seller_profile_posts_section.json: an object with a `shown_posts` array of unique integers and nothing else.
function shownPostsOf(value: unknown): number[] {
  const hash = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  const listed = (hash as { shown_posts?: unknown } | null)?.shown_posts;
  const posts = Array.isArray(listed) ? listed.map((id) => (typeof id === "bigint" ? Number(id) : id)) : listed;
  const valid =
    hash !== null && typeof hash === "object" && !Array.isArray(hash) && Object.keys(hash).length === 1 && Array.isArray(posts) && posts.every((id) => Number.isInteger(id)) && new Set(posts).size === posts.length;
  // JSON::Validator's messages are not reproduced.
  if (!valid) throw new NotPortedError("a posts section whose json_data breaks its schema", "seller_profile_section.rb");
  return posts as number[];
}

export const SellerProfileSections = defineModel<SellerProfileSection>({
  rubyClass: POSTS_SECTION,
  prismaModel: "SellerProfileSection",
  delegate: (tx) => tx.sellerProfileSection as never,
  validations: [
    belongsToRequired<SellerProfileSection>(SELLER),
    {
      name: "validate_json_data",
      run: (record) => void shownPostsOf(record.get("json_data")),
    },
  ],
});

// `seller.with_profile_sections_lock { seller.seller_profile_posts_sections.reload.each { ... } }` for the post's id:
// shown in the sections whose external ids are listed, hidden from the others.
export async function updateProfilePostsSections(seller: User, postId: number, shownInSections: unknown, now?: () => Date): Promise<void> {
  const [profile] = await selectRows(Prisma.sql`SELECT ${Prisma.raw("`seller_profiles`.*")} FROM ${table("seller_profiles")} WHERE ${column("seller_profiles", "seller_id")} = ${seller.id} LIMIT 1`);
  const run = async () => {
    const rows = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw("`seller_profile_sections`.*")} FROM ${table("seller_profile_sections")} WHERE ${column("seller_profile_sections", "type")} = ${POSTS_SECTION} AND ${column("seller_profile_sections", "seller_id")} = ${seller.id}`,
    );
    for (const row of rows) {
      const section = SellerProfileSections.load(castRow<SellerProfileSection>("SellerProfileSection", row));
      const shown = shownPostsOf(section.get("json_data"));
      if (!Array.isArray(shownInSections)) throw new Error("The parameter passed to #in? must respond to #include?");
      const next = shownInSections.includes(encrypt(section.get("id"))) ? [...new Set([...shown, Number(postId)])] : shown.filter((id) => id !== Number(postId));
      // The column holds JSON text or a parsed object depending on the driver: compare the lists, not the values.
      if (next.length !== shown.length || next.some((id, index) => id !== shown[index])) section.set("json_data", { shown_posts: next });
      await SellerProfileSections.saveBang(section, { now });
    }
  };
  if (!profile) return run();
  // lock_profile_row: SellerProfile.transaction { SellerProfile.lock.find_by!(seller_id:) }
  await transaction(async () => {
    await selectRows(Prisma.sql`SELECT ${Prisma.raw("`seller_profiles`.*")} FROM ${table("seller_profiles")} WHERE ${column("seller_profiles", "seller_id")} = ${seller.id} LIMIT 1 FOR UPDATE`);
    await run();
  });
}
