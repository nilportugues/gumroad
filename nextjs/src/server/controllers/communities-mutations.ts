// Communities::ChatMessagesController, Communities::LastReadChatMessagesController and Communities::NotificationSettingsController.
// All three are ApplicationController actions (authenticate_user!, `set_community`, Pundit) that redirect back to the community page.
import { Prisma, type Community, type CommunityChatMessage, type User } from "@prisma/client";

import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";

import { assertCanBroadcast, broadcastToCommunity } from "../infra/anycable.ts";
import {
  CommunityChatMessages,
  findMessage,
  markMessageDeletedBang,
  RECAP_FREQUENCIES,
  saveNotificationSetting,
  setLastRead,
} from "../models/community-chat-writes.ts";
import { accessibleCommunitiesIds } from "../models/community.ts";
import { RecordNotFound } from "../models/runtime/errors.ts";
import type { ModelRecord } from "../models/runtime/record.ts";
import { castRow, column, selectRows, table } from "../models/sql.ts";
import { NotPortedError } from "../models/user.ts";
import { sellerGuard } from "../page-props/audience/seller-guard.ts";
import { iso8601 } from "../page-props/communities/communities.ts";
import { domainConfig } from "../page-props/domain.ts";
import { avatarUrl, displayName } from "../page-props/signed-in/presenters.ts";
import { authorize } from "../policies/authorize.ts";
import { NotAuthorizedError, type SellerContext } from "../policies/seller-context.ts";
import { RoutingError, type ActionResult } from "./application-controller.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const SEE_OTHER = 303;
const FOUND = 302;
// CommunityChannel::CREATE_CHAT_MESSAGE_TYPE and friends
const CREATE = "create_chat_message";
const UPDATE = "update_chat_message";
const DELETE = "delete_chat_message";

type Loaded = { community: Community; seller: User; message: ModelRecord<CommunityChatMessage> | null };

