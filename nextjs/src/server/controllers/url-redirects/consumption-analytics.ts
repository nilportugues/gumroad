// CreateConsumptionEvent#create_consumption_event! (app/controllers/concerns/create_consumption_event.rb), shared by
// POST /consumption_analytics and the mobile API's POST /mobile/consumption_analytics.
import { Prisma } from "@prisma/client";

import { decrypt } from "../../../lib/obfuscate-ids.ts";
import { truncateToSeconds } from "../../models/concerns/ruby-time.ts";
import { createEventBang, EVENT_TYPES, PLATFORMS } from "../../models/consumption-event.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { remoteIp } from "../../page-props/audience/events.ts";
import { HandBackToRails, RoutingError } from "../application-controller.ts";
import { isPresent } from "../rails-request.ts";

const present = (value: unknown) => value !== undefined && value !== null && value !== "" && value !== false && !(typeof value === "string" && !isPresent(value));
const text = (value: unknown) => (typeof value === "string" ? value : null);
const externalId = (value: string): bigint | null => {
  const id = decrypt(value);
  return id === null ? null : BigInt(id);
};

// ISO 8601 with an explicit offset: the one shape `Time.zone.parse` reads the same as Date
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;
const LOCAL_ADDRESS = "127.0.0.1";

export async function recordConsumptionEvent(params: Record<string, unknown>, headers: Headers): Promise<boolean> {
  if (!present(params.url_redirect_id)) return false;
  const eventType = text(params.event_type);
  if (eventType === null && params.event_type !== undefined && params.event_type !== null) throw new HandBackToRails("an event_type that is not a string");
  if (eventType === null || !EVENT_TYPES.includes(eventType)) return false;
  const platform = text(params.platform);
  if (platform === null && params.platform !== undefined && params.platform !== null) throw new HandBackToRails("a platform that is not a string");
  if (platform === null || !PLATFORMS.includes(platform)) return false;

  const urlRedirectParam = text(params.url_redirect_id);
  if (urlRedirectParam === null) throw new HandBackToRails("a url_redirect_id that is not a string");
  const urlRedirectId = externalId(urlRedirectParam);
  if (urlRedirectId === null) return false;
  for (const name of ["product_file_id", "purchase_id", "consumed_at"]) if (present(params[name]) && typeof params[name] !== "string") throw new HandBackToRails(`a ${name} that is not a string`);
  if (eventType === "folder_download") throw new HandBackToRails("a folder download event");
  const productFileId = present(params.product_file_id) ? externalId(params.product_file_id as string) : null;
  let purchaseId: bigint | null;
  if (present(params.purchase_id)) purchaseId = externalId(params.purchase_id as string);
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
    ip_address: remoteIp(headers) ?? LOCAL_ADDRESS,
  });
  return true;
}
