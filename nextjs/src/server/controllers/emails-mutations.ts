// EmailsController#create, #update and #destroy (app/controllers/emails_controller.rb).
import { Prisma, type Installment } from "@prisma/client";

import * as Routes from "@/lib/navigation/routes";

import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import { Installments, markDeleted } from "../models/installment-writes.ts";
import { InstallmentFlags } from "../models/installment-post.ts";
import { saveInstallment } from "../models/save-installment.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { domainConfig } from "../page-props/domain.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { authorize } from "../policies/authorize.ts";
import { installmentPolicy } from "../policies/installment.ts";
import type { PolicyQuery } from "../policies/authorize.ts";
import type { SellerContext } from "../policies/seller-context.ts";
import { RoutingError, allowedReferrer, type ActionResult } from "./application-controller.ts";
import { railsSegment, registerMutations, type MutationInput } from "./mutation.ts";
import type { ModelRecord } from "../models/runtime/record.ts";

const SEE_OTHER = 303;
const editPath = (id: string) => `/emails/${railsSegment(id)}/edit`;
const FOUND = 302;

const redirect = (location: string, notice?: string, status = SEE_OTHER): ActionResult => ({ status, location, ...(notice === undefined ? {} : { flash: { notice } }) });

// `current_seller.installments.alive.find_by_external_id(params[:id])`, or e404
async function setInstallment(seller: NonNullable<SellerContext["seller"]>, id: string): Promise<ModelRecord<Installment>> {
  const decrypted = decrypt(id);
  const [row] =
    decrypted === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT ${Prisma.raw("`installments`.*")} FROM ${table("installments")} WHERE ${column("installments", "seller_id")} = ${seller.id} AND ${column("installments", "deleted_at")} IS NULL AND ${column("installments", "id")} = ${decrypted} LIMIT 1`,
        );
  if (!row) throw new RoutingError("Not Found");
  return Installments.load(castRow<Installment>("Installment", row));
}

// Sellers::BaseController's filters, `set_installment` (update and destroy), then the action's `authorize`.
async function guarded(input: MutationInput, policy: PolicyQuery, find: boolean): Promise<{ denied: ActionResult | null; installment: ModelRecord<Installment> | null }> {
  let installment: ModelRecord<Installment> | null = null;
  const denied = await sellerGuard(
    { context: input.context, config: domainConfig(process.env), url: input.url, params: input.routeParams, urlOptions: input.urlOptions },
    (sellerContext) => authorize(policy, sellerContext),
    { beforeAuthorize: async (sellerContext) => void (find && (installment = await setInstallment(sellerContext.seller!, input.routeParams.id!))) },
  );
  return { denied, installment };
}

async function save(input: MutationInput, installment: ModelRecord<Installment> | null): Promise<ActionResult> {
  const seller = input.context.currentSeller!;
  const result = await saveInstallment({ seller, params: input.params, installment });
  const action = input.params.save_action_name;
  const saved = result.installment;
  if (result.ok && saved !== null) {
    const id = encrypt(saved.get("id"));
    if (action === "save_and_preview_post") return redirect(`${editPath(id)}?preview_post=true`, "Preview link opened.");
    if (action === "save_and_preview_email") return redirect(editPath(id), "A preview has been sent to your email.");
    if (action === "save_and_publish") return redirect(Routes.published_emails_path(), InstallmentFlags.isSet(saved.get("flags"), "send_emails") ? "Email successfully sent!" : "Email successfully published!");
    if (action === "save_and_schedule") return redirect(Routes.scheduled_emails_path(), "Email successfully scheduled!");
    return redirect(editPath(id), installment === null ? "Email created!" : "Changes saved!");
  }
  const location = installment === null ? Routes.new_email_path() : editPath(encrypt(installment.get("id")));
  return { status: FOUND, location, ...(result.error === null ? {} : { flash: { alert: result.error } }) };
}

registerMutations(
  {
    method: "POST",
    pattern: "/emails",
    run: async (input) => {
      const { denied } = await guarded(input, installmentPolicy.create, false);
      return denied ?? save(input, null);
    },
  },
  ...["PUT", "PATCH"].map((method) => ({
    method,
    pattern: "/emails/:id",
    run: async (input: MutationInput) => {
      const { denied, installment } = await guarded(input, installmentPolicy.update, true);
      return denied ?? save(input, installment);
    },
  })),
  {
    method: "DELETE",
    pattern: "/emails/:id",
    run: async (input) => {
      const { denied, installment } = await guarded(input, installmentPolicy.destroy, true);
      if (denied) return denied;
      // `@installment.update(deleted_at: Time.current)`: invalid posts are not deleted and the redirect says so anyway
      await markDeleted(installment!);
      return redirect(allowedReferrer(input.request) ?? Routes.emails_path(), "Email deleted!");
    },
  },
);
