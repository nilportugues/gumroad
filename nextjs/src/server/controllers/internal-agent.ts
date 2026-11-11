// The read side of the store Agent chat: Api::Internal::AgentConversationsController (latest, action_status, turn_status).
// The turns themselves (messages, streams, confirmed actions) call a language model and stay in Rails; the custom HTML previews are in internal-agent-previews.ts.
import type { AiConversation, AiMessage } from "@prisma/client";

import { db } from "../../lib/db.ts";
import { decrypt, encrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { railsEnv } from "../infra/rails-env.ts";
import { getRedis } from "../infra/redis.ts";
import { NotPortedError } from "../models/user.ts";
import { NotPortedError as PageNotPortedError } from "../page-props/not-ported.ts";
import { eligibleForStoreAgent } from "../page-props/signed-in/policy-props.ts";
import { authorize } from "../policies/authorize.ts";
import { NotAuthorizedError, type SellerContext } from "../policies/seller-context.ts";
import { userPolicy } from "../policies/user.ts";
import type { JsonValue } from "../search/es-json.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { json, jsonAction } from "./json-actions.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";
import { authorizeJson, notFoundJson } from "./seller-json.ts";

// AgentConversationPersistence
const HISTORY_MAX_MESSAGES = 100;
const CLIENT_TURN_ID_FORMAT = /^[0-9a-fA-F-]{1,64}$/u;
const AGENT_TURN_LOOKUP_WINDOW_MS = 60 * 60 * 1000;
const ACTION_STATUS_EXECUTING = "executing";
const BAD_REQUEST = 400;
const SOURCE = "agent_conversation_persistence.rb";

// Object#blank? of a JSON value
const blank = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  value === false ||
  (typeof value === "string" && /^\s*$/u.test(value)) ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0);

export async function handingBack<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof NotPortedError || error instanceof PageNotPortedError)
      throw new HandBackToRails(error.message);
    throw error;
  }
}

// `authorize current_seller, :use_store_agent?`
export async function authorizeStoreAgent(context: SellerContext): Promise<void> {
  authorize(userPolicy.viewStoreAgent, context);
  if (!(await eligibleForStoreAgent(context.seller!, railsEnv() === "development")))
    throw new NotAuthorizedError("not allowed to use_store_agent?");
}

// `authenticate_user!` (e404_json), then `authorize current_seller, :use_store_agent?`
export async function guarded(input: MutationInput, run: () => Promise<ActionResult>): Promise<ActionResult> {
  if (railsLoggedInUser(input.context) === null) return { ...notFoundJson(), rescued: true };
  if (input.context.currentSeller === null) throw new HandBackToRails("a signed-in request without a current seller");
  const denied = await authorizeJson(input, authorizeStoreAgent);
  return denied ?? run();
}

type Metadata = Record<string, JsonValue>;

function metadataOf(message: AiMessage): Metadata {
  const metadata = message.metadata as JsonValue;
  if (metadata === null || metadata === undefined) return {};
  if (typeof metadata !== "object" || Array.isArray(metadata))
    throw new NotPortedError("an AiMessage whose metadata is not a hash", SOURCE);
  return metadata as Metadata;
}

// reconcile_stale_agent_action!: an execution still marked as running is judged against the database clock and may be rewritten.
function assertNothingToReconcile(metadata: Metadata): void {
  if (!blank(metadata.proposed_action) && metadata.action_status === ACTION_STATUS_EXECUTING)
    throw new NotPortedError("a proposal whose execution is still marked as running", SOURCE);
}

const ACTION_STATUS_UNKNOWN = "unknown";

// agent_message_props. The mobile reads (`hide_executing_action: true`) swap a claimed action's card for a canned reply; that text is not ported.
function messageProps(message: AiMessage, hideExecutingAction = false): JsonValue {
  const metadata = metadataOf(message);
  assertNothingToReconcile(metadata);
  if (
    hideExecutingAction &&
    (metadata.action_status === ACTION_STATUS_EXECUTING || metadata.action_status === ACTION_STATUS_UNKNOWN)
  )
    throw new NotPortedError("a claimed action hidden from older mobile clients", SOURCE);
  const props: Record<string, JsonValue> = {};
  for (const [key, value] of [
    ["role", message.role],
    ["content", message.content],
    ["proposed_action", metadata.proposed_action],
    ["objects", metadata.objects],
    ["action_status", metadata.action_status],
  ] as const) {
    if (value !== null && value !== undefined) props[key] = value;
  }
  if (!blank(metadata.proposed_action)) props.proposal_message_id = encrypt(message.id);
  return props;
}

const aliveConversation = (sellerId: bigint) => ({ seller_id: sellerId, deleted_at: null });

