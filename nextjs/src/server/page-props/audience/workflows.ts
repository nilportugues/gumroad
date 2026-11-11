// WorkflowsPresenter, WorkflowPresenter and the lookups of WorkflowsController and
// Workflows::EmailsController.
import { Prisma, type Installment, type InstallmentRule, type User, type Workflow } from "@prisma/client";

import { decrypt } from "../../../lib/obfuscate-ids.ts";
import { storageConfig } from "../../infra/storage.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { isFlagSet, isSuspended, Users } from "../../models/user.ts";
import { parseJsonData, filterValue } from "../../models/with-filtering.ts";
import { NotPortedError } from "../not-ported.ts";
import { hasCompletedPayment, madeSaleWithConnectOrPaypalAccount } from "../signed-in/reads.ts";
import SIGNED_IN_DATA from "../signed-in/signed-in-data.generated.json" with { type: "json" };

import DATA from "./audience-data.generated.json" with { type: "json" };
import { currencySymbol, jsonFilters } from "./filters.ts";
import {
  engagementOf,
  flagSet,
  preloadEngagement,
  workflowInstallmentProps,
  type InstallmentContext,
} from "./installments.ts";
import { creatorsFromEmailAddress, fromAddressWithName, gumroadAddress } from "./mail-addresses.ts";
import { externalId, present, userUsername } from "./support.ts";
import { productsForFilterBox, affiliateProductsForFilterBox, type FilterProduct } from "./user-presenter.ts";

const WORKFLOWS = "workflows";
const INSTALLMENTS = "installments";
const RULES = "installment_rules";
const USA = "United States";
const WORKFLOW_FLAG_SEND_TO_PAST_CUSTOMERS = 1;

// ActiveSupport::TimeZone[zone].now.strftime("%Z")
export function timeZoneAbbreviation(timezone: string | null, now = new Date()): string {
  const entry = (DATA.timeZones as Record<string, { standard: string | null; daylight: string | null }>)[
    timezone ?? ""
  ];
  const iana = TIME_ZONE_IDENTIFIERS.get(timezone ?? "");
  if (!entry || !iana) throw new NotPortedError(`the time zone ${JSON.stringify(timezone)}`);
  const offset = (date: Date) => {
    const part =
      new Intl.DateTimeFormat("en-US", { timeZone: iana, timeZoneName: "longOffset" })
        .formatToParts(date)
        .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const match = /GMT(?:([+-])(\d{2}):(\d{2}))?/u.exec(part);
    return match?.[1] ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
  };
  const year = now.getUTCFullYear();
  const standardOffset = Math.min(offset(new Date(Date.UTC(year, 0, 1))), offset(new Date(Date.UTC(year, 6, 1))));
  return offset(now) > standardOffset ? (entry.daylight ?? entry.standard ?? "") : (entry.standard ?? "");
}

const TIME_ZONE_IDENTIFIERS = new Map(Object.entries(SIGNED_IN_DATA.timeZones as Record<string, string>));

type WorkflowLink = { id: number; name: string; unique_permalink: string; user_id: number };
type VariantRow = { id: number; name: string | null };

export async function findWorkflowByExternalId(seller: User, id: string): Promise<Workflow | null> {
  const decrypted = decrypt(id);
  if (decrypted === null) return null;
  const [row] = await selectRows<Workflow>(
    Prisma.sql`SELECT ${table(WORKFLOWS)}.* FROM ${table(WORKFLOWS)} WHERE ${column(WORKFLOWS, "seller_id")} = ${seller.id} AND ${column(WORKFLOWS, "id")} = ${decrypted} LIMIT 1`,
  );
  return row ?? null;
}

// `e404 if @workflow.product_or_variant_type? && @workflow.link.user != current_seller`
export async function workflowLinkBelongsToSeller(seller: User, workflow: Workflow): Promise<boolean> {
  if (workflow.workflow_type !== "product" && workflow.workflow_type !== "variant") return true;
  const link = await linkOf(workflow);
  if (!link) throw new TypeError("undefined method 'user' for nil");
  return BigInt(link.user_id) === BigInt(seller.id);
}

async function linkOf(workflow: Workflow): Promise<WorkflowLink | null> {
  if (workflow.link_id === null) return null;
  const [row] = await selectRows<WorkflowLink>(
    Prisma.sql`SELECT * FROM ${table("links")} WHERE ${column("links", "id")} = ${workflow.link_id} LIMIT 1`,
  );
  return row ?? null;
}

