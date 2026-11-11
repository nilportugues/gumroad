// Purchases::DisputeEvidenceController#show and #success (DisputeEvidencePagePresenter): the seller's
// page for answering a chargeback. #update is in controllers/dispute-evidence-mutations.ts.
import type { Charge, Dispute, DisputeEvidence, Link, Purchase, User } from "@prisma/client";

import * as Routes from "@/lib/navigation/routes";

import { db } from "../../../lib/db.ts";
import { decrypt, encrypt } from "../../../lib/obfuscate-ids.ts";
import { RoutingError, type Redirected, type ActionOptions, type Chain } from "../../controllers/application-controller.ts";
import { signedInFilters } from "../../controllers/buyer-pages.ts";
import { domainConfig } from "../domain.ts";
import { isBlank } from "../../models/compliance-countries.ts";
import { formattedDollarAmount } from "../../models/concerns/currency-helper.ts";
import { hoursLeftInWindow, sellerResponseDueAt, windowOpen } from "../../models/dispute-evidence.ts";
import { decryptSecureExternalId } from "../../models/secure-external-id.ts";
import { roleOwnerFor } from "../../policies/seller-context.ts";
import { userSubdomainWithProtocol } from "../audience/support.ts";
import { NotPortedError } from "../not-ported.ts";
import type { PageSpec } from "../pages.ts";

const SECURE_ID_SCOPE = "dispute_evidence";
const STRIPE_MAX_COMBINED_FILE_SIZE = 5_000_000;
const MAX_CUSTOMER_COMMUNICATION_FILES = 10;
const PATH = /^\/purchases\/([^/.]+)\/dispute_evidence(?:\/success)?$/u;

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// The disputable the page is about: the purchase's charge when it has one, else the purchase.
type Disputable = { kind: "charge"; charge: Charge; purchases: Purchase[] } | { kind: "purchase"; purchases: Purchase[] };

type Loaded = {
  routeId: string;
  purchase: Purchase;
  disputable: Disputable;
  dispute: Dispute;
  evidence: DisputeEvidence;
};

const optionalString = (value: string | null | undefined) => (value === null || value === undefined ? null : value);

// Purchase.find_by_secure_external_id(id, scope:) || Purchase.find_by_external_id(id)
async function findPurchase(requestedId: string): Promise<{ purchase: Purchase | null; scoped: boolean }> {
  const scopedId = decryptSecureExternalId("Purchase", requestedId, SECURE_ID_SCOPE);
  const scoped = scopedId === null ? null : await db.purchase.findUnique({ where: { id: BigInt(scopedId) } });
  if (scoped) return { purchase: scoped, scoped: true };
  const id = decrypt(requestedId);
  return { purchase: id === null ? null : await db.purchase.findUnique({ where: { id: BigInt(id) } }), scoped: false };
}

async function loadDisputable(purchase: Purchase): Promise<Disputable> {
  const chargePurchase = await db.chargePurchase.findFirst({ where: { purchase_id: purchase.id }, orderBy: { id: "asc" } });
  const charge = chargePurchase ? await db.charge.findUnique({ where: { id: chargePurchase.charge_id } }) : null;
  if (!charge) return { kind: "purchase", purchases: [purchase] };
  const links = await db.chargePurchase.findMany({ where: { charge_id: charge.id }, orderBy: { id: "asc" } });
  const purchases = await db.purchase.findMany({ where: { id: { in: links.map((link) => link.purchase_id) } } });
  return { kind: "charge", charge, purchases: links.flatMap((link) => purchases.filter((candidate) => candidate.id === link.purchase_id)) };
}

// Charge::Disputable#purchase_for_dispute_evidence
async function purchaseForDisputeEvidence(disputable: Disputable, disputeReason: string | null): Promise<Purchase> {
  const purchases = disputable.purchases;
  if (purchases.length <= 1) return purchases[0]!;
  const withPolicy = new Set((await db.purchaseRefundPolicy.findMany({ where: { purchase_id: { in: purchases.map((purchase) => purchase.id) } }, select: { purchase_id: true } })).map((row) => row.purchase_id));
  const purchasesWithPolicy = purchases.filter((purchase) => withPolicy.has(purchase.id));
  const subscriptions = new Set((await db.subscription.findMany({ where: { id: { in: purchases.flatMap((purchase) => (purchase.subscription_id === null ? [] : [purchase.subscription_id])) } }, select: { id: true } })).map((row) => row.id));
  const subscriptionPurchases = purchases.filter((purchase) => purchase.subscription_id !== null && subscriptions.has(purchase.subscription_id));
  const both = purchasesWithPolicy.filter((purchase) => subscriptionPurchases.includes(purchase));

  const present = (list: Purchase[]) => (list.length > 0 ? list : null);
  let selected = present(both);
  selected ??= disputeReason === "subscription_canceled" ? (present(subscriptionPurchases) ?? present(purchasesWithPolicy)) : (present(purchasesWithPolicy) ?? present(subscriptionPurchases));
  selected ??= purchases;
  // min_by { [-total_transaction_cents.to_i, id] }
  return [...selected].sort((a, b) => {
    const byAmount = Number(b.total_transaction_cents ?? 0) - Number(a.total_transaction_cents ?? 0);
    return byAmount !== 0 ? byAmount : Number(a.id - b.id);
  })[0]!;
}

