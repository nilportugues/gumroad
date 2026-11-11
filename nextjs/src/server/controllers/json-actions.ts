// GET (and JSON POST) endpoints of Sellers::BaseController-style controllers that answer JSON or plain text rather than render a page:
// the same chain as a page request (processAction), the action's input shaped like a mutation's, and Pundit's refusal in the format
// the request asks for (PunditAuthorization#default_user_not_authorized).
import { railsLoggedInUser } from "../auth/resolve.ts";
import { sellerGuard, notAllowedMessage } from "../page-props/audience/seller-guard.ts";
import { domainConfig } from "../page-props/domain.ts";
import { defaultUrlOptions } from "../page-props/load-page.ts";
import { NotAuthorizedError, type SellerContext } from "../policies/seller-context.ts";
import { escapeHtmlInJson } from "../search/es-json.ts";

import {
  HandBackToRails,
  processAction,
  type ActionOptions,
  type ActionResult,
  type Rendered,
} from "./application-controller.ts";
import type { MutationInput } from "./mutation.ts";
import { requestParams } from "./rails-body.ts";
import { requestFormat } from "./rails-params.ts";

export const json = (body: unknown, status = 200): Rendered => ({
  status,
  body: escapeHtmlInJson(JSON.stringify(body)),
  contentType: "application/json; charset=utf-8",
  paramsRead: true,
});
export const plain = (body: string, status = 200): Rendered => ({
  status,
  body,
  contentType: "text/plain; charset=utf-8",
  paramsRead: true,
});

// A request for a signed-in seller endpoint: Rails answers the signed-out one (Devise: 401 JSON or a login redirect).
// `authorization` throws NotAuthorizedError for a refusal; a JSON request is then told so with a 401.
export async function jsonSellerGuard(
  input: MutationInput,
  authorization: (context: SellerContext) => void | Promise<void>,
): Promise<ActionResult | null> {
  if (railsLoggedInUser(input.context) === null) throw new HandBackToRails();
  const asJson = requestFormat(input.request) === "json";
  let refused: SellerContext | null = null;
  const redirected = await sellerGuard(
    {
      context: input.context,
      config: domainConfig(process.env),
      url: input.url,
      params: input.routeParams,
      urlOptions: input.urlOptions,
    },
    async (context) => {
      try {
        await authorization(context);
      } catch (error) {
        if (asJson && error instanceof NotAuthorizedError) {
          refused = context;
          return;
        }
        throw error;
      }
    },
  );
  if (refused !== null) return { ...json({ success: false, error: notAllowedMessage(refused) }, 401), rescued: true };
  return redirected;
}

export function jsonAction(
  incoming: Request,
  routeParams: Record<string, string>,
  options: ActionOptions,
  run: (input: MutationInput) => Promise<ActionResult>,
): Promise<Response> {
  return processAction(incoming, options, async ({ request, context, peekState, chain }) => {
    const config = domainConfig(process.env);
    const url = new URL(
      `${request.path}${request.queryString === "" ? "" : `?${request.queryString}`}`,
      `${request.protocol}${request.hostWithPort}`,
    );
    const rawBody = new Uint8Array();
    const params = requestParams(url, null, rawBody);
    return run({
      request,
      context,
      peekState,
      chain,
      url,
      urlOptions: defaultUrlOptions(url, config),
      routeParams,
      params,
      rawBody,
    });
  });
}