const first = async <R>(model: Prisma.ModelName, tableName: string, id: bigint | null, extra?: Prisma.Sql): Promise<R | null> => {
  if (id === null) return null;
  const [row] = await selectRows(Prisma.sql`SELECT ${Prisma.raw(`\`${tableName}\`.*`)} FROM ${table(tableName)} WHERE ${column(tableName, "id")} = ${id}${extra ? Prisma.sql` AND ${extra}` : Prisma.empty} LIMIT 1`);
  return row ? castRow(model, row as never) as R : null;
};

const idOf = (externalId: string): bigint | null => {
  const id = decrypt(externalId);
  return id === null ? null : BigInt(id);
};

// CommunityPolicy#show?
async function requireShow(context: SellerContext, community: Community): Promise<void> {
  const ids = await accessibleCommunitiesIds(context.user!);
  if (!ids.some((id) => BigInt(id) === community.id)) throw new NotAuthorizedError("not allowed to show?");
}

const communityLocation = (loaded: Loaded) => `/communities/${loaded.seller.external_id}/${encrypt(loaded.community.id)}`;
const toSentence = (messages: string[]) => (messages.length <= 2 ? messages.join(" and ") : `${messages.slice(0, -1).join(", ")}, and ${messages.at(-1)}`);

// permitted_params: `params.require(:community_chat_message).permit(:content)`. A missing or non-hash value is a 400 or 500 in Rails.
function chatParams(input: MutationInput): { content?: string } {
  const value = input.params.community_chat_message;
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) throw new NotPortedError("params.require(:community_chat_message)", "missing or not a hash");
  const content = (value as Record<string, unknown>).content;
  if (content === undefined || typeof content === "object") return {};
  if (typeof content !== "string") throw new NotPortedError("permit(:content)", "a non-string content");
  return { content };
}

// CommunityChatMessagePresenter#props
async function messageProps(message: ModelRecord<CommunityChatMessage>, loaded: Loaded, user: User) {
  return {
    id: encrypt(message.get("id")),
    community_id: encrypt(loaded.community.id),
    content: message.get("content"),
    created_at: iso8601(message.get("created_at")),
    updated_at: iso8601(message.get("updated_at")),
    user: { id: user.external_id ?? encrypt(user.id), name: displayName(user), avatar_url: await avatarUrl(user), is_seller: user.id === loaded.community.seller_id },
  };
}

function invalid(loaded: Loaded, message: ModelRecord<CommunityChatMessage>): ActionResult {
  const errors = message.errors;
  const attributes = [...new Set(errors.details.map((detail) => detail.attribute))];
  const inertiaErrors = Object.fromEntries(attributes.map((attribute) => [`community_chat_message.${attribute}`, toSentence(errors.on(attribute))]));
  return { status: FOUND, location: communityLocation(loaded), flash: { alert: toSentence(errors.fullMessages()) }, inertiaErrors };
}

// `Community.find_by_external_id!` (or `.alive.`) and its seller, `authorize @community, :show?`, then the message when the action has one.
async function guarded(input: MutationInput, steps: { alive?: boolean; withMessage?: boolean }, afterMessage?: (loaded: Loaded, context: SellerContext) => void): Promise<{ denied: ActionResult | null; loaded: Loaded | null }> {
  let loaded: Loaded | null = null;
  const denied = await sellerGuard(
    { context: input.context, config: domainConfig(process.env), url: input.url, params: input.routeParams, urlOptions: input.urlOptions },
    async (context) => {
      const community = await first<Community>("Community", "communities", idOf(input.routeParams.community_id!), steps.alive ? Prisma.sql`${column("communities", "deleted_at")} IS NULL` : undefined);
      if (!community) throw new RoutingError("Not Found");
      const seller = await first<User>("User", "users", community.seller_id);
      if (!seller) throw new TypeError("undefined method 'external_id' for nil");
      loaded = { community, seller, message: null };
      await requireShow(context, community);
      if (steps.withMessage) {
        const id = idOf(input.routeParams.id!);
        const row = id === null ? null : await findMessage(community.id, id);
        if (!row) throw new RoutingError("Not Found");
        loaded.message = CommunityChatMessages.load(row);
        afterMessage?.(loaded, context);
      }
    },
    { requireAccountEmail: false },
  );
  return { denied, loaded };
}

registerMutations(
  {
    method: "POST",
    pattern: "/communities/:community_id/chat_messages",
    railsOnly: "/ip/period:chat_messages",
    run: async (input) => {
      let params: { content?: string } = {};
      const { denied, loaded } = await guarded(input, {});
      if (!denied) params = chatParams(input);
      if (denied) return denied;
      assertCanBroadcast();
      const seller = input.context.currentSeller!;
      const message = CommunityChatMessages.build({ community_id: loaded!.community.id, user_id: seller.id, content: params.content ?? null } as never);
      try {
        await CommunityChatMessages.saveBang(message);
      } catch (error) {
        if ((error as Error).name !== "RecordInvalid") throw error;
        return invalid(loaded!, message);
      }
      await broadcastToCommunity(encrypt(loaded!.community.id), { type: CREATE, message: await messageProps(message, loaded!, seller) });
      return { status: SEE_OTHER, location: communityLocation(loaded!) };
    },
  },
  ...["PUT", "PATCH"].map((method) => ({
    method,
    pattern: "/communities/:community_id/chat_messages/:id",
    run: async (input: MutationInput): Promise<ActionResult> => {
      const { denied, loaded } = await guarded(input, { withMessage: true }, (found, context) => {
        // CommunityChatMessagePolicy#update?
        authorize(() => context.user!.id === found.message!.get("user_id"), context);
      });
      if (denied) return denied;
      const params = chatParams(input);
      assertCanBroadcast();
      const message = loaded!.message!;
      message.assign(params as never);
      try {
        await CommunityChatMessages.saveBang(message);
      } catch (error) {
        if ((error as Error).name !== "RecordInvalid") throw error;
        return invalid(loaded!, message);
      }
      const author = (await first<User>("User", "users", message.get("user_id")))!;
      await broadcastToCommunity(encrypt(loaded!.community.id), { type: UPDATE, message: await messageProps(message, loaded!, author) });
      return { status: SEE_OTHER, location: communityLocation(loaded!) };
    },
  })),
  {
    method: "DELETE",
    pattern: "/communities/:community_id/chat_messages/:id",
    run: async (input) => {
      const { denied, loaded } = await guarded(input, { withMessage: true }, (found, context) => {
        // CommunityChatMessagePolicy#destroy?
        authorize(() => context.user!.id === found.message!.get("user_id") || context.user!.id === found.community.seller_id, context);
      });
      if (denied) return denied;
      assertCanBroadcast();
      const message = loaded!.message!;
      await markMessageDeletedBang(message);
      const author = (await first<User>("User", "users", message.get("user_id")))!;
      await broadcastToCommunity(encrypt(loaded!.community.id), { type: DELETE, message: await messageProps(message, loaded!, author) });
      return { status: SEE_OTHER, location: communityLocation(loaded!) };
    },
  },
  {
    method: "POST",
    pattern: "/communities/:community_id/last_read_chat_message",
    run: async (input) => {
      const { denied, loaded } = await guarded(input, {});
      if (denied) return denied;
      const messageId = typeof input.params.message_id === "string" ? idOf(input.params.message_id) : null;
      if (typeof input.params.message_id !== "string" && input.params.message_id !== undefined) throw new NotPortedError("find_by_external_id!", "a non-string message_id");
      const message = messageId === null ? null : await findMessage(loaded!.community.id, messageId);
      if (!message) throw new RoutingError("Not Found");
      try {
        await setLastRead(input.context.currentSeller!.id, loaded!.community.id, message.id);
      } catch (error) {
        if (error instanceof RecordNotFound) throw new RoutingError("Not Found");
        throw error;
      }
      return { status: SEE_OTHER, location: communityLocation(loaded!) };
    },
  },
  ...["PUT", "PATCH"].map((method) => ({
    method,
    pattern: "/communities/:community_id/notification_settings",
    run: async (input: MutationInput): Promise<ActionResult> => {
      const { denied, loaded } = await guarded(input, { alive: true });
      if (denied) return denied;
      const value = input.params.recap_frequency;
      const attributes: { recap_frequency?: string | null } = {};
      if (value === null || typeof value === "string") {
        if (value !== null && !RECAP_FREQUENCIES.includes(value)) throw new NotPortedError("update!(recap_frequency:)", "an invalid recap frequency");
        attributes.recap_frequency = value;
      }
      await saveNotificationSetting(input.context.currentSeller!.id, loaded!.seller.id, attributes);
      return { status: SEE_OTHER, location: communityLocation(loaded!), flash: { notice: "Changes saved!" } };
    },
  })),
);