async function attachment(evidenceId: bigint, name: string) {
  const row = await db.activeStorageAttachment.findFirst({ where: { record_type: "DisputeEvidence", record_id: evidenceId, name } });
  return row ? db.activeStorageBlob.findUnique({ where: { id: row.blob_id } }) : null;
}

// Charge::Disputable#formatted_disputed_amount. A buyer-currency presentment needs
// StripeChargeProcessor.format_charge_presentment_amount, which is not ported.
async function formattedDisputedAmount(disputable: Disputable): Promise<string> {
  const cents = disputable.kind === "charge" ? disputable.charge.amount_cents : disputable.purchases[0]!.total_transaction_cents;
  const presentment =
    disputable.kind === "charge"
      ? await db.chargePresentment.findFirst({ where: { charge_id: disputable.charge.id } })
      : await db.purchasePresentment.findFirst({ where: { purchase_id: disputable.purchases[0]!.id } });
  if (presentment && presentment.presentment_total_cents !== null && !isBlank(presentment.presentment_currency)) {
    throw new NotPortedError("Charge::Disputable#formatted_disputed_amount for a buyer-currency presentment");
  }
  return formattedDollarAmount(cents ?? 0);
}

function longUrl(product: Link, owner: User): string {
  const config = domainConfig(process.env);
  const host = userSubdomainWithProtocol(owner) ?? `${config.protocol}://${config.domain}`;
  const permalink = product.custom_permalink !== null && !isBlank(product.custom_permalink) ? product.custom_permalink : (product.unique_permalink ?? "");
  return `${host}/l/${encodeURIComponent(permalink)}`;
}

const iso8601 = (value: Date) => value.toISOString().replace(/\.\d+Z$/u, "Z");

// set_purchase (the purchase and the seller who owns it), then set_dispute_evidence. A missing dispute
// or evidence raises NoMethodError on nil, a 500.
export async function loadDisputeEvidence(requestedId: string): Promise<(Loaded & { seller: User; scoped: boolean }) | null> {
  const { purchase, scoped } = await findPurchase(requestedId);
  if (!purchase) return null;
  const seller = await db.user.findUnique({ where: { id: purchase.seller_id ?? -1n } });
  if (!seller) throw new TypeError("undefined method for nil");
  const disputable = await loadDisputable(purchase);
  const dispute =
    disputable.kind === "charge"
      ? await db.dispute.findFirst({ where: { charge_id: disputable.charge.id }, orderBy: { id: "asc" } })
      : await db.dispute.findFirst({ where: { purchase_id: Number(purchase.id) }, orderBy: { id: "asc" } });
  if (!dispute) throw new TypeError("undefined method 'dispute_evidence' for nil");
  const evidence = await db.disputeEvidence.findFirst({ where: { dispute_id: BigInt(dispute.id) } });
  if (!evidence) throw new TypeError("undefined method for nil");
  return { routeId: scoped ? requestedId : encrypt(Number(purchase.id)), purchase, disputable, dispute, evidence, seller, scoped };
}

function urlOptions(chain: Chain) {
  return { protocol: chain.request.protocol.replace("://", ""), host: chain.request.hostWithPort };
}

// check_if_needs_redirect
function needsRedirect(evidence: DisputeEvidence): string | null {
  if (evidence.seller_contacted_at === null) return "You are not allowed to perform this action.";
  if (evidence.resolved_at !== null) return "Additional information can no longer be submitted for this dispute.";
  if (!windowOpen(evidence.seller_contacted_at, new Date())) return "The deadline for submitting additional information for this dispute has passed.";
  return null;
}

// authenticate_user!, set_purchase, set_dispute_evidence, check_if_needs_redirect (not for #success), then
// the action's set_noindex_header (#show and #success only).
export function disputeEvidenceFilters(checkRedirect: boolean, noindex = true): ActionOptions["filters"] {
  return signedInFilters({
    requireAccountEmail: false,
    authorize: () => true,
    beforeAction: async (chain, context): Promise<Redirected | null> => {
      const loaded = await loadDisputeEvidence(decode(PATH.exec(chain.request.path)![1]!));
      if (!loaded) throw new RoutingError("Not Found");
      const dashboard = (flash: string) => ({ status: 302, location: Routes.dashboard_url(urlOptions(chain)), flash: { alert: flash }, rescued: true });
      if (!roleOwnerFor(context, loaded.seller)) {
        // Only the emailed token earns an explanation; the buyer-visible external_id stays a bare 404.
        if (!loaded.scoped) throw new RoutingError("Not Found");
        return dashboard("This page belongs to the seller account that made the sale. Sign in with that account, or reply to the chargeback email with your statement.");
      }
      const message = checkRedirect ? needsRedirect(loaded.evidence) : null;
      if (message) return dashboard(message);
      if (noindex) chain.headers.set("x-robots-tag", "noindex");
      return null;
    },
  });
}

