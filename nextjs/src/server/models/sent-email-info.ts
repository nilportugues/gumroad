// Port of app/models/sent_email_info.rb. Not ported: mailer_key_digest and the two methods on it
// (mailer_exists?, ensure_mailer_uniqueness), which hash Ruby's Array#to_s of arbitrary mailer
// arguments; see models/README.md.
import { Prisma, type SentEmailInfo } from "@prisma/client";

import { defineModel } from "./runtime/define-model.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";
import { isRecordNotUnique, selectRows, table, column } from "./sql.ts";

export const SENT_EMAIL_INFOS = "sent_email_infos";

export const SentEmailInfos = defineModel<SentEmailInfo>({
  rubyClass: "SentEmailInfo",
  prismaModel: "SentEmailInfo",
  delegate: (tx) => tx.sentEmailInfo as never,
  validations: [validatesPresenceOf<SentEmailInfo>(["key"])],
});

// `SentEmailInfo.key_exists?(key)`
export async function sentEmailKeyExists(key: string): Promise<boolean> {
  const rows = await selectRows(Prisma.sql`SELECT 1 AS one FROM ${table(SENT_EMAIL_INFOS)} WHERE ${column(SENT_EMAIL_INFOS, "key")} = ${key} LIMIT 1`);
  return rows.length > 0;
}

// `SentEmailInfo.set_key!(key)`: true once saved, nil (null) when the key already exists.
export async function setSentEmailKey(key: string): Promise<true | null> {
  try {
    await SentEmailInfos.saveBang(SentEmailInfos.build({ key }));
    return true;
  } catch (error) {
    if (isRecordNotUnique(error)) return null;
    throw error;
  }
}
