// app/models/device.rb: a phone's push token, registered by the mobile apps (Api::Mobile::DevicesController#create).
import type { Device } from "@prisma/client";

import { defineModel, type Callback } from "./runtime/define-model.ts";
import { validatesInclusionOf, validatesPresenceOf } from "./runtime/validators.ts";

export const DEVICE_TYPES = ["ios", "android"];
export const APP_TYPES = ["consumer", "creator"];

const validations: Callback<Device>[] = [
  validatesPresenceOf<Device>(["token"]),
  validatesPresenceOf<Device>(["device_type"]),
  validatesInclusionOf<Device>(["device_type"], { in: DEVICE_TYPES }),
  validatesPresenceOf<Device>(["app_type"]),
  validatesInclusionOf<Device>(["app_type"], { in: APP_TYPES }),
];

export const Devices = defineModel<Device>({
  rubyClass: "Device",
  prismaModel: "Device",
  delegate: (tx) => tx.device as never,
  validations,
  beforeSave: [
    {
      // Device.where(token:, device_type:).where.not(id:).destroy_all: a phone token belongs to one user.
      name: "delete_token_if_already_linked_with_other_user",
      async run(record, { tx }) {
        const token = record.get("token");
        if (token === null || token === undefined || token === "") return;
        const id = record.get("id");
        await tx.device.deleteMany({ where: { token, device_type: record.get("device_type"), ...(id === undefined || id === null ? {} : { NOT: { id } }) } });
      },
    },
  ],
});
