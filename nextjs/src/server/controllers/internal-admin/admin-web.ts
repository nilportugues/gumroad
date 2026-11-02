// Admin::BaseController: the team-member entry points the admin web UI left behind (#impersonate, #unimpersonate,
// #redirect_to_stripe_dashboard).
import type { User } from "@prisma/client";

import { db } from "../../../lib/db.ts";
import { prismaAuthStore } from "../../auth/store.ts";
import { getRedis } from "../../infra/redis.ts";
import { railsEnv } from "../../infra/rails-env.ts";
import { isFlagSet, Users } from "../../models/user.ts";
import { NotPortedError } from "../../models/user.ts";
import type { ActionContext, ActionResult, Redirected, Rendered } from "../application-controller.ts";
import { jsonResponse } from "../json-seller.ts";
import { registerMutations } from "../mutation.ts";
import { requestFormat } from "../rails-params.ts";
import type { RailsRequest } from "../rails-request.ts";

const SOURCE = "app/controllers/admin/base_controller.rb";
const IMPERSONATION_TTL_SECONDS = 7 * 86_400;
const NOT_FOUND = 404;

const origin = (request: RailsRequest) => `${request.protocol}${request.hostWithPort}`;
const redirectTo = (request: RailsRequest, path: string, flash?: Record<string, string>): Redirected => ({ status: 302, location: `${origin(request)}${path}`, ...(flash ? { flash } : {}) });

// require_admin!: the Warden user (not the impersonated one) must be a team member.
function requireAdmin(request: RailsRequest, context: ActionContext["context"]): { admin: User } | { halt: ActionResult } {
  const xhrOrJson = request.headers.get("x-requested-with")?.toLowerCase() === "xmlhttprequest" || requestFormat(request) === "json";
  const notFound = (): { halt: ActionResult } => ({ halt: { ...jsonResponse({ success: false, error: "Not found" }, NOT_FOUND), rescued: true } });
  const admin = context.loggedInUser;
  if (admin === null) return xhrOrJson ? notFound() : { halt: { ...redirectTo(request, `/login?next=${encodeURIComponent(request.path)}`), rescued: true } };
  if (!isFlagSet(Users.load(admin), "is_team_member")) return xhrOrJson ? notFound() : { halt: { ...redirectTo(request, "/"), rescued: true } };
  return { admin };
}

// find_user: external id, email, username, then a Stripe account id.
async function findUser(identifier: unknown): Promise<User | null> {
  if (identifier === undefined || identifier === null || (typeof identifier === "string" && /^\p{White_Space}*$/u.test(identifier))) return null;
  if (typeof identifier !== "string") throw new NotPortedError("a user_identifier that is not a string", SOURCE);
  const user = (await db.user.findFirst({ where: { external_id: identifier } })) ?? (await db.user.findFirst({ where: { email: identifier } })) ?? (await db.user.findFirst({ where: { username: identifier } }));
  if (user !== null) return user;
  const account = await db.merchantAccount.findFirst({ where: { charge_processor_id: "stripe", charge_processor_merchant_id: identifier } });
  return account?.user_id == null ? null : db.user.findFirst({ where: { id: account.user_id } });
}

const identifierParam = (request: RailsRequest, url: URL): unknown => {
  const values = url.searchParams.getAll("user_identifier");
  if (request.queryString.includes("user_identifier[") || request.queryString.includes("user_identifier%5B")) return {};
  return values.at(-1);
};

export async function impersonate(request: RailsRequest, url: URL, { context }: Pick<ActionContext, "context">): Promise<ActionResult> {
  const admin = requireAdmin(request, context);
  if ("halt" in admin) return admin.halt;
  const user = await findUser(identifierParam(request, url));
  if (user === null) return redirectTo(request, "/", { alert: "User not found" });
  // impersonate_user: reset_impersonated_user, then the new key.
  await prismaAuthStore.clearImpersonation(admin.admin.id);
  await getRedis("main").set(`impersonated_user_by_admin_${admin.admin.id}`, String(user.id), "EX", IMPERSONATION_TTL_SECONDS);
  return redirectTo(request, "/products");
}

export async function redirectToStripeDashboard(request: RailsRequest, url: URL, { context }: Pick<ActionContext, "context">): Promise<ActionResult> {
  const admin = requireAdmin(request, context);
  if ("halt" in admin) return admin.halt;
  const user = await findUser(identifierParam(request, url));
  if (user === null) return redirectTo(request, "/", { alert: "User not found" });
  const account = await db.merchantAccount.findFirst({ where: { user_id: user.id, deleted_at: null, charge_processor_id: "stripe" }, orderBy: { id: "asc" } });
  if (account?.charge_processor_merchant_id == null || account.charge_processor_merchant_id === "") return redirectTo(request, "/", { alert: "Stripe account not found" });
  const base = `https://dashboard.stripe.com${railsEnv() === "production" ? "" : "/test"}`;
  return { status: 302, location: `${base}/connect/accounts/${account.charge_processor_merchant_id}` };
}

registerMutations({
  method: "DELETE",
  pattern: "/admin/unimpersonate",
  formats: ["any"],
  run: async ({ request, context }): Promise<Rendered | ActionResult> => {
    const admin = requireAdmin(request, context);
    if ("halt" in admin) return admin.halt;
    await prismaAuthStore.clearImpersonation(admin.admin.id);
    return jsonResponse({ redirect_to: `${origin(request)}/` });
  },
});
