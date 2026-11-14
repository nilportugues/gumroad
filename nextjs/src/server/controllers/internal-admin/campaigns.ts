// Api::Internal::Admin::FeatureAnnouncementCampaignsController (index, show, create, update, approve, deliver, cancel) and the parts of
// FeatureAnnouncementCampaign they use. #preview renders FeatureAnnouncementMailer (Premailer), which Node does not: it answers the token and lookup refusals, Rails the rest.
import { createHash } from "node:crypto";

import { db } from "../../../lib/db.ts";
import { performAsync } from "../../models/concerns/job-runtime.ts";
import { NotPortedError } from "../../models/user.ts";
import { esJson } from "../../search/es-json.ts";
import { type AdminRequest, failure, halted, jsonRendered, paramToS, recordAdminWrite, requirePerActorToken, timeJson } from "./base.ts";
import { emailFormatValid } from "./email-format.ts";
import { handBack } from "./hand-back.ts";
import { defineAdminRoute } from "./registry.ts";

const MAX_LIST_RESULTS = 100;
const MAX_KEY_LENGTH = 64;
const CONTENT_PARAMS = ["subject", "body", "reply_to"] as const;
const AUDIENCES = ["creators", "piracy_reports"];
const KEY_FORMAT = /^[a-z0-9_]+$/u;
const REPLY_TO_DOMAIN = /@gumroad\.com$/u;
const TARGET_TYPE = "FeatureAnnouncementCampaign";
const SOURCE = "app/models/feature_announcement_campaign.rb";

type Campaign = NonNullable<Awaited<ReturnType<typeof db.featureAnnouncementCampaign.findFirst>>>;
type Content = { subject: string; body: string; reply_to: string };

const digestFor = (subject: string, body: string, replyTo: string) => createHash("sha256").update(esJson([subject, body, replyTo])).digest("hex");

function campaignJson(campaign: Campaign) {
  return {
    key: campaign.key,
    subject: campaign.subject,
    body: campaign.body,
    reply_to: campaign.reply_to,
    audience: campaign.audience,
    state: campaign.state,
    content_digest: digestFor(campaign.subject, campaign.body, campaign.reply_to),
    approved_by: undefined as string | null | undefined,
    approved_at: timeJson(campaign.approved_at),
    created_at: timeJson(campaign.created_at),
  };
}

async function serialize(campaign: Campaign) {
  const approvedBy = campaign.approved_by_id === null ? null : ((await db.user.findFirst({ where: { id: campaign.approved_by_id }, select: { external_id: true } }))?.external_id ?? null);
  const json = campaignJson(campaign);
  return { ...json, approved_by: approvedBy };
}

const blank = (value: string) => /^\p{White_Space}*$/u.test(value);

// `links_use_https` reads the anchors with Nokogiri. Plain quoted hrefs are read here; anything else (an unquoted or unusual href) is Rails'.
function linksUseHttps(body: string): boolean {
  const anchors = body.match(/<a\b[^>]*>/giu) ?? [];
  return anchors.every((anchor) => {
    const href = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/iu.exec(anchor);
    if (href === null) {
      if (/href/iu.test(anchor)) throw new NotPortedError("an anchor with an unusual href", SOURCE);
      return true;
    }
    if (/&/u.test(href[1] ?? href[2] ?? "")) throw new NotPortedError("an href with entities", SOURCE);
    return (href[1] ?? href[2] ?? "").startsWith("https://");
  });
}

// FeatureAnnouncementCampaign's validations, in the order they are declared; messages as errors.full_messages.to_sentence reads them.
async function validationMessages(values: { key: string; audience: string; state: string } & Content, existing: Campaign | null): Promise<string[]> {
  const errors: string[] = [];
  if (blank(values.key)) errors.push("Key can't be blank");
  if (values.key !== "" && (await db.featureAnnouncementCampaign.findFirst({ where: { key: values.key, NOT: existing === null ? undefined : { id: existing.id } }, select: { id: true } })) !== null) errors.push("Key has already been taken");
  if ([...values.key].length > MAX_KEY_LENGTH) errors.push(`Key is too long (maximum is ${MAX_KEY_LENGTH} characters)`);
  if (!KEY_FORMAT.test(values.key)) errors.push("Key is invalid");
  if (blank(values.subject)) errors.push("Subject can't be blank");
  if (blank(values.body)) errors.push("Body can't be blank");
  if (blank(values.reply_to)) errors.push("Reply to can't be blank");
  if (!emailFormatValid(values.reply_to)) errors.push("Reply to is invalid");
  if (!REPLY_TO_DOMAIN.test(values.reply_to)) errors.push("Reply to is invalid");
  if (!AUDIENCES.includes(values.audience)) errors.push("Audience is not included in the list");
  if (!["draft", "approved", "sending", "sent", "cancelled"].includes(values.state)) errors.push("State is not included in the list");
  if (!linksUseHttps(values.body)) errors.push("Body links must use https");
  if (existing !== null && existing.state !== "draft") {
    for (const name of CONTENT_PARAMS) if (values[name] !== existing[name]) errors.push(`${name === "reply_to" ? "Reply to" : name[0]!.toUpperCase() + name.slice(1)} can't change after approval`);
  }
  return errors;
}

