// ForeignWebhooksController (app/controllers/foreign_webhooks_controller.rb): the callbacks Stripe, PayPal, SendGrid, Resend and AWS SNS post.
// Each verifies its sender, then queues the job that does the work.
//
// Rails parses a JSON body into `params` (and wraps it under `foreign_webhook`) before any filter runs, so a JSON content type whose body
// does not parse, or that has a shape Rails would munge, goes to Rails whole. So does everything the port cannot reproduce byte for
// byte: a number JS would write differently, a verification answer Ruby raises on.
import { getConfig } from "../infra/config.ts";
import { notifyError } from "../infra/error-reporting.ts";
import { isFeatureEnabled } from "../infra/flipper.ts";
import { performAsync } from "../models/concerns/job-runtime.ts";
import { resendEventIsTrackable, resendSignatureIsValid, sendgridSignatureError } from "../webhooks/email-webhooks.ts";
import { assertKeyOrderSurvives, assertPlainIntegers, isBlank } from "../webhooks/json-guards.ts";
import { isRedisFailure, paypalEventDelaySeconds, paypalWebhookIsValid } from "../webhooks/paypal-webhook.ts";
import { snsNotificationIsAuthentic } from "../webhooks/sns-verifier.ts";
import { SignatureVerificationError, verifyStripeHeader } from "../webhooks/stripe-signature.ts";

import { HandBackToRails, RoutingError, type ActionResult, type Rendered } from "./application-controller.ts";
import { jsonResponse } from "./json-seller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { assertMunged, parseNestedQuery, type Params } from "./rails-body.ts";

const CONTROLLER = "foreign_webhooks";
const SNS_MEDIACONVERT_DELAY_SECONDS = 5;
// ActionController::ParamsWrapper::EXCLUDE_PARAMETERS
const WRAPPER_EXCLUDED_KEYS = ["authenticity_token", "_method", "utf8"];
const WRAPPER_KEY = "foreign_webhook";

// A filter that rendered: the action and the after_actions (XSRF-TOKEN) did not run.
const halt = (body: unknown, status: number): ActionResult => ({ ...jsonResponse(body, status, true), rescued: true });
const head = (status: number): Rendered => ({ status, body: "", contentType: "text/html", paramsRead: true });
const success = (value: boolean): ActionResult => jsonResponse({ success: value }, 200, true);

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const utf8 = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HandBackToRails("a webhook body that is not UTF-8");
  }
};
const mediaType = (input: MutationInput): string =>
  (input.request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();

// rescue_from(*REDIS_TRANSPORT_ERRORS): the sender redelivers on a 503, so an event is never acknowledged and dropped.
async function rescuingRedis(action: string, run: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await run();
  } catch (error) {
    if (!isRedisFailure(error)) throw error;
    notifyError(error, { action });
    return { ...head(503), rescued: true };
  }
}

type Body = { text: string; json: unknown };

// What ParamsWrapper and the JSON params parser do to a JSON body before the filters. Returns the parsed body, or null when the content type is not JSON.
function jsonBody(input: MutationInput): Body | null {
  const type = mediaType(input);
  // Mime[:json] also answers to text/x-json and application/jsonrequest, which are not modelled.
  if (type === "text/x-json" || type === "application/jsonrequest")
    throw new HandBackToRails("a JSON content type Node does not model");
  if (type !== "application/json") return null;
  if (input.request.queryString !== "") throw new HandBackToRails("a webhook with a query string");
  const text = utf8(input.rawBody);
  let parsed: unknown;
  try {
    parsed = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new HandBackToRails("an invalid JSON body");
  }
  if (!isObject(parsed) && !Array.isArray(parsed))
    throw new HandBackToRails("a JSON body that is neither an object nor a list");
  assertMunged(parsed);
  assertKeyOrderSurvives(parsed);
  return { text, json: parsed };
}

