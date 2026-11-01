// An Installment as a post that is being sent: the row, its associations (each loaded once, as
// ActiveRecord loads them) and the readers PostEmailApi and the workflow sends call on it.
import { Prisma, type CustomDomain, type Installment, type InstallmentRule, type Link, type SellerProfile, type User, type Workflow } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";
import { parseJsonData, AFFILIATE_TYPE, AUDIENCE_TYPE, FOLLOWER_TYPE, PRODUCT_TYPE, SELLER_TYPE, VARIANT_TYPE } from "./with-filtering.ts";
import { WorkflowRecord, MEMBER_CANCELLATION_WORKFLOW_TRIGGER } from "./workflow.ts";
import { findById, findOneBy } from "./row-reads.ts";
import { column, selectRows, table } from "./sql.ts";

export const InstallmentFlags = defineFlags(
  "installments",
  {
    1: "is_unpublished_by_admin",
    2: "DEPRECATED_is_automated_installment",
    3: "DEPRECATED_stream_only",
    4: "DEPRECATED_is_open_rate_tracking_enabled",
    5: "DEPRECATED_is_click_rate_tracking_enabled",
    6: "is_for_new_customers_of_workflow",
    7: "workflow_installment_published_once_already",
    8: "shown_on_profile",
    9: "send_emails",
    10: "ready_to_publish",
    11: "allow_comments",
    12: "single_recipient_email",
  },
  { queryMode: "bit_operator" },
);

const blank = (value: string | null | undefined) => value === null || value === undefined || /^[\t\n\v\f\r ]*$/u.test(value);
const presence = (value: string | null | undefined) => (blank(value) ? null : value!);

export class InstallmentPost {
  row: Installment;
  workflowRecord: WorkflowRecord | null | undefined;
  memo: Map<string, Promise<unknown>>;

  constructor(row: Installment) {
    this.row = row;
    this.memo = new Map();
  }

  loaded<T>(key: string, load: () => Promise<T>): Promise<T> {
    let value = this.memo.get(key) as Promise<T> | undefined;
    if (value === undefined) {
      value = load();
      this.memo.set(key, value);
    }
    return value;
  }

  get id(): number {
    return this.row.id;
  }

  flag(name: Parameters<typeof InstallmentFlags.isSet>[1]): boolean {
    return InstallmentFlags.isSet(this.row.flags, name);
  }

  // ----- recipient types (WithFiltering)

  get sellerType() {
    return this.row.installment_type === SELLER_TYPE;
  }

  get productType() {
    return this.row.installment_type === PRODUCT_TYPE;
  }

  get variantType() {
    return this.row.installment_type === VARIANT_TYPE;
  }

  get audienceType() {
    return this.row.installment_type === AUDIENCE_TYPE;
  }

  get followerType() {
    return this.row.installment_type === FOLLOWER_TYPE;
  }

  get affiliateType() {
    return this.row.installment_type === AFFILIATE_TYPE;
  }

  get productOrVariantType() {
    return this.productType || this.variantType;
  }

  get sellerOrProductOrVariantType() {
    return this.sellerType || this.productOrVariantType;
  }

  // ----- associations

  seller(): Promise<User | null> {
    return this.loaded("seller", () => findById<User>("User", this.row.seller_id === null ? null : BigInt(this.row.seller_id)));
  }

  // The seller as the worker already loaded it.
  preload(key: "seller" | "workflow" | "installment_rule", value: unknown): void {
    this.memo.set(key, Promise.resolve(value));
  }

  link(): Promise<Link | null> {
    return this.loaded("link", () => findById<Link>("Link", this.row.link_id === null ? null : BigInt(this.row.link_id)));
  }

  workflow(): Promise<WorkflowRecord | null> {
    return this.loaded("workflow", async () => {
      const row = await findById<Workflow>("Workflow", this.row.workflow_id);
      return row === null ? null : new WorkflowRecord(row);
    });
  }

  installmentRule(): Promise<InstallmentRule | null> {
    return this.loaded("installment_rule", () => findOneBy<InstallmentRule>("InstallmentRule", "installment_id", this.row.id));
  }

  // `user`: `seller.presence || link.user`
  async user(): Promise<User> {
    const seller = await this.seller();
    if (seller !== null) return seller;
    const link = await this.link();
    if (link === null) throw new TypeError("undefined method 'user' for nil");
    const user = await this.loaded("link_user", () => findById<User>("User", link.user_id));
    if (user === null) throw new TypeError("undefined method 'seller_profile' for nil");
    return user;
  }

  // `has_files?` (WithProductFiles): any live product file of the post.
  hasFiles(): Promise<boolean> {
    return this.loaded("has_files", async () => {
      const rows = await selectRows(
        Prisma.sql`SELECT 1 AS one FROM ${table("product_files")} WHERE ${column("product_files", "installment_id")} = ${this.row.id} AND ${column("product_files", "deleted_at")} IS NULL LIMIT 1`,
      );
      return rows.length > 0;
    });
  }

  // `user.seller_profile`: the seller's row, if any (Ruby builds a default one when there is none)
  sellerProfile(owner: User): Promise<SellerProfile | null> {
    return this.loaded("seller_profile", () => findOneBy<SellerProfile>("SellerProfile", "seller_id", owner.id));
  }

  // `user.custom_domain` (`has_one :custom_domain, -> { alive }`)
  customDomain(owner: User): Promise<CustomDomain | null> {
    return this.loaded("custom_domain", async () => {
      const [row] = await selectRows(
        Prisma.sql`SELECT ${Prisma.raw("`custom_domains`.*")} FROM ${table("custom_domains")} WHERE ${column("custom_domains", "user_id")} = ${owner.id} AND ${column("custom_domains", "deleted_at")} IS NULL LIMIT 1`,
      );
      return (row as CustomDomain | undefined) ?? null;
    });
  }

  // ----- readers

  // `member_cancellation_trigger?`
  async memberCancellationTrigger(): Promise<boolean> {
    if (parseJsonData(this.row.json_data).workflow_trigger === MEMBER_CANCELLATION_WORKFLOW_TRIGGER) return true;
    const workflow = await this.workflow();
    return workflow !== null && workflow.memberCancellationTrigger;
  }

  // `subject`
  async subject(): Promise<string> {
    if (!blank(this.row.name)) return this.row.name!;
    const link = await this.link();
    if (link !== null) return `${link.name} - Update`;
    const seller = await this.seller();
    if (seller === null) throw new TypeError("undefined method 'name' for nil");
    return `${seller.name ?? "Creator"} - Update`;
  }

  // `reply_to_email`
  async replyToEmail(): Promise<string | null> {
    const link = await this.link();
    const productEmail = presence(link?.support_email);
    if (productEmail !== null) return productEmail;
    const seller = await this.seller();
    if (seller === null) throw new TypeError("undefined method 'support_or_form_email' for nil");
    // User#support_or_form_email: `support_email.presence || form_email`
    return presence(seller.support_email) ?? presence(seller.unconfirmed_email) ?? presence(seller.email);
  }
}