async function showProps(loaded: Loaded) {
  const { purchase, disputable, dispute, evidence, routeId } = loaded;
  const evidencePurchase = await purchaseForDisputeEvidence(disputable, dispute.reason);
  const subscriptionIds = disputable.purchases.flatMap((candidate) => (candidate.subscription_id === null ? [] : [candidate.subscription_id]));
  const subscriptions = new Set((await db.subscription.findMany({ where: { id: { in: subscriptionIds } }, select: { id: true } })).map((row) => row.id));
  const forSubscription = subscriptionIds.some((id) => subscriptions.has(id));
  const receipt = await attachment(evidence.id, "receipt_image");
  const policy = await attachment(evidence.id, forSubscription ? "cancellation_policy_image" : "refund_policy_image");
  const communication = await attachment(evidence.id, "customer_communication_file");
  const blobProps = (blob: Awaited<ReturnType<typeof attachment>>, title: string) =>
    blob ? { byte_size: Number(blob.byte_size), filename: blob.filename, key: blob.key, signed_id: null, title } : null;

  const links = new Map((await db.link.findMany({ where: { id: { in: disputable.purchases.flatMap((candidate) => (candidate.link_id === null ? [] : [candidate.link_id])) } } })).map((link) => [link.id, link]));
  const owners = new Map((await db.user.findMany({ where: { id: { in: [...links.values()].flatMap((link) => (link.user_id === null ? [] : [link.user_id])) } } })).map((user) => [user.id, user]));
  const productProps = disputable.purchases.map((candidate) => {
    const link = links.get(candidate.link_id!)!;
    return { name: link.name, url: longUrl(link, owners.get(link.user_id!)!) };
  });

  const dueAt = sellerResponseDueAt(evidence.seller_contacted_at);
  const hoursLeft = evidence.resolved_at !== null ? 0 : hoursLeftInWindow(evidence.seller_contacted_at, new Date());
  return {
    dispute_evidence: {
      dispute_reason: dispute.reason,
      customer_email: optionalString(evidence.customer_email),
      purchased_at: evidence.purchased_at && evidence.purchased_at.toISOString(),
      duration_left_to_submit_evidence_formatted: `${hoursLeft} hours`,
      seller_response_due_at: dueAt && iso8601(dueAt),
      customer_communication_file_max_size: STRIPE_MAX_COMBINED_FILE_SIZE - Number(receipt?.byte_size ?? 0) - Number(policy?.byte_size ?? 0),
      customer_communication_files_max_count: MAX_CUSTOMER_COMMUNICATION_FILES,
      blobs: {
        receipt_image: blobProps(receipt, "Receipt"),
        policy_image: blobProps(policy, "Refund policy"),
        customer_communication_file: blobProps(communication, "Customer communication"),
      },
      saved: {
        reason_for_winning: evidence.reason_for_winning,
        cancellation_rebuttal: evidence.cancellation_rebuttal,
        refund_refusal_explanation: evidence.refund_refusal_explanation,
      },
    },
    disputable: {
      purchase_for_dispute_evidence_id: routeId,
      formatted_display_price: await formattedDisputedAmount(disputable),
      is_subscription: evidencePurchase.subscription_id !== null && (await db.subscription.count({ where: { id: evidencePurchase.subscription_id } })) > 0,
    },
    products: productProps,
  };
}

// strftime("%B %-d, %Y at %-l:%M %p %Z"), in UTC
function dueAtFormatted(value: Date | null): string | null {
  if (value === null) return null;
  const month = value.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const hours = value.getUTCHours();
  const minutes = String(value.getUTCMinutes()).padStart(2, "0");
  return `${month} ${value.getUTCDate()}, ${value.getUTCFullYear()} at ${hours % 12 === 0 ? 12 : hours % 12}:${minutes} ${hours < 12 ? "AM" : "PM"} UTC`;
}

export const DISPUTE_EVIDENCE_PAGES: Record<string, PageSpec> = {
  "/purchases/:purchase_id/dispute_evidence": {
    component: "Purchases/DisputeEvidence/Show",
    options: { filters: disputeEvidenceFilters(true) },
    props: async ({ purchase_id }, { meta }) => {
      meta.set({ title: "Submit additional information" });
      return showProps((await loadDisputeEvidence(purchase_id!))!);
    },
  },
  "/purchases/:purchase_id/dispute_evidence/success": {
    component: "Purchases/DisputeEvidence/Success",
    options: { filters: disputeEvidenceFilters(false) },
    props: async ({ purchase_id }, { meta }) => {
      meta.set({ title: "Submit additional information" });
      const loaded = (await loadDisputeEvidence(purchase_id!))!;
      return {
        seller_response_due_at_formatted: dueAtFormatted(sellerResponseDueAt(loaded.evidence.seller_contacted_at)),
        purchase_for_dispute_evidence_id: loaded.routeId,
      };
    },
  },
};