// `params.to_unsafe_hash.to_hash` of a webhook: the body (a list is filed under `_json`), the path parameters, and the wrapper.
function paramsOf(action: string, body: Body): Params {
  assertPlainIntegers(body.text);
  const requestParameters: Params = Array.isArray(body.json) ? { _json: body.json } : { ...(body.json as Params) };
  if (WRAPPER_EXCLUDED_KEYS.some((key) => key in requestParameters))
    throw new HandBackToRails("a webhook body with a key ParamsWrapper excludes");
  const params: Params = { ...requestParameters, controller: CONTROLLER, action };
  if (!(WRAPPER_KEY in params)) params[WRAPPER_KEY] = { ...requestParameters };
  return params;
}

// ---- Stripe ----

function constructStripeEvent(input: MutationInput, secretName: string): Record<string, unknown> | ActionResult {
  jsonBody(input);
  const bad = halt({ success: false }, 400);
  let event: unknown;
  try {
    verifyStripeHeader(input.rawBody, input.request.headers.get("stripe-signature"), getConfig(secretName));
    const text = utf8(input.rawBody);
    try {
      event = JSON.parse(text);
    } catch {
      return bad;
    }
    assertPlainIntegers(text);
  } catch (error) {
    if (error instanceof SignatureVerificationError) return bad;
    throw error;
  }
  // Event.construct_from(data) on anything but a Hash raises.
  if (!isObject(event)) throw new HandBackToRails("a Stripe event that is not an object");
  assertKeyOrderSurvives(event);
  return event;
}

const isActionResult = (value: Record<string, unknown> | ActionResult): value is ActionResult =>
  "status" in value && "contentType" in value;

// `if @stripe_event["id"]` / `.present?` on a StripeObject's values, which an object or list would make a StripeObject or Array to ask empty? of.
const present = (value: unknown): boolean => {
  if (isObject(value) || Array.isArray(value))
    throw new HandBackToRails("a Stripe event field that is an object or a list");
  return !isBlank(value);
};

async function stripe(input: MutationInput): Promise<ActionResult> {
  const event = constructStripeEvent(input, "STRIPE__ENDPOINT_SECRET");
  if (isActionResult(event)) return event;
  const id = event.id;
  if (id === undefined || id === null || id === false) return success(false);
  return rescuingRedis("stripe", async () => {
    await performAsync("HandleStripeEventWorker", [event as never]);
    return success(true);
  });
}

async function stripeConnect(input: MutationInput): Promise<ActionResult> {
  const event = constructStripeEvent(input, "STRIPE_CONNECT__ENDPOINT_SECRET");
  if (isActionResult(event)) return event;
  if (!(present(event.id) && (present(event.account) || present(event.user_id)))) return success(false);
  return rescuingRedis("stripe_connect", async () => {
    await performAsync("HandleStripeEventWorker", [event as never]);
    return success(true);
  });
}

// ---- PayPal ----

async function paypal(input: MutationInput): Promise<ActionResult> {
  let params: Params;
  const body = jsonBody(input);
  if (body !== null) {
    if (!isObject(body.json)) throw new HandBackToRails("a PayPal webhook whose JSON body is a list");
    params = paramsOf("paypal", body);
  } else if (mediaType(input) === "application/x-www-form-urlencoded") {
    params = {
      ...parseNestedQuery(input.request.queryString),
      ...parseNestedQuery(utf8(input.rawBody)),
      controller: CONTROLLER,
      action: "paypal",
    };
  } else {
    throw new HandBackToRails("a PayPal webhook with a body Node does not parse");
  }
  const withoutPathKeys = new Set(["controller", "action", "format", WRAPPER_KEY]);
  const payload: Params = Object.fromEntries(Object.entries(params).filter(([key]) => !withoutPathKeys.has(key)));

  return rescuingRedis("paypal", async () => {
    if (!isBlank(payload.event_type)) {
      const valid = await paypalWebhookIsValid({
        headers: input.request.headers,
        rawBody: utf8(input.rawBody),
        fallbackPayload: payload,
      });
      if (!valid) return { ...jsonResponse({ success: false }, 400, true) };
    }
    const delaySeconds = paypalEventDelaySeconds(payload.event_type);
    await performAsync(
      "HandlePaypalEventWorker",
      [payload as never],
      delaySeconds === null ? undefined : { delaySeconds },
    );
    return success(true);
  });
}

