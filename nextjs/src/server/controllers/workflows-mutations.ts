// WorkflowsController#create, #update and #destroy (app/controllers/workflows_controller.rb), and the guards of
// Workflows::EmailsController#update: its saves go through Workflow::SaveInstallmentsService (moderation, schedule intents, preview
// mail), which is not ported, so a request that passes them goes to Rails whole, before any write.
import { Prisma, type Link, type Workflow } from "@prisma/client";

import * as Routes from "@/lib/navigation/routes";

import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import type { ModelRecord } from "../models/runtime/record.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { PRODUCT_TYPE, VARIANT_TYPE } from "../models/with-filtering.ts";
import {
  findVisibleProduct,
  manageWorkflow,
  permitWorkflow,
  SAVE_AND_PUBLISH_ACTION,
  SAVE_AND_UNPUBLISH_ACTION,
} from "../models/workflow-manage.ts";
import { markDeletedBang, Workflows } from "../models/workflow-writes.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { domainConfig } from "../page-props/domain.ts";
import { authorize, type PolicyQuery } from "../policies/authorize.ts";
import { workflowPolicy } from "../policies/workflow.ts";

import { HandBackToRails, RoutingError, type ActionResult } from "./application-controller.ts";
import { railsSegment, registerMutations, type MutationInput } from "./mutation.ts";

const SEE_OTHER = 303;
const FOUND = 302;
const FLASH_CHANGES_SAVED = "Changes saved!";
const FLASH_WORKFLOW_PUBLISHED = "Workflow published!";
const FLASH_WORKFLOW_UNPUBLISHED = "Unpublished!";
const FLASH_WORKFLOW_DELETED = "Workflow deleted!";

type Loaded = { workflow: ModelRecord<Workflow> | null; product: Link | null; params: Record<string, unknown> };

// `current_seller.workflows.find_by_external_id(params[:id])`, e404 for a workflow of a product that is not the seller's
async function setWorkflow(sellerId: bigint, id: string): Promise<ModelRecord<Workflow>> {
  const decrypted = decrypt(id);
  const [row] =
    decrypted === null
      ? []
      : await selectRows(
          Prisma.sql`SELECT ${Prisma.raw("`workflows`.*")} FROM ${table("workflows")} WHERE ${column("workflows", "seller_id")} = ${sellerId} AND ${column("workflows", "id")} = ${decrypted} LIMIT 1`,
        );
  if (!row) throw new RoutingError("Not Found");
  const workflow = Workflows.load(castRow<Workflow>("Workflow", row));
  const type = workflow.get("workflow_type");
  if (type === PRODUCT_TYPE || type === VARIANT_TYPE) {
    const [link] = await selectRows<Link>(
      Prisma.sql`SELECT ${Prisma.raw("`links`.*")} FROM ${table("links")} WHERE ${column("links", "id")} = ${workflow.get("link_id")} LIMIT 1`,
    );
    if (!link) throw new TypeError("undefined method 'user' for nil");
    if (link.user_id !== sellerId) throw new RoutingError("Not Found");
  }
  return workflow;
}

// Sellers::BaseController's filters, then the controller's: `set_workflow` and `authorize_workflow` (update and destroy), the product of a
// product or variant workflow (create and update), and for create the action's own `authorize Workflow`.
async function guarded(
  input: MutationInput,
  policy: PolicyQuery,
  steps: { find: boolean; product: boolean },
): Promise<{ denied: ActionResult | null; loaded: Loaded }> {
  const loaded: Loaded = { workflow: null, product: null, params: {} };
  const denied = await sellerGuard(
    {
      context: input.context,
      config: domainConfig(process.env),
      url: input.url,
      params: input.routeParams,
      urlOptions: input.urlOptions,
    },
    async (sellerContext) => {
      const seller = sellerContext.seller!;
      if (steps.find) {
        loaded.workflow = await setWorkflow(seller.id, input.routeParams.id!);
        // authorize @workflow, as a before_action
        authorize(policy, sellerContext);
      }
      if (steps.product) {
        loaded.params = permitWorkflow(input.params.workflow);
        const type = loaded.params.workflow_type;
        if (type === PRODUCT_TYPE || type === VARIANT_TYPE) {
          loaded.product = await findVisibleProduct(seller, loaded.params.permalink);
          if (loaded.product === null) throw new RoutingError("Not Found");
        }
      }
      if (!steps.find) authorize(policy, sellerContext);
    },
  );
  return { denied, loaded };
}

async function manage(input: MutationInput, loaded: Loaded): Promise<ActionResult> {
  const result = await manageWorkflow({
    seller: input.context.currentSeller!,
    params: loaded.params,
    product: loaded.product,
    workflow: loaded.workflow,
  });
  const workflow = result.workflow;
  if (result.ok) {
    const action = loaded.params.save_action_name;
    const notice =
      loaded.workflow === null
        ? FLASH_CHANGES_SAVED
        : action === SAVE_AND_PUBLISH_ACTION
          ? FLASH_WORKFLOW_PUBLISHED
          : action === SAVE_AND_UNPUBLISH_ACTION
            ? FLASH_WORKFLOW_UNPUBLISHED
            : FLASH_CHANGES_SAVED;
    return {
      status: SEE_OTHER,
      location: `/workflows/${railsSegment(encrypt(workflow.get("id")))}/emails`,
      flash: { notice },
    };
  }
  const location =
    loaded.workflow === null
      ? Routes.new_workflow_path()
      : `/workflows/${railsSegment(encrypt(workflow.get("id")))}/edit`;
  return { status: FOUND, location, flash: { alert: result.error ?? "" }, inertiaErrors: { base: [result.error] } };
}

async function updateEmails(input: MutationInput): Promise<ActionResult> {
  const denied = await sellerGuard(
    {
      context: input.context,
      config: domainConfig(process.env),
      url: input.url,
      params: input.routeParams,
      urlOptions: input.urlOptions,
    },
    async (sellerContext) => {
      // `@workflow.link.user` raises NoMethodError in Rails for a workflow whose product row is gone.
      await setWorkflow(sellerContext.seller!.id, input.routeParams.workflow_id!).catch((error: unknown) => {
        if (error instanceof TypeError) throw new HandBackToRails("a workflow whose product row is missing");
        throw error;
      });
      authorize(workflowPolicy.update, sellerContext);
    },
  );
  if (denied) return denied;
  throw new HandBackToRails("an email save, which Workflow::SaveInstallmentsService performs");
}

registerMutations(
  { method: "PATCH", pattern: "/workflows/:workflow_id/emails", run: updateEmails },
  {
    method: "POST",
    pattern: "/workflows",
    run: async (input) => {
      const { denied, loaded } = await guarded(input, workflowPolicy.create, { find: false, product: true });
      return denied ?? manage(input, loaded);
    },
  },
  ...["PUT", "PATCH"].map((method) => ({
    method,
    pattern: "/workflows/:id",
    run: async (input: MutationInput) => {
      const { denied, loaded } = await guarded(input, workflowPolicy.update, { find: true, product: true });
      return denied ?? manage(input, loaded);
    },
  })),
  {
    method: "DELETE",
    pattern: "/workflows/:id",
    run: async (input) => {
      const { denied, loaded } = await guarded(input, workflowPolicy.destroy, { find: true, product: false });
      if (denied) return denied;
      await markDeletedBang(loaded.workflow!);
      return { status: SEE_OTHER, location: Routes.workflows_path(), flash: { notice: FLASH_WORKFLOW_DELETED } };
    },
  },
);