const toSentence = (messages: string[]) => (messages.length <= 2 ? messages.join(" and ") : `${messages.slice(0, -1).join(", ")}, and ${messages.at(-1)}`);
const renderErrors = (messages: string[]) => failure(toSentence(messages), 422);

function contentParams(admin: AdminRequest): Partial<Content> {
  const out: Partial<Content> = {};
  for (const name of CONTENT_PARAMS) if (name in admin.params) out[name] = paramToS(admin.params[name], SOURCE);
  return out;
}

// before_action :require_per_actor_token!, :find_campaign_or_render
async function withCampaign(admin: AdminRequest, run: (campaign: Campaign) => Promise<ReturnType<typeof jsonRendered>>) {
  const refusal = requirePerActorToken(admin.admin);
  if (refusal !== null) return halted(refusal);
  const campaign = await db.featureAnnouncementCampaign.findFirst({ where: { key: paramToS(admin.params.id, SOURCE) } });
  if (campaign === null) return halted(failure("Campaign not found", 404));
  return run(campaign);
}

const target = (campaign: Campaign) => ({ type: TARGET_TYPE, id: campaign.id, externalId: null });

// FeatureAnnouncementCampaign::InvalidTransition inside the transition's lock
class InvalidTransition extends Error {}

async function lockedCampaign(tx: Pick<typeof db, "$queryRaw" | "featureAnnouncementCampaign">, id: bigint): Promise<Campaign> {
  await tx.$queryRaw`SELECT id FROM feature_announcement_campaigns WHERE id = ${id} FOR UPDATE`;
  return tx.featureAnnouncementCampaign.findFirstOrThrow({ where: { id } });
}

