// app/models/consumption_event.rb, for ConsumptionEvent.create_event! (the mobile apps report what a buyer watched, read or downloaded).
import type { ConsumptionEvent } from "@prisma/client";

import { setJsonDataForAttr } from "./concerns/json-data.ts";
import { defineModel, type Callback } from "./runtime/define-model.ts";
import { validatesInclusionOf, validatesPresenceOf } from "./runtime/validators.ts";

export const EVENT_TYPES = ["download", "download_all", "folder_download", "listen", "read", "view", "watch"];
// Platform.all
export const PLATFORMS = ["web", "iphone", "android", "other"];
const EVENT_TYPE_FOLDER_DOWNLOAD = "folder_download";

// attr_json_data_accessor :folder_id and :ip_address live in json_data, which is not a Prisma field of the create.
type Attributes = Partial<ConsumptionEvent> & { folder_id?: string | null; ip_address?: string | null };

const validations: Callback<ConsumptionEvent>[] = [
  validatesPresenceOf<ConsumptionEvent>(["url_redirect_id"]),
  validatesInclusionOf<ConsumptionEvent>(["event_type"], { in: EVENT_TYPES }),
  validatesInclusionOf<ConsumptionEvent>(["platform"], { in: PLATFORMS }),
];

export const ConsumptionEvents = defineModel<ConsumptionEvent>({
  rubyClass: "ConsumptionEvent",
  prismaModel: "ConsumptionEvent",
  delegate: (tx) => tx.consumptionEvent as never,
  validations,
});

export type CreateEventAttributes = {
  event_type: string;
  platform: string;
  url_redirect_id: bigint;
  product_file_id: bigint | null;
  purchase_id: bigint | null;
  product_id: bigint | null;
  folder_id?: string | null;
  consumed_at: Date;
  ip_address: string;
};

// ConsumptionEvent.create_event!: the keyword order is the order the attributes are assigned in.
export async function createEventBang(attributes: CreateEventAttributes, now: () => Date = () => new Date()): Promise<void> {
  if (attributes.event_type === EVENT_TYPE_FOLDER_DOWNLOAD) throw new Error("folder downloads are not created from Node");
  const { product_id, folder_id = null, ip_address, ...columns } = attributes;
  const record = ConsumptionEvents.build({ ...columns, link_id: product_id } as Attributes as never);
  setJsonDataForAttr(record, "folder_id", folder_id);
  setJsonDataForAttr(record, "ip_address", ip_address);
  await ConsumptionEvents.saveBang(record, { now });
}
