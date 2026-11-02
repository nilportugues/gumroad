// Oauth::ApplicationsController (#create, #update, #destroy), Oauth::AccessTokensController#create and
// Oauth::AuthorizedApplicationsController#destroy, plus the GET redirects of the Doorkeeper routes.
//
// Handed to Rails before the first write: an icon (`signed_blob_id` is Active Storage), and any name or redirect URI whose validation
// Node does not model (Doorkeeper's RedirectUriValidator accepts custom schemes, lists and loopback hosts, and the error messages
// depend on it).
import * as Routes from "@/lib/navigation/routes";

import { encrypt } from "../../lib/obfuscate-ids.ts";
import type { SellerContext } from "../policies/seller-context.ts";
import { domainConfig } from "../page-props/domain.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { authorize } from "../policies/authorize.ts";
import { settingsAuthorizedApplicationsOauthApplicationPolicy as policy } from "../policies/settings/authorized-applications-oauth-application.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import {
  findAuthorizedApplication,
  findSellerApplication,
  getOrGenerateAccessToken,
  insertApplication,
  markApplicationDeleted,
  type OauthApplicationRow,
  reservedAgentApplicationName,
  revokeAccessFor,
  updateApplication,
} from "../models/oauth-application-writes.ts";
import { NotPortedError } from "../models/user.ts";
import { HandBackToRails, type ActionResult, type Redirected } from "./application-controller.ts";
import { railsSegment, registerMutations, type MutationInput } from "./mutation.ts";
import { jsonResponse, jsonSellerGuard } from "./seller-json-guard.ts";

const RESERVED_NAME_ERROR = "That application name is reserved.";
const NOT_FOUND_MESSAGE = "Application not found or you don't have the permissions to modify it.";
const MAX_STRING_LENGTH = 255;
// An absolute http(s) URL without query, fragment, credentials or whitespace: a RedirectUriValidator success in every configuration.
const PLAIN_REDIRECT_URI = /^https?:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?::\d{1,5})?(?:\/[A-Za-z0-9._~%/-]*)?$/u;
const now = () => new Date();

class Halt extends Error {
  constructor(readonly result: ActionResult) {
    super("halt");
  }
}

type ApplicationParams = { name?: string; redirect_uri?: string };

// set_application_params: `params[:oauth_application].slice(:name, :redirect_uri, ...)` when it is a hash.
function applicationParams(input: MutationInput): ApplicationParams {
  if (input.params.signed_blob_id !== undefined) throw new NotPortedError("an application icon", "app/controllers/oauth/applications_controller.rb");
  const raw = input.params.oauth_application;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ApplicationParams = {};
  for (const key of ["name", "redirect_uri"] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || [...value].length > MAX_STRING_LENGTH) throw new NotPortedError(`an unusual ${key}`, "app/controllers/oauth/applications_controller.rb");
    out[key] = value;
  }
  return out;
}

const blank = (value: string | undefined) => value === undefined || /^\s*$/u.test(value);
const applicationsUrl = (input: MutationInput) => `${input.urlOptions.protocol}://${input.urlOptions.host}/oauth/applications`;
const editPath = (id: string) => `/oauth/applications/${railsSegment(id)}/edit`;

// Sellers' pages guard: authenticate_user! (the route gate), then the action's own steps. Doorkeeper's controller has no
// RequireAccountEmail.
async function guarded(input: MutationInput, authorization: (context: SellerContext) => void, beforeAuthorize?: (seller: bigint) => Promise<void>): Promise<Redirected | null> {
  return sellerGuard(
    { context: input.context, config: domainConfig(process.env), url: input.url, params: input.routeParams, urlOptions: input.urlOptions },
    (sellerContext) => authorization(sellerContext),
    { requireAccountEmail: false, beforeAuthorize: beforeAuthorize && ((sellerContext) => beforeAuthorize(sellerContext.seller!.id)) },
  );
}

// set_application for the HTML actions.
async function findApplication(input: MutationInput, sellerId: bigint): Promise<OauthApplicationRow> {
  const application = await findSellerApplication(sellerId, input.routeParams.id!);
  if (application === null) throw new Halt({ status: 302, location: applicationsUrl(input), flash: { alert: NOT_FOUND_MESSAGE }, rescued: true });
  return application;
}

async function run(fn: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Halt) return error.result;
    throw error;
  }
}

