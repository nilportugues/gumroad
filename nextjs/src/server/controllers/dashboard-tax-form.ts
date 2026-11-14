// DashboardController#download_tax_form (app/controllers/dashboard_controller.rb): Sellers::BaseController's filters, the policy, and
// the redirect to the 1099 URL `User#tax_form_1099_download_url` caches in Redis.
//
// A seller with no cached URL goes to Rails whole: it signs a 10-year S3 URL, or flashes that no form was filed when the key is missing.
import { getRedis } from "../infra/redis.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { domainConfig } from "../page-props/domain.ts";
import { authorize } from "../policies/authorize.ts";
import { dashboardPolicy } from "../policies/dashboard.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

async function downloadTaxForm(input: MutationInput): Promise<ActionResult> {
  const denied = await sellerGuard(
    {
      context: input.context,
      config: domainConfig(process.env),
      url: input.url,
      params: input.routeParams,
      urlOptions: input.urlOptions,
    },
    (sellerContext) => authorize(dashboardPolicy.downloadTaxForm, sellerContext),
  );
  if (denied) return denied;

  const year = new Date().getUTCFullYear() - 1;
  const cached = await getRedis("main").get(
    `tax_form_1099_download_url_${year}_${input.context.currentSeller!.external_id}`,
  );
  if (cached === null || cached.trim() === "") throw new HandBackToRails("a tax form URL that is not cached");
  return { status: 302, location: cached };
}

registerMutations({
  method: "GET",
  pattern: "/dashboard/download_tax_form",
  skipForgeryProtection: true,
  run: downloadTaxForm,
});