// ---- SendGrid ----

async function sendgrid(input: MutationInput): Promise<ActionResult> {
  const body = jsonBody(input);
  if (body === null) throw new HandBackToRails("a SendGrid webhook that is not JSON");
  return rescuingRedis("sendgrid", async () => {
    const error = sendgridSignatureError(input.rawBody, input.request.headers);
    if (error !== null) {
      console.warn(`SendGrid webhook verification failed: ${error}`);
      if (await isFeatureEnabled("verify_sendgrid_webhook_signatures")) {
        notifyError(`Error verifying SendGrid webhook: ${error}`);
        return halt({ success: false }, 500);
      }
    }
    await performAsync("HandleSendgridEventJob", [paramsOf("sendgrid", body) as never]);
    return success(true);
  });
}

// ---- Resend ----

async function resend(input: MutationInput): Promise<ActionResult> {
  const body = jsonBody(input);
  if (body === null) throw new HandBackToRails("a Resend webhook that is not JSON");
  if (!resendSignatureIsValid(input.rawBody, input.request.headers)) {
    notifyError("Error verifying Resend webhook");
    return halt({ success: false }, 400);
  }
  if (!isObject(body.json)) throw new HandBackToRails("a Resend webhook whose JSON body is a list");
  const eventJson = paramsOf("resend", body);
  return rescuingRedis("resend", async () => {
    if (resendEventIsTrackable(eventJson)) await performAsync("HandleResendEventJob", [eventJson as never]);
    return success(true);
  });
}

// ---- AWS SNS ----

// validate_sns_webhook, then the action's own JSON.parse of the same body.
async function snsNotification(input: MutationInput): Promise<{ notification: unknown } | ActionResult> {
  jsonBody(input);
  const text = utf8(input.rawBody);
  if (!(await snsNotificationIsAuthentic(text))) return halt({ success: false }, 400);
  assertPlainIntegers(text);
  const notification = JSON.parse(text) as unknown;
  assertKeyOrderSurvives(notification);
  return { notification };
}

const isNotification = (value: { notification: unknown } | ActionResult): value is { notification: unknown } =>
  "notification" in value;

async function mediaconvert(input: MutationInput): Promise<ActionResult> {
  const checked = await snsNotification(input);
  if (!isNotification(checked)) return checked;
  return rescuingRedis("mediaconvert", async () => {
    await performAsync("HandleSnsMediaconvertEventWorker", [checked.notification as never], {
      delaySeconds: SNS_MEDIACONVERT_DELAY_SECONDS,
    });
    return head(200);
  });
}

async function snsAwsConfig(input: MutationInput): Promise<ActionResult> {
  const checked = await snsNotification(input);
  if (!isNotification(checked)) return checked;
  return rescuingRedis("sns_aws_config", async () => {
    await performAsync("HandleSnsAwsConfigEventWorker", [checked.notification as never]);
    return head(200);
  });
}

// The route names an action the controller does not define.
async function grmc(): Promise<ActionResult> {
  throw new RoutingError("Not Found");
}

const webhook = { skipForgeryProtection: true, rawBody: true } as const;

registerMutations(
  { method: "POST", pattern: "/stripe-webhook", ...webhook, run: stripe },
  { method: "POST", pattern: "/stripe-connect-webhook", ...webhook, run: stripeConnect },
  { method: "POST", pattern: "/paypal-webhook", ...webhook, run: paypal },
  { method: "POST", pattern: "/sendgrid-webhook", ...webhook, run: sendgrid },
  { method: "POST", pattern: "/sns-mediaconvert-webhook", ...webhook, run: mediaconvert },
  { method: "POST", pattern: "/sns-aws-config-webhook", ...webhook, run: snsAwsConfig },
  { method: "POST", pattern: "/grmc-webhook", ...webhook, run: grmc },
  { method: "POST", pattern: "/resend-webhook", ...webhook, run: resend },
);