function checkValues(params: ApplicationParams): void {
  if (params.redirect_uri !== undefined && params.redirect_uri !== "" && !PLAIN_REDIRECT_URI.test(params.redirect_uri)) throw new NotPortedError("a redirect URI Doorkeeper may reject", "app/controllers/oauth/applications_controller.rb");
}

const reservedRefusal = (path: string): ActionResult => ({ status: 302, location: path, flash: { alert: RESERVED_NAME_ERROR }, inertiaErrors: { base: [RESERVED_NAME_ERROR] } });

registerMutations(
  {
    method: "POST",
    pattern: "/oauth/applications",
    run: (input) =>
      run(async () => {
        const params = applicationParams(input);
        let result: ActionResult | null = await guarded(input, (context) => authorize(policy.create, context));
        if (result) return result;
        const name = (params.name ?? "").trim();
        if (await reservedAgentApplicationName(name)) return reservedRefusal(Routes.settings_advanced_path());
        if (blank(params.name) || blank(params.redirect_uri)) throw new NotPortedError("an application that fails validation", "app/controllers/oauth/applications_controller.rb");
        checkValues(params);
        const id = await insertApplication({ name: params.name!, redirectUri: params.redirect_uri!, ownerId: input.context.currentSeller!.id }, now);
        result = { status: 302, location: editPath(encrypt(id)), flash: { notice: "Application created." } };
        return result;
      }),
  },
  ...["PUT", "PATCH"].map((method) => ({
    method,
    pattern: "/oauth/applications/:id",
    run: (input: MutationInput) =>
      run(async () => {
        const params = applicationParams(input);
        let application: OauthApplicationRow | null = null;
        const denied = await guarded(
          input,
          (context) => authorize(policy.update, context),
          async (seller) => void (application = await findApplication(input, seller)),
        );
        if (denied) return denied;
        const target = application!;
        if (await reservedAgentApplicationName((params.name ?? "").trim())) return reservedRefusal(editPath(input.routeParams.id!));
        checkValues(params);
        const changes: ApplicationParams = {};
        if (!blank(params.name) && params.name !== target.name) changes.name = params.name;
        if (!blank(params.redirect_uri) && params.redirect_uri !== target.redirect_uri) changes.redirect_uri = params.redirect_uri;
        await updateApplication(target.id, changes, now);
        return { status: 302, location: editPath(input.routeParams.id!), flash: { notice: "Application updated." } };
      }),
  })),
  {
    method: "DELETE",
    pattern: "/oauth/applications/:id",
    run: (input) =>
      run(async () => {
        let application: OauthApplicationRow | null = null;
        const denied = await guarded(
          input,
          (context) => authorize(policy.destroy, context),
          async (seller) => void (application = await findApplication(input, seller)),
        );
        if (denied) return denied;
        await markApplicationDeleted(application!, now);
        return { status: 302, location: Routes.settings_advanced_path(), flash: { notice: "Application deleted." } };
      }),
  },
  {
    method: "DELETE",
    pattern: "/oauth/authorized_applications/:id",
    run: async (input): Promise<ActionResult> => {
      const user = railsLoggedInUser(input.context);
      if (user === null) throw new HandBackToRails("authenticate_resource_owner! for a signed-out visitor");
      const application = await findAuthorizedApplication(user.id, input.routeParams.id!);
      if (application === null) return { status: 302, location: Routes.settings_authorized_applications_path(), flash: { alert: "Authorized application could not be revoked" } };
      await revokeAccessFor(application.id, user.id, now);
      return { status: 302, location: Routes.settings_authorized_applications_path(), flash: { notice: "Authorized application revoked" } };
    },
  },
  {
    method: "POST",
    pattern: "/settings/applications/:application_id/access_tokens",
    formats: ["json"],
    run: async (input) => {
      let application: OauthApplicationRow | null = null;
      const halted = await jsonSellerGuard(input, policy.create, async (sellerContext) => {
        application = await findSellerApplication(sellerContext.seller!.id, input.routeParams.application_id!);
        return application === null ? { ...jsonResponse({ success: false, message: NOT_FOUND_MESSAGE }, 404), rescued: true } : null;
      });
      if (halted) return halted;
      return jsonResponse({ success: true, token: await getOrGenerateAccessToken(application!, now) });
    },
  },
);
