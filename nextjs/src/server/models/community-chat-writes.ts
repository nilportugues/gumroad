// The writes of Communities::ChatMessagesController, Communities::LastReadChatMessagesController and
// Communities::NotificationSettingsController: CommunityChatMessage (presence and length of `content`, soft deletion),
// LastReadCommunityChatMessage.set! and the per-seller CommunityNotificationSetting. None of the three has PaperTrail or
// callbacks that enqueue work.
import {
  Prisma,
  type CommunityChatMessage,
  type CommunityNotificationSetting,
  type LastReadCommunityChatMessage,
} from "@prisma/client";

import { deletable } from "./concerns/deletable.ts";
import { defineModel } from "./runtime/define-model.ts";
import { RecordNotFound } from "./runtime/errors.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { validatesLengthOf, validatesPresenceOf, validatesUniquenessOf } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

// CommunityChatMessage validates :content, length: { minimum: 1, maximum: 20_000 }
const MAX_CONTENT_LENGTH = 20_000;

export const CommunityChatMessages = defineModel<CommunityChatMessage>({
  rubyClass: "CommunityChatMessage",
  prismaModel: "CommunityChatMessage",
  delegate: (tx) => tx.communityChatMessage as never,
  validations: [
    validatesPresenceOf(["content"]),
    validatesLengthOf(["content"], { minimum: 1, maximum: MAX_CONTENT_LENGTH }),
  ],
});

const messageDeletion = deletable(CommunityChatMessages);
export const markMessageDeletedBang = (record: ModelRecord<CommunityChatMessage>) =>
  messageDeletion.markDeletedBang(record);

export const LastReadMessages = defineModel<LastReadCommunityChatMessage>({
  rubyClass: "LastReadCommunityChatMessage",
  prismaModel: "LastReadCommunityChatMessage",
  delegate: (tx) => tx.lastReadCommunityChatMessage as never,
  validations: [
    validatesUniquenessOf<LastReadCommunityChatMessage>("last_read_community_chat_messages", ["user_id"], {
      scope: ["community_id"],
    }),
  ],
});

export const CommunityNotificationSettings = defineModel<CommunityNotificationSetting>({
  rubyClass: "CommunityNotificationSetting",
  prismaModel: "CommunityNotificationSetting",
  delegate: (tx) => tx.communityNotificationSetting as never,
  validations: [
    validatesUniquenessOf<CommunityNotificationSetting>("community_notification_settings", ["user_id"], {
      scope: ["seller_id"],
    }),
  ],
});

// CommunityNotificationSetting.recap_frequencies
export const RECAP_FREQUENCIES = ["daily", "weekly"];

const find = async <R extends Record<string, unknown>>(
  model: Prisma.ModelName,
  tableName: string,
  where: Record<string, bigint>,
): Promise<R | null> => {
  const conditions = Object.entries(where).map(([name, value]) => Prisma.sql`${column(tableName, name)} = ${value}`);
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw(`\`${tableName}\`.*`)} FROM ${table(tableName)} WHERE ${Prisma.join(conditions, " AND ")} LIMIT 1`,
  );
  return row ? castRow<R>(model, row) : null;
};

export const findMessage = (communityId: bigint, id: bigint) =>
  find<CommunityChatMessage>("CommunityChatMessage", "community_chat_messages", { id, community_id: communityId });

// LastReadCommunityChatMessage.set!
export async function setLastRead(userId: bigint, communityId: bigint, messageId: bigint): Promise<void> {
  const message = await findMessage(communityId, messageId);
  if (!message) throw new RecordNotFound("Couldn't find CommunityChatMessage");
  let row = await find<LastReadCommunityChatMessage>(
    "LastReadCommunityChatMessage",
    "last_read_community_chat_messages",
    { user_id: userId, community_id: communityId },
  );
  if (!row) {
    const created = await LastReadMessages.createBang({
      user_id: userId,
      community_id: communityId,
      community_chat_message_id: message.id,
    });
    row = created.attributes as LastReadCommunityChatMessage;
  }
  const record = LastReadMessages.load(row);
  await LastReadMessages.withLock(record, async () => {
    const current = await find<CommunityChatMessage>("CommunityChatMessage", "community_chat_messages", {
      id: record.get("community_chat_message_id"),
    });
    if (current!.created_at.getTime() < message.created_at.getTime())
      await LastReadMessages.updateBang(record, { community_chat_message_id: message.id });
  });
}

// current_seller.community_notification_settings.find_or_initialize_by(seller:), then update!(recap_frequency:)
export async function saveNotificationSetting(
  userId: bigint,
  sellerId: bigint,
  attributes: { recap_frequency?: string | null },
): Promise<void> {
  const row = await find<CommunityNotificationSetting>(
    "CommunityNotificationSetting",
    "community_notification_settings",
    { user_id: userId, seller_id: sellerId },
  );
  if (row) await CommunityNotificationSettings.updateBang(CommunityNotificationSettings.load(row), attributes);
  else await CommunityNotificationSettings.createBang({ user_id: userId, seller_id: sellerId, ...attributes });
}