async function baseVariantOf(workflow: Workflow): Promise<VariantRow | null> {
  if (workflow.base_variant_id === null) return null;
  const [row] = await selectRows<VariantRow>(
    Prisma.sql`SELECT * FROM ${table("base_variants")} WHERE ${column("base_variants", "id")} = ${workflow.base_variant_id} LIMIT 1`,
  );
  return row ?? null;
}

// `workflow.alive_installments_in_delivery_order`
async function installmentsInDeliveryOrder(
  workflow: Workflow,
): Promise<{ installment: Installment; rule: InstallmentRule | null }[]> {
  const installments = await selectRows<Installment>(
    Prisma.sql`SELECT ${table(INSTALLMENTS)}.* FROM ${table(INSTALLMENTS)} INNER JOIN ${table(RULES)} ON ${column(RULES, "installment_id")} = ${column(INSTALLMENTS, "id")} WHERE ${column(INSTALLMENTS, "workflow_id")} = ${workflow.id} AND ${column(INSTALLMENTS, "deleted_at")} IS NULL ORDER BY ${column(RULES, "delayed_delivery_time")} ASC, ${column(INSTALLMENTS, "id")} ASC`,
  );
  if (installments.length === 0) return [];
  const rules = await selectRows<InstallmentRule>(
    Prisma.sql`SELECT * FROM ${table(RULES)} WHERE ${column(RULES, "installment_id")} IN (${Prisma.join(installments.map((installment) => installment.id))})`,
  );
  return installments.map((installment) => ({
    installment,
    rule: rules.find((rule) => rule.installment_id === installment.id) ?? null,
  }));
}

type LoadedWorkflow = {
  workflow: Workflow;
  link: WorkflowLink | null;
  baseVariant: VariantRow | null;
  installments: {
    installment: Installment;
    rule: InstallmentRule | null;
    link: WorkflowLink | null;
    variant: VariantRow | null;
  }[];
};

async function load(workflow: Workflow): Promise<LoadedWorkflow> {
  const link = await linkOf(workflow);
  const baseVariant = await baseVariantOf(workflow);
  const installments = await installmentsInDeliveryOrder(workflow);
  const links = new Map<number, WorkflowLink | null>();
  const variants = new Map<number, VariantRow | null>();
  const resolved = [];
  for (const { installment, rule } of installments) {
    // Installment#link / #base_variant, for a product or variant email.
    let installmentLink: WorkflowLink | null = null;
    let variant: VariantRow | null = null;
    if (installment.installment_type === "product" || installment.installment_type === "variant") {
      if (installment.link_id !== null) {
        if (!links.has(installment.link_id)) {
          const [row] = await selectRows<WorkflowLink>(
            Prisma.sql`SELECT * FROM ${table("links")} WHERE ${column("links", "id")} = ${installment.link_id} LIMIT 1`,
          );
          links.set(installment.link_id, row ?? null);
        }
        installmentLink = links.get(installment.link_id) ?? null;
      }
    }
    if (installment.installment_type === "variant" && installment.base_variant_id !== null) {
      if (!variants.has(installment.base_variant_id)) {
        const [row] = await selectRows<VariantRow>(
          Prisma.sql`SELECT * FROM ${table("base_variants")} WHERE ${column("base_variants", "id")} = ${installment.base_variant_id} LIMIT 1`,
        );
        variants.set(installment.base_variant_id, row ?? null);
      }
      variant = variants.get(installment.base_variant_id) ?? null;
    }
    resolved.push({ installment, rule, link: installmentLink, variant });
  }
  return { workflow, link, baseVariant, installments: resolved };
}

