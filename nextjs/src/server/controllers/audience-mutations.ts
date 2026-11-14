// AudienceController#export: queues Exports::AudienceExportWorker for the audiences the page asks for. The worker builds the CSV and
// mails it, so nothing else happens in the request.
import type { AudienceOptions } from "../exports/audience-export.ts";
import { enqueueAudienceExport } from "../exports/enqueue.ts";
import { audiencePolicy } from "../policies/seller-analytics.ts";

import { HandBackToRails, ParameterMissing, type ActionContext, type ActionResult } from "./application-controller.ts";
import { sellerJsonAction } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

// `.permit(:followers, :customers, :affiliates)`, in that order.
const PERMITTED_OPTIONS = ["followers", "customers", "affiliates"] as const;

const isHash = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// `params.required(:options).permit(...).to_hash`. Only an absent `options` is proven to raise ParameterMissing (a 400); a blank one
// and a non-hash one (NoMethodError) are Rails' to render. A permitted key keeps a scalar (a hash or list under it is dropped); a number is left to Rails too, as its JSON
// form is not proven here.
function permittedOptions(raw: unknown): AudienceOptions {
  if (raw === undefined) throw new ParameterMissing();
  if (!isHash(raw) || Object.keys(raw).length === 0) throw new HandBackToRails("options that are blank or not a hash");
  const options: Record<string, unknown> = {};
  for (const key of PERMITTED_OPTIONS) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (typeof value === "number") throw new HandBackToRails("a numeric audience option");
    if (value === null || typeof value === "string" || typeof value === "boolean") options[key] = value;
  }
  return options as AudienceOptions;
}

async function exportAudience(input: MutationInput): Promise<ActionResult> {
  const action: Pick<ActionContext, "context" | "request"> = { context: input.context, request: input.request };
  return sellerJsonAction(action, audiencePolicy.export, async () => {
    const options = permittedOptions(input.params.options);
    const seller = input.context.currentSeller!;
    // `(impersonating_user || current_seller).id`
    const recipient = input.context.impersonatedUser ?? seller;
    await enqueueAudienceExport(BigInt(seller.id), BigInt(recipient.id), options);
    // `head :ok` answers the request format's bare content type.
    return { status: 200, body: "", contentType: "application/json", paramsRead: true };
  });
}

registerMutations({ method: "POST", pattern: "/audience/export", formats: ["json"], run: exportAudience });
