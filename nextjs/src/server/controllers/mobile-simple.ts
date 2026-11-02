// The small endpoints of Api::Mobile: feature flags, device tokens, a seller's call and license edits, the review video moderation
// and the media location the player reports (Api::Mobile::{FeatureFlags,Devices,Calls,Licenses,ReviewVideos,MediaLocations}Controller).
import { Prisma, type Call, type Device } from "@prisma/client";

import { decrypt } from "../../lib/obfuscate-ids.ts";
import { isFeatureEnabled, UnsupportedFlipperGateError, userActor } from "../infra/flipper.ts";
import { Calls } from "../models/call.ts";
import { Devices } from "../models/device.ts";
import { disableBang, enableBang, findLicense } from "../models/license.ts";
import { findAliveVideo, setApprovalStatusBang } from "../models/product-review-video.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { RecordInvalid } from "../models/runtime/errors.ts";
import { NotPortedError } from "../models/user.ts";
import { HandBackToRails } from "./application-controller.ts";
import { fetchError, registerMobile, renderJson, UNPROCESSABLE_ENTITY, type MobileAuth, type MobileInput } from "./mobile-api.ts";
import { recordMediaLocation } from "./media-locations.ts";
import { createEventBang, EVENT_TYPES, PLATFORMS } from "../models/consumption-event.ts";
import { truncateToSeconds } from "../models/concerns/ruby-time.ts";
import { remoteIp } from "../page-props/audience/events.ts";
import { RoutingError } from "./application-controller.ts";

const MOBILE_API_SCOPES = ["mobile_api"];
const CREATED = 201;

const owner = (auth: MobileAuth | null) => auth!.owner;
const externalId = (value: unknown): bigint | null => {
  if (typeof value !== "string") return null;
  const id = decrypt(value);
  return id === null ? null : BigInt(id);
};

// ActiveModel::Type::Boolean.new.cast
const FALSE_VALUES = new Set(["0", "f", "F", "false", "FALSE", "off", "OFF"]);
function castBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return !FALSE_VALUES.has(value);
  throw new HandBackToRails("a boolean parameter that is not a scalar");
}

// Api::Mobile::FeatureFlagsController#show
async function showFeatureFlag(input: MobileInput, auth: MobileAuth | null) {
  const name = input.params.id;
  if (typeof name !== "string") throw new HandBackToRails("a feature name that is not a string");
  try {
    return renderJson({ enabled_for_user: await isFeatureEnabled(name, userActor(owner(auth).id)) });
  } catch (error) {
    if (error instanceof UnsupportedFlipperGateError) throw new HandBackToRails(error.message);
    throw error;
  }
}

// DevicesController#device_params: `params.require(:device).permit(:token, :device_type, :app_type, :app_version)`. Only scalars pass permit.
function devicePermitted(params: MobileInput["params"]): Partial<Device> {
  const device = params.device;
  if (device === null || typeof device !== "object" || Array.isArray(device) || Object.keys(device).length === 0) throw new HandBackToRails("a request without a device");
  const permitted: Partial<Device> = {};
  for (const key of ["token", "device_type", "app_type", "app_version"] as const) {
    const value = (device as Record<string, unknown>)[key];
    if (value === undefined || (typeof value === "object" && value !== null)) continue;
    permitted[key] = value === null ? (null as never) : String(value);
  }
  return permitted;
}

async function createDevice(input: MobileInput, auth: MobileAuth | null) {
  // (impersonated_user || account_holder).devices.build(device_params)
  const user = auth!.impersonated ?? auth!.accountHolder;
  const record = Devices.build({ ...devicePermitted(input.params), user_id: Number(user.id) } as never);
  const saved = await Devices.save(record);
  return saved ? renderJson({ success: true }, CREATED) : renderJson({ success: false }, UNPROCESSABLE_ENTITY);
}

async function updateCall(input: MobileInput, auth: MobileAuth | null) {
  const id = externalId(input.params.id);
  const [row] = id === null ? [] : await selectRows(Prisma.sql`SELECT ${Prisma.raw("`calls`.*")} FROM ${table("calls")} WHERE ${column("calls", "id")} = ${id} LIMIT 1`);
  const call = row ? Calls.load(castRow<Call>("Call", row)) : null;
  const purchaseId = call?.get("purchase_id");
  const [purchase] = purchaseId == null ? [] : await selectRows<{ seller_id: bigint | null }>(Prisma.sql`SELECT ${column("purchases", "seller_id")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${purchaseId} LIMIT 1`);
  if (call === null || !purchase || purchase.seller_id !== owner(auth).id) return fetchError("Could not find call");

  const url = input.params.call_url;
  if (url !== undefined && url !== null && typeof url !== "string") throw new HandBackToRails("a call_url that is not a string");
  try {
    await Calls.updateBang(call, { call_url: url ?? null });
  } catch (error) {
    // Validations run before the first statement, so Rails can take the request whole.
    if (error instanceof RecordInvalid) throw new NotPortedError("Call#update!", "a call that no longer validates");
    throw error;
  }
  return renderJson({ success: true });
}

async function updateLicense(input: MobileInput, auth: MobileAuth | null) {
  const id = externalId(input.params.id);
  const license = id === null ? null : await findLicense(id);
  const purchaseId = license?.get("purchase_id");
  const [purchase] = purchaseId == null ? [] : await selectRows<{ seller_id: bigint | null }>(Prisma.sql`SELECT ${column("purchases", "seller_id")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${purchaseId} LIMIT 1`);
  if (license === null || !purchase || purchase.seller_id !== owner(auth).id) return fetchError("Could not find license");

  if (castBoolean(input.params.enabled) === true) await enableBang(license);
  else await disableBang(license);
  return renderJson({ success: true });
}

