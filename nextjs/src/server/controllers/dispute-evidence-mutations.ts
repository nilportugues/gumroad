// Purchases::DisputeEvidenceController#update (app/controllers/purchases/dispute_evidence_controller.rb): the guards and a statement
// saved without files. An upload (attach, PNG conversion, PDF merge and page count on S3) and a body Node does not read the way
// Rails does go to Rails whole, before the first write.
import { Prisma, type DisputeEvidence } from "@prisma/client";

import { DisputeEvidences } from "../models/dispute-evidence-writes.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import { isBlank } from "../models/runtime/validators.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { disputeEvidenceFilters, loadDisputeEvidence } from "../page-props/dispute-evidence/pages.ts";

import { HandBackToRails, type ActionOptions, type ActionResult } from "./application-controller.ts";
import { railsSegment, registerMutations, type MutationInput } from "./mutation.ts";
import { toSentence } from "./settings-mutations.ts";

const SEE_OTHER = 303;
const FOUND = 302;
const TEXT_FIELDS = ["cancellation_rebuttal", "reason_for_winning", "refund_refusal_explanation"] as const;
const FILE_PARAMS = [
  "customer_communication_file_signed_blob_ids",
  "customer_communication_file_signed_blob_id",
] as const;

// `skip_before_action :check_suspended`: a suspended seller can still answer a chargeback.
const OPTIONS: ActionOptions = { skip: ["check_suspended"], filters: disputeEvidenceFilters(true, false) };

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const blankId = (value: unknown) =>
  value == null || (Array.isArray(value) ? value.every((id) => id == null || isBlank(id)) : isBlank(value));

// `params.require(:dispute_evidence).permit(...)`, whose ParameterMissing and JSON wrapping are left to Rails.
function evidenceParams({ params }: MutationInput): Record<string, string | null> {
  const given = params.dispute_evidence;
  if (!isHash(given) || Object.keys(given).length === 0)
    throw new HandBackToRails("a dispute_evidence parameter that is not a populated hash");
  if (FILE_PARAMS.some((name) => !blankId(given[name]))) throw new HandBackToRails("a customer communication upload");
  const statement: Record<string, string | null> = {};
  for (const field of TEXT_FIELDS) {
    if (!(field in given)) continue;
    const value = given[field];
    if (value !== null && typeof value !== "string") throw new HandBackToRails("a statement that is not a string");
    statement[field] = value;
  }
  return statement;
}

async function update(input: MutationInput): Promise<ActionResult> {
  const statement = evidenceParams(input);
  // The filters have resolved the purchase and the evidence; the action needs the route id they kept.
  const loaded = (await loadDisputeEvidence(input.routeParams.purchase_id!))!;
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`dispute_evidences`.*")} FROM ${table("dispute_evidences")} WHERE ${column("dispute_evidences", "id")} = ${loaded.evidence.id} LIMIT 1`,
  );
  const evidence = DisputeEvidences.load(castRow<DisputeEvidence>("DisputeEvidence", row!));

  try {
    evidence.assign(statement);
    evidence.set("seller_submitted_at", new Date());
    await DisputeEvidences.saveBang(evidence);
  } catch (error) {
    if (!(error instanceof RecordInvalid)) throw error;
    return {
      status: FOUND,
      location: `/purchases/${railsSegment(loaded.routeId)}/dispute_evidence`,
      flash: { alert: toSentence(error.errors.fullMessages()) },
    };
  }
  return { status: SEE_OTHER, location: `/purchases/${railsSegment(loaded.routeId)}/dispute_evidence/success` };
}

registerMutations(
  ...["PUT", "PATCH"].map((method) => ({
    method,
    pattern: "/purchases/:purchase_id/dispute_evidence",
    options: OPTIONS,
    run: update,
  })),
);