async function transition(admin: AdminRequest, campaign: Campaign, name: string, change: (locked: Campaign, tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void>, afterCommit?: () => Promise<void>) {
  return recordAdminWrite(admin, { action: `feature_announcement_campaigns.${name}`, target: target(campaign), wrapper: { key: "feature_announcement_campaign", model: "FeatureAnnouncementCampaign" } }, async () => {
    try {
      await db.$transaction(async (tx) => change(await lockedCampaign(tx, campaign.id), tx));
    } catch (error) {
      if (error instanceof InvalidTransition) return failure(error.message, 409);
      throw error;
    }
    await afterCommit?.();
    return jsonRendered({ success: true, campaign: await serialize(await db.featureAnnouncementCampaign.findFirstOrThrow({ where: { id: campaign.id } })) });
  });
}

defineAdminRoute(
  {
    method: "GET",
    pattern: "/internal/admin/feature_announcement_campaigns",
    run: async (admin) => {
      const refusal = requirePerActorToken(admin.admin);
      if (refusal !== null) return halted(refusal);
      const campaigns = await db.featureAnnouncementCampaign.findMany({ orderBy: { id: "desc" }, take: MAX_LIST_RESULTS });
      return jsonRendered({ success: true, campaigns: await Promise.all(campaigns.map(serialize)) });
    },
  },
  {
    method: "GET",
    pattern: "/internal/admin/feature_announcement_campaigns/:id",
    run: (admin) =>
      withCampaign(admin, async (campaign) => {
        const rows = await db.$queryRaw<{ state: string; reason: string | null; count_all: bigint }[]>`SELECT COUNT(*) AS count_all, state AS state, reason AS reason FROM feature_announcement_deliveries WHERE campaign = ${campaign.key} GROUP BY state, reason`;
        const deliveries = rows.map((row) => ({ state: row.state, reason: row.reason, count: Number(row.count_all) }));
        return jsonRendered({ success: true, campaign: await serialize(campaign), deliveries });
      }),
  },
  {
    method: "GET",
    pattern: "/internal/admin/feature_announcement_campaigns/:id/preview",
    // A preview writes nothing, so it skips the token's usage stamp too.
    recordsUse: () => false,
    run: (admin) => withCampaign(admin, () => handBack("a rendered announcement email", SOURCE)),
  },
  {
    method: "POST",
    pattern: "/internal/admin/feature_announcement_campaigns",
    run: async (admin) => {
      const refusal = requirePerActorToken(admin.admin);
      if (refusal !== null) return halted(refusal);
      const content = contentParams(admin);
      const values = { key: paramToS(admin.params.key, SOURCE), audience: paramToS(admin.params.audience, SOURCE), state: "draft", subject: content.subject ?? "", body: content.body ?? "", reply_to: content.reply_to ?? "" };
      let saved: Campaign | null = null;
      return recordAdminWrite(admin, { action: "feature_announcement_campaigns.create", target: () => ({ type: TARGET_TYPE, id: saved?.id ?? null, externalId: null }), wrapper: { key: "feature_announcement_campaign", model: "FeatureAnnouncementCampaign" } }, async () => {
        const messages = await validationMessages(values, null);
        if (messages.length > 0) return renderErrors(messages);
        const now = new Date();
        saved = await db.featureAnnouncementCampaign.create({ data: { ...values, created_at: now, updated_at: now } });
        return jsonRendered({ success: true, campaign: await serialize(saved) }, 201);
      });
    },
  },
  {
    method: "PATCH",
    pattern: "/internal/admin/feature_announcement_campaigns/:id",
    run: (admin) => updateCampaign(admin),
  },
  {
    method: "PUT",
    pattern: "/internal/admin/feature_announcement_campaigns/:id",
    run: (admin) => updateCampaign(admin),
  },
  {
    method: "POST",
    pattern: "/internal/admin/feature_announcement_campaigns/:id/approve",
    run: (admin) =>
      withCampaign(admin, (campaign) =>
        transition(admin, campaign, "approve", async (locked, tx) => {
          if (locked.state !== "draft") throw new InvalidTransition("only a draft can be approved");
          const digest = paramToS(admin.params.content_digest, SOURCE);
          if (digest !== digestFor(locked.subject, locked.body, locked.reply_to)) throw new InvalidTransition("the copy changed since the preview");
          const now = new Date();
          await tx.featureAnnouncementCampaign.update({ where: { id: locked.id }, data: { state: "approved", content_digest: digest, approved_by_id: admin.admin.actor.id, approved_at: now, updated_at: now } });
        }),
      ),
  },
  {
    method: "POST",
    pattern: "/internal/admin/feature_announcement_campaigns/:id/deliver",
    run: (admin) =>
      withCampaign(admin, (campaign) =>
        transition(
          admin,
          campaign,
          "deliver",
          async (locked, tx) => {
            if (!["approved", "sending"].includes(locked.state)) throw new InvalidTransition("only an approved campaign can be sent");
            await tx.featureAnnouncementCampaign.update({ where: { id: locked.id }, data: { state: "sending", updated_at: new Date() } });
          },
          async () => {
            await performAsync("SendFeatureAnnouncementCampaignJob", [Number(campaign.id)]);
          },
        ),
      ),
  },
  {
    method: "POST",
    pattern: "/internal/admin/feature_announcement_campaigns/:id/cancel",
    run: (admin) =>
      withCampaign(admin, (campaign) =>
        transition(admin, campaign, "cancel", async (locked, tx) => {
          if (locked.state === "cancelled") throw new InvalidTransition("the campaign is already cancelled");
          await tx.featureAnnouncementCampaign.update({ where: { id: locked.id }, data: { state: "cancelled", updated_at: new Date() } });
        }),
      ),
  },
);

async function updateCampaign(admin: AdminRequest) {
  return withCampaign(admin, (campaign) =>
    recordAdminWrite(admin, { action: "feature_announcement_campaigns.update", target: target(campaign), wrapper: { key: "feature_announcement_campaign", model: "FeatureAnnouncementCampaign" } }, async () => {
      const content = contentParams(admin);
      // with_lock reloads the row, so a state change since the lookup is seen.
      const outcome = await db.$transaction(async (tx) => {
        const locked = await lockedCampaign(tx, campaign.id);
        const values = { key: locked.key, audience: locked.audience, state: locked.state, subject: content.subject ?? locked.subject, body: content.body ?? locked.body, reply_to: content.reply_to ?? locked.reply_to };
        const messages = await validationMessages(values, locked);
        if (messages.length > 0) return { messages };
        const changed = CONTENT_PARAMS.filter((name) => values[name] !== locked[name]);
        if (changed.length > 0) await tx.featureAnnouncementCampaign.update({ where: { id: locked.id }, data: { subject: values.subject, body: values.body, reply_to: values.reply_to, updated_at: new Date() } });
        return { saved: await tx.featureAnnouncementCampaign.findFirstOrThrow({ where: { id: locked.id } }) };
      });
      if ("messages" in outcome) return renderErrors(outcome.messages!);
      return jsonRendered({ success: true, campaign: await serialize(outcome.saved!) });
    }),
  );
}