const reviewVideoAction = (status: "approved" | "rejected") => async (input: MobileInput, auth: MobileAuth | null) => {
  const id = externalId(input.params.id);
  const video = id === null ? null : await findAliveVideo(id);
  const [seller] =
    video === null
      ? []
      : await selectRows<{ seller_id: bigint | null }>(
          Prisma.sql`SELECT ${column("purchases", "seller_id")} FROM ${table("product_reviews")} INNER JOIN ${table("purchases")} ON ${column("purchases", "id")} = ${column("product_reviews", "purchase_id")} WHERE ${column("product_reviews", "id")} = ${video.get("product_review_id")} LIMIT 1`,
        );
  if (video === null || !seller || seller.seller_id !== owner(auth).id) return fetchError("Could not find review video");
  try {
    await setApprovalStatusBang(video, status);
  } catch (error) {
    if (error instanceof RecordInvalid) throw new NotPortedError("ProductReviewVideo#update!", "a video that no longer validates");
    throw error;
  }
  return renderJson({ success: true });
};

// Api::Mobile::MediaLocationsController#create (the RecordMediaLocation concern the web player shares)
async function createMediaLocation(input: MobileInput) {
  return renderJson({ success: await recordMediaLocation(input.params) });
}

const present = (value: unknown): boolean => value !== undefined && value !== null && value !== "" && value !== false && !(typeof value === "string" && value.trim() === "");

// ISO 8601 with an explicit offset: the one shape `Time.zone.parse` reads the same as Date
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;

// CreateConsumptionEvent#create_consumption_event!
async function createConsumptionEvent(input: MobileInput) {
  const { params } = input;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  if (!present(params.url_redirect_id)) return renderJson({ success: false });
  const eventType = text(params.event_type);
  if (eventType === null && params.event_type !== undefined && params.event_type !== null) throw new HandBackToRails("an event_type that is not a string");
  if (eventType === null || !EVENT_TYPES.includes(eventType)) return renderJson({ success: false });
  const platform = text(params.platform);
  if (platform === null && params.platform !== undefined && params.platform !== null) throw new HandBackToRails("a platform that is not a string");
  if (platform === null || !PLATFORMS.includes(platform)) return renderJson({ success: false });

  const urlRedirectParam = text(params.url_redirect_id);
  if (urlRedirectParam === null) throw new HandBackToRails("a url_redirect_id that is not a string");
  const urlRedirectId = externalId(urlRedirectParam);
  if (urlRedirectId === null) return renderJson({ success: false });
  for (const name of ["product_file_id", "purchase_id", "consumed_at"]) if (present(params[name]) && typeof params[name] !== "string") throw new HandBackToRails(`a ${name} that is not a string`);
  if (eventType === "folder_download") throw new HandBackToRails("a folder download event");
  const productFileId = present(params.product_file_id) ? externalId(params.product_file_id) : null;
  let purchaseId: bigint | null;
  if (present(params.purchase_id)) purchaseId = externalId(params.purchase_id);
  else {
    const [redirect] = await selectRows<{ purchase_id: bigint | null }>(Prisma.sql`SELECT ${column("url_redirects", "purchase_id")} FROM ${table("url_redirects")} WHERE ${column("url_redirects", "id")} = ${urlRedirectId} LIMIT 1`);
    if (!redirect) throw new RoutingError("Couldn't find UrlRedirect");
    purchaseId = redirect.purchase_id;
  }
  const [purchase] = purchaseId === null ? [] : await selectRows<{ link_id: bigint | null }>(Prisma.sql`SELECT ${column("purchases", "link_id")} FROM ${table("purchases")} WHERE ${column("purchases", "id")} = ${purchaseId} LIMIT 1`);
  if (present(params.consumed_at) && !ISO_WITH_ZONE.test(params.consumed_at as string)) throw new HandBackToRails("a consumed_at Node does not parse");
  const consumedAt = truncateToSeconds(present(params.consumed_at) ? new Date(params.consumed_at as string) : new Date());

  await createEventBang({
    event_type: eventType,
    platform,
    url_redirect_id: urlRedirectId,
    product_file_id: productFileId,
    purchase_id: purchaseId,
    product_id: purchase?.link_id ?? null,
    consumed_at: consumedAt,
    ip_address: remoteIp(input.request.headers) ?? "127.0.0.1",
  });
  return renderJson({ success: true });
}

registerMobile(
  { method: "POST", pattern: "/mobile/consumption_analytics", scopes: MOBILE_API_SCOPES, run: createConsumptionEvent },
  { method: "GET", pattern: "/mobile/feature_flags/:id", scopes: MOBILE_API_SCOPES, run: showFeatureFlag },
  { method: "POST", pattern: "/mobile/devices", scopes: ["creator_api", "mobile_api"], run: createDevice },
  ...["PUT", "PATCH"].flatMap((method) => [
    { method, pattern: "/mobile/calls/:id", scopes: MOBILE_API_SCOPES, run: updateCall },
    { method, pattern: "/mobile/licenses/:id", scopes: MOBILE_API_SCOPES, run: updateLicense },
  ]),
  { method: "POST", pattern: "/mobile/review_videos/:id/approve", scopes: MOBILE_API_SCOPES, run: reviewVideoAction("approved") },
  { method: "POST", pattern: "/mobile/review_videos/:id/reject", scopes: MOBILE_API_SCOPES, run: reviewVideoAction("rejected") },
  { method: "POST", pattern: "/mobile/media_locations", scopes: MOBILE_API_SCOPES, run: createMediaLocation },
);