// WorkflowPresenter#workflow_props
async function workflowProps(
  seller: User,
  loaded: LoadedWorkflow,
  engagement: Map<number, Awaited<ReturnType<typeof engagementOf>>>,
): Promise<Record<string, unknown>> {
  const { workflow, link, baseVariant } = loaded;
  const type = workflow.workflow_type;
  if (type === "abandoned_cart")
    throw new NotPortedError(
      "WorkflowPresenter#workflow_props for an abandoned cart workflow (product thumbnails and seller avatar)",
    );
  const json = parseJsonData(workflow.json_data);
  const subject = { jsonData: () => json };
  const workflowTrigger = filterValue(subject, "workflow_trigger") as string | null;

  let recipientName = "All sales";
  if (type === "product") recipientName = link!.name;
  else if (type === "variant") recipientName = `${link!.name} - ${baseVariant!.name}`;
  else if (type === "follower") recipientName = "Followers only";
  else if (type === "audience") recipientName = "Everyone";
  else if (type === "affiliate") recipientName = "Affiliates only";

  const props: Record<string, unknown> = {
    name: workflow.name,
    external_id: externalId(workflow.id),
    workflow_type: type,
    workflow_trigger: workflowTrigger,
    recipient_name: recipientName,
    published: workflow.published_at !== null,
    first_published_at: workflow.first_published_at ? workflow.first_published_at.toISOString() : null,
    send_to_past_customers: (Number(workflow.flags) & WORKFLOW_FLAG_SEND_TO_PAST_CUSTOMERS) > 0,
  };
  props.installments = [];
  for (const { installment, rule, link: installmentLink, variant } of loaded.installments) {
    const context: InstallmentContext = {
      rule,
      engagement: engagement.get(installment.id) ?? (await engagementOf(installment.id)),
      permalink: installmentLink?.unique_permalink ?? null,
      variantExternalId: variant ? externalId(variant.id) : null,
    };
    (props.installments as unknown[]).push(
      await workflowInstallmentProps({ seller, installment, context, workflowTrigger }),
    );
  }
  Object.assign(props, jsonFilters(subject, seller));
  if (type === "product" || type === "variant") {
    props.unique_permalink = link!.unique_permalink;
    if (type === "variant") props.variant_external_id = externalId(baseVariant!.id);
  }
  return props;
}

// WorkflowsPresenter#workflows_props
export async function workflowsIndexProps(seller: User) {
  const rows = await selectRows<Workflow>(
    Prisma.sql`SELECT ${table(WORKFLOWS)}.* FROM ${table(WORKFLOWS)} WHERE ${column(WORKFLOWS, "seller_id")} = ${seller.id} AND ${column(WORKFLOWS, "deleted_at")} IS NULL ORDER BY created_at DESC`,
  );
  const loaded = [];
  for (const row of rows) loaded.push(await load(row));
  const engagement = await preloadEngagement(
    loaded.flatMap((entry) => entry.installments.map((installment) => installment.installment)),
  );
  return { workflows: await Promise.all(loaded.map((entry) => workflowProps(seller, entry, engagement))) };
}

// WorkflowPresenter#workflow_props for one workflow: each email reads its own engagement counters.
export async function workflowPropsFor(seller: User, workflow: Workflow) {
  return workflowProps(seller, await load(workflow), new Map());
}

// User#eligible_for_abandoned_cart_workflows?
async function eligibleForAbandonedCartWorkflows(seller: User): Promise<boolean> {
  const record = Users.load(seller);
  if (isFlagSet(record, "is_team_member")) return true;
  if (isSuspended(record)) return false;
  return (await hasCompletedPayment(seller.id)) || (await madeSaleWithConnectOrPaypalAccount(seller.id));
}

const variantOptions = (product: FilterProduct, label: (name: string | null) => string) =>
  product.variants.map((variant) => ({
    id: externalId(variant.id),
    label: label(variant.name),
    product_permalink: product.unique_permalink,
    archived: product.archived,
    type: "variant",
  }));

// WorkflowPresenter#workflow_form_context_props
export async function workflowFormContext(seller: User) {
  const products = await productsForFilterBox(seller);
  const affiliateProducts = await affiliateProductsForFilterBox(seller);
  const storage = storageConfig();
  return {
    products_and_variant_options: products.flatMap((product) => [
      {
        id: product.unique_permalink,
        label: product.name,
        product_permalink: product.unique_permalink,
        archived: product.archived,
        type: "product",
      },
      ...variantOptions(product, (name) => `${product.name} — ${name}`),
    ]),
    affiliate_product_options: affiliateProducts.map((product) => ({
      id: product.unique_permalink,
      label: product.name,
      product_permalink: product.unique_permalink,
      archived: product.archived,
      type: "product",
    })),
    timezone: timeZoneAbbreviation(seller.timezone),
    currency_symbol: currencySymbol(seller),
    countries: [USA, ...(DATA.countries as string[]).filter((name) => name !== USA)],
    aws_access_key_id: storage.accessKeyId ?? null,
    s3_url: `${storage.s3Endpoint}/${storage.s3Bucket}`,
    user_id: seller.external_id,
    gumroad_address: gumroadAddress(),
    email_from: fromAddressWithName(seller.name, creatorsFromEmailAddress(userUsername(seller))),
    eligible_for_abandoned_cart_workflows: await eligibleForAbandonedCartWorkflows(seller),
  };
}

export { present, flagSet };
