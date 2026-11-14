// Products::WaitlistEmailsController#create (app/controllers/products/waitlist_emails_controller.rb): the Share tab's button that opens
// the email telling a product's waitlist it launched.
//
// Ported: the policy, the 404, the refusals of WaitlistLaunchEmail#blocked_reason and the answer for a product whose draft exists.
// The first press builds the draft under a product row lock, as WaitlistLaunchEmail#find_or_create_email! does.
// Handed to Rails before any write: a marker that is not a number, a seller without a subdomain (Rails raises) and a draft that fails
// validation.
import { Prisma, type Link } from "@prisma/client";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import { RubyHash } from "../models/concerns/psych.ts";
import { rubyJsonGenerate } from "../models/concerns/serialized-columns.ts";
import { InstallmentFlags } from "../models/installment-post.ts";
import { Installments } from "../models/installment-writes.ts";
import { transaction } from "../models/runtime/transaction.ts";
import { column, selectRows, table } from "../models/sql.ts";
import { eligibleToSendEmails, MINIMUM_SALES_CENTS_VALUE } from "../models/user-email-eligibility.ts";
import { isSuspended, Users } from "../models/user.ts";
import { parseJsonData } from "../models/with-filtering.ts";
import { installmentPolicy } from "../policies/installment.ts";
import { longUrl, subdomainWithProtocol } from "../presenters/product.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { sellerJsonAction } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { json, UNPROCESSABLE_ENTITY } from "./seller-json.ts";

// WaitlistLaunchEmail::PRODUCT_KEY
const PRODUCT_KEY = "waitlist_launch_product_id";
const SUSPENDED_REASON = "Your account can't send emails while it's suspended.";
const NAME_MAX_LENGTH = 255;
const OMISSION = "...";
const SALES_REASON = `You can email your waitlist once you've made at least $${MINIMUM_SALES_CENTS_VALUE / 100} in sales and received a payout.`;

// `current_seller.products.visible.find_by(unique_permalink: params[:product_id]) || e404`
async function findProduct(sellerId: bigint, permalink: string | undefined): Promise<{ id: bigint }> {
  const [product] = permalink
    ? await selectRows<{ id: bigint }>(
        Prisma.sql`SELECT ${column("links", "id")} FROM ${table("links")} WHERE ${column("links", "user_id")} = ${sellerId} AND ${column("links", "deleted_at")} IS NULL AND ${column("links", "unique_permalink")} = ${permalink} LIMIT 1`,
      )
    : [];
  if (!product) throw new RoutingError("Not Found");
  return product;
}

// WaitlistLaunchEmail#email: the newest live installment of the seller whose marker (`to_i`) names the product.
export async function launchEmailId(sellerId: bigint, productId: bigint): Promise<bigint | null> {
  const rows = await selectRows<{ id: bigint; json_data: string | null }>(
    Prisma.sql`SELECT ${column("installments", "id")}, ${column("installments", "json_data")} FROM ${table("installments")} WHERE ${column("installments", "seller_id")} = ${sellerId} AND ${column("installments", "deleted_at")} IS NULL AND ${column("installments", "json_data")} LIKE ${`%${PRODUCT_KEY}%`}`,
  );
  let newest: bigint | null = null;
  for (const row of rows) {
    const marker = parseJsonData(row.json_data)[PRODUCT_KEY];
    if (marker === undefined || marker === null) continue;
    if (typeof marker !== "number" && typeof marker !== "bigint")
      throw new HandBackToRails("a launch email marker that is not a number");
    if (BigInt(Math.trunc(Number(marker))) !== productId) continue;
    if (newest === null || row.id > newest) newest = row.id;
  }
  return newest;
}

// ERB::Util.html_escape
const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const htmlEscape = (text: string) => text.replace(/[&<>"']/gu, (char) => HTML_ESCAPES[char]!);

// String#truncate(255), which counts characters and keeps the omission inside the limit.
function truncate(text: string): string {
  const chars = Array.from(text);
  return chars.length <= NAME_MAX_LENGTH ? text : chars.slice(0, NAME_MAX_LENGTH - OMISSION.length).join("") + OMISSION;
}

// `product.with_lock { email || create_email! }`
async function findOrCreateEmail(
  seller: NonNullable<MutationInput["context"]["currentSeller"]>,
  productId: bigint,
): Promise<bigint> {
  return transaction(async () => {
    const [product] = await selectRows<Link>(
      Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "id")} = ${productId} LIMIT 1 FOR UPDATE`,
    );
    if (product === undefined) throw new RoutingError("Not Found");
    const existing = await launchEmailId(seller.id, productId);
    if (existing !== null) return existing;

    if (subdomainWithProtocol(seller) === null)
      throw new HandBackToRails("a seller without a subdomain, whose product url Rails cannot build");
    const permalink = product.unique_permalink;
    const url = htmlEscape(longUrl(product, seller));
    const created = await Installments.create({
      seller_id: Number(seller.id),
      name: truncate(`${product.name} is out now`),
      message: `<p>You asked to hear when ${htmlEscape(product.name ?? "")} launches. It's out now.</p><p><a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a></p>`,
      installment_type: "follower",
      flags: Number(InstallmentFlags.set(0, "send_emails", true)),
      // The filter accessor rewrites json_data wholesale, so the marker follows it.
      json_data: rubyJsonGenerate(
        new RubyHash([
          ["waitlisted_products", [permalink]],
          [PRODUCT_KEY, Number(productId)],
        ]),
      ),
    });
    if (!created.persisted) throw new HandBackToRails("a launch email that fails validation");
    return BigInt(created.get("id"));
  });
}

async function create(input: MutationInput): Promise<ActionResult> {
  return sellerJsonAction(input, installmentPolicy.create, async () => {
    const seller = input.context.currentSeller!;
    const product = await findProduct(seller.id, input.routeParams.product_id);

    if (!(await eligibleToSendEmails(seller))) {
      const error = isSuspended(Users.load(seller)) ? SUSPENDED_REASON : SALES_REASON;
      return json({ success: false, error }, UNPROCESSABLE_ENTITY);
    }

    const id = (await launchEmailId(seller.id, product.id)) ?? (await findOrCreateEmail(seller, product.id));
    return json({ success: true, edit_url: `/emails/${encrypt(id)}/edit` });
  });
}

registerMutations({ method: "POST", pattern: "/products/:product_id/waitlist_email.json", json: true, run: create });