// The seller's latest conversation, as the web (AgentConversationsController#latest) and mobile (AgentController#latest_conversation) reads render it.
export async function latestConversation(sellerId: bigint, hideExecutingAction: boolean): Promise<ActionResult> {
  const conversation: AiConversation | null = await db.aiConversation.findFirst({
    where: aliveConversation(sellerId),
    orderBy: [{ updated_at: "desc" }, { id: "desc" }],
  });
  if (conversation === null) return json({ success: true, conversation: null });
  // `ai_messages.last(100)`: the newest hundred, oldest first
  const newest = await db.aiMessage.findMany({
    where: { ai_conversation_id: conversation.id },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    take: HISTORY_MAX_MESSAGES,
  });
  return json({
    success: true,
    conversation: {
      id: encrypt(conversation.id),
      title: conversation.title,
      messages: newest.reverse().map((message) => messageProps(message, hideExecutingAction)),
    },
  });
}

// AgentConversationsController#latest
export const agentConversationsLatest = (request: Request) =>
  jsonAction(request, {}, {}, (input) =>
    handingBack(() => guarded(input, () => latestConversation(input.context.currentSeller!.id, false))),
  );

// AgentConversationsController#action_status
export const agentActionStatus = (request: Request) =>
  jsonAction(request, {}, {}, (input) =>
    handingBack(() =>
      guarded(input, async () => {
        const given = input.params.proposal_message_id;
        if (given !== undefined && given !== null && typeof given !== "string")
          throw new HandBackToRails("a proposal_message_id that is not text");
        const id = typeof given === "string" ? decrypt(given) : null;
        const message =
          id === null
            ? null
            : await db.aiMessage.findFirst({
                where: {
                  id: BigInt(id),
                  role: "assistant",
                  ai_conversation: aliveConversation(input.context.currentSeller!.id),
                },
              });
        const metadata = message === null ? {} : metadataOf(message);
        if (message === null || blank(metadata.proposed_action))
          return { status: 404, body: "", contentType: "application/json", paramsRead: true };
        assertNothingToReconcile(metadata);
        const status = metadata.action_status;
        return json({
          success: true,
          action_status: blank(status) ? "pending" : status,
          objects: metadata.objects ?? [],
        });
      }),
    ),
  );

// The recovery read of a streamed turn, as the web (AgentConversationsController#turn_status) and mobile (AgentController#turn_status) reads render it.
export async function turnStatus(
  sellerId: bigint,
  turnId: string,
  hideExecutingAction: boolean,
): Promise<ActionResult> {
  if (!CLIENT_TURN_ID_FORMAT.test(turnId)) return json({ success: false, error: "Invalid turn id." }, BAD_REQUEST);
  const message = await db.aiMessage.findFirst({
    where: {
      role: "assistant",
      created_at: { gte: new Date(Date.now() - AGENT_TURN_LOOKUP_WINDOW_MS) },
      ai_conversation: aliveConversation(sellerId),
      metadata: { path: "$.client_turn_id", equals: turnId },
    },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
  });
  if (message !== null)
    return json({
      success: true,
      status: "persisted",
      conversation_id: encrypt(message.ai_conversation_id),
      message: messageProps(message, hideExecutingAction),
    });
  const marker = await getRedis("main").get(`agent_turn_status:${sellerId}:${turnId}`);
  return json({ success: true, status: marker === "in_progress" || marker === "failed" ? marker : "unknown" });
}

// AgentConversationsController#turn_status
export const agentTurnStatus = (request: Request, routeParams: Record<string, string>) =>
  jsonAction(request, routeParams, {}, (input) =>
    handingBack(() =>
      guarded(input, () => turnStatus(input.context.currentSeller!.id, input.routeParams.client_turn_id!, false)),
    ),
  );

// AgentMessagesController#create and #execute, AgentMessageStreamsController#create: `authenticate_user!` and `authorize_store_agent`, then
// the Redis-counted `throttle_agent_requests`, which a Node answer would skip. Every request past the gates is Rails'.
const handedBackTurn = (what: string) => (input: MutationInput) =>
  handingBack(() =>
    guarded(input, () => {
      throw new HandBackToRails(what);
    }),
  );

registerMutations(
  { method: "POST", pattern: "/internal/agent/messages", formats: ["any"], run: handedBackTurn("an agent turn") },
  {
    method: "POST",
    pattern: "/internal/agent/messages/stream",
    formats: ["any"],
    run: handedBackTurn("a streamed agent turn"),
  },
  {
    method: "POST",
    pattern: "/internal/agent/actions",
    formats: ["any"],
    run: handedBackTurn("a confirmed agent action"),
  },
);
