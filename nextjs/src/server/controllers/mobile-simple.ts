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

registerMobile(
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
