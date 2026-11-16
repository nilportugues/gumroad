// Port of Installment.emailable_posts_for_purchase (app/models/installment.rb): the published posts a new buyer of a product,
// variant or seller could still be sent, newest first. Golden: worker/jobs/__fixtures__/installment-sends.golden.json.
import { Prisma, type Installment, type Purchase } from "@prisma/client";

import { quote } from "./runtime/quoting.ts";
import { castRow, selectRows } from "./sql.ts";

const SEND_EMAILS_FLAG = 256;
const SINGLE_RECIPIENT_EMAIL_FLAG = 2048;

// `scope :for_products / :for_variants / :for_sellers` + `send_emails.not_single_recipient_email`, as ActiveRecord writes them
function postsOf(recipientType: "product" | "variant" | "seller", target: string): string {
  return [
    "SELECT `installments`.* FROM `installments` WHERE `installments`.`deleted_at` IS NULL AND `installments`.`published_at` IS NOT NULL AND `installments`.`workflow_id` IS NULL",
    `AND \`installments\`.\`installment_type\` = '${recipientType}' AND ${target}`,
    `AND (installments.flags & '${SEND_EMAILS_FLAG}' > 0) AND ((\`installments\`.\`flags\` & ${SINGLE_RECIPIENT_EMAIL_FLAG} = 0))`,
  ].join(" ");
}

// `where(column => ids)`
function inIds(columnSql: string, ids: readonly (number | bigint)[]): string {
  if (ids.length === 0) return "1=0";
  if (ids.length === 1) return `${columnSql} = ${quote(ids[0])}`;
  return `${columnSql} IN (${ids.map(quote).join(", ")})`;
}

export async function emailablePostsForPurchase(purchase: Purchase, variantIds: readonly (number | bigint)[]): Promise<Installment[]> {
  const subqueries = [
    postsOf("product", inIds("`installments`.`link_id`", purchase.link_id === null ? [] : [purchase.link_id])),
    postsOf("variant", inIds("`installments`.`base_variant_id`", variantIds)),
    postsOf("seller", inIds("`installments`.`seller_id`", purchase.seller_id === null ? [] : [purchase.seller_id])),
  ];
  const sql = `SELECT \`installments\`.* FROM (${subqueries.map((query) => `(${query})`).join(" UNION ")}) AS installments ORDER BY \`installments\`.\`published_at\` DESC`;
  return (await selectRows(Prisma.raw(sql))).map((row) => castRow<Installment>("Installment", row));
}
