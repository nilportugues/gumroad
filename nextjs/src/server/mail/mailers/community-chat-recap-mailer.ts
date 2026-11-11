// Port of CommunityChatRecapMailer#community_chat_recap_notification
// (app/mailers/community_chat_recap_mailer.rb) with
// app/views/community_chat_recap_mailer/community_chat_recap_notification.erb.
import { Prisma } from "@prisma/client";

import { encrypt as obfuscateId } from "../../../lib/obfuscate-ids.ts";
import { autoLink } from "../../html/rinku.ts";
import { sanitize } from "../../html/sanitizer.ts";
import { isBlank } from "../../html/text-helper.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { applicationMail, findRowOrRaise, type MailerDeps } from "../application-mailer.ts";
import type { RenderedMail } from "../compose.ts";
import { mailDomains, randomDeliveryMethodOptions } from "../mailer-info.ts";
import { MailerRoutes } from "../routes.ts";
import { linkTo, localizeTime, pluralize, truncate } from "../view-helpers.ts";
import { emailLayout, h, headerSection, MailViewNotPortedError } from "../views.ts";

import { NilAssociationError } from "./comment-mailer.ts";

type Id = number | bigint;
type UserRow = {
  name: string | null;
  email: string | null;
  unconfirmed_email: string | null;
  external_id: string | null;
};
type RecapRow = {
  id: Id;
  community_chat_recap_run_id: Id;
  community_id: Id | null;
  summarized_message_count: number;
  summary: string | null;
};
type CommunityRow = { id: Id; resource_type: string; resource_id: Id };
type RecapRunRow = { recap_frequency: string; from_date: Date; to_date: Date };
type LinkRow = { id: Id; name: string };
type LoadedRecap = RecapRow & { community: (CommunityRow & { resource: LinkRow | null }) | null };

const RECAP_TAGS = ["ul", "ol", "li", "strong", "b", "em", "a"];
const RECAP_ATTRIBUTES = ["href", "target", "rel"];
const RECAP_LINK_ATTRIBUTES = 'target="_blank" rel="nofollow"';

const recapsTable = "community_chat_recaps";
const allColumns = (name: string) => Prisma.raw(`\`${name}\`.*`);

// `where(id: ids)`: one value is an equality, more are IN, in the order given.
function idCondition(tableName: string, ids: Id[]): Prisma.Sql {
  return ids.length === 1
    ? Prisma.sql`${column(tableName, "id")} = ${ids[0]}`
    : Prisma.sql`${column(tableName, "id")} IN (${Prisma.join(ids, ", ")})`;
}

const uniqueIds = (ids: (Id | null)[]): Id[] => {
  const seen = new Map<string, Id>();
  for (const id of ids) if (id !== null && !seen.has(String(id))) seen.set(String(id), id);
  return [...seen.values()];
};

// includes(community: :resource): the preloader's queries, keys in the owners' order.
async function preloadCommunities(recaps: RecapRow[]): Promise<LoadedRecap[]> {
  const communityIds = uniqueIds(recaps.map((recap) => recap.community_id));
  const communities =
    communityIds.length === 0
      ? []
      : await selectRows<CommunityRow>(
          Prisma.sql`SELECT ${allColumns("communities")} FROM ${table("communities")} WHERE ${idCondition("communities", communityIds)}`,
        );
  // A polymorphic preload queries each resource_type's table; only products have communities.
  const other = communities.find((community) => community.resource_type !== "Link");
  if (other) throw new MailViewNotPortedError(`community resource ${other.resource_type}`);
  const linkIds = uniqueIds(communities.map((community) => community.resource_id));
  const links =
    linkIds.length === 0
      ? []
      : await selectRows<LinkRow>(
          Prisma.sql`SELECT ${allColumns("links")} FROM ${table("links")} WHERE ${idCondition("links", linkIds)}`,
        );
  const linkById = new Map(links.map((link) => [String(link.id), link]));
  const communityById = new Map(
    communities.map((community) => [
      String(community.id),
      { ...community, resource: linkById.get(String(community.resource_id)) ?? null },
    ]),
  );
  return recaps.map((recap) => ({
    ...recap,
    community: recap.community_id === null ? null : (communityById.get(String(recap.community_id)) ?? null),
  }));
}

// humanized_duration: from_date and to_date are datetimes, formatted in UTC.
function humanizedDuration(frequency: string, run: RecapRunRow): string {
  const from = run.from_date;
  const to = run.to_date;
  if (frequency === "daily") return localizeTime(from, "%B %-d, %Y");
  if (from.getUTCMonth() === to.getUTCMonth() && from.getUTCFullYear() === to.getUTCFullYear())
    return `${localizeTime(from, "%B %-d")}-${localizeTime(to, "%-d, %Y")}`;
  if (from.getUTCFullYear() === to.getUTCFullYear())
    return `${localizeTime(from, "%B %-d")}-${localizeTime(to, "%B %-d, %Y")}`;
  return `${localizeTime(from, "%B %-d, %Y")}-${localizeTime(to, "%B %-d, %Y")}`;
}

function communityOf(recap: LoadedRecap): { externalId: string; name: string } {
  if (!recap.community) throw new NilAssociationError("undefined method 'name' for nil (CommunityChatRecap#community)");
  if (!recap.community.resource) throw new NilAssociationError("undefined method 'name' for nil (Community#resource)");
  return { externalId: obfuscateId(recap.community.id), name: recap.community.resource.name };
}

export async function communityChatRecapNotification(
  userId: Id,
  sellerId: Id,
  recapIds: Id[],
  deps: MailerDeps = {},
): Promise<RenderedMail | null> {
  if (recapIds.length === 0 || new Set(recapIds.map(String)).size !== recapIds.length)
    throw new MailViewNotPortedError("recap ids that are empty or repeated");
  const user = await findRowOrRaise<UserRow>("users", "User", userId);
  const seller = await findRowOrRaise<UserRow>("users", "User", sellerId);

  // `@recaps.first` on the unloaded relation: its own ordered query, with the preloads.
  const [firstRow] = await selectRows<RecapRow>(
    Prisma.sql`SELECT ${allColumns(recapsTable)} FROM ${table(recapsTable)} WHERE ${idCondition(recapsTable, recapIds)} ORDER BY ${column(recapsTable, "id")} ASC LIMIT 1`,
  );
  if (!firstRow) throw new NilAssociationError("undefined method 'community_chat_recap_run' for nil");
  await preloadCommunities([firstRow]);
  const [run] = await selectRows<RecapRunRow>(
    Prisma.sql`SELECT ${allColumns("community_chat_recap_runs")} FROM ${table("community_chat_recap_runs")} WHERE ${column("community_chat_recap_runs", "id")} = ${firstRow.community_chat_recap_run_id} LIMIT 1`,
  );
  if (!run)
    throw new NilAssociationError(
      "undefined method 'recap_frequency' for nil (CommunityChatRecap#community_chat_recap_run)",
    );
  const frequency = run.recap_frequency;
  const sellerName = seller.name ?? "";
  const subject = `Your ${frequency} ${truncate(sellerName, 20)} community recap: ${humanizedDuration(frequency, run)}`;

  // The view's `@recaps.each` loads the relation; `@recaps.first` is then its first record.
  const recaps = await preloadCommunities(
    await selectRows<RecapRow>(
      Prisma.sql`SELECT ${allColumns(recapsTable)} FROM ${table(recapsTable)} WHERE ${idCondition(recapsTable, recapIds)}`,
    ),
  );
  const sellerExternalId = seller.external_id;
  const tables = recaps
    .map((recap) => {
      const community = communityOf(recap);
      if (recap.summary === null) throw new MailViewNotPortedError("Rinku.auto_link(nil)");
      const summary = sanitize(autoLink(recap.summary, RECAP_LINK_ATTRIBUTES), {
        tags: RECAP_TAGS,
        attributes: RECAP_ATTRIBUTES,
      });
      return `    <table class="table-stack">
      <tbody>
        <tr>
          <td>
            <h3 style="margin-bottom: 1em;"># ${linkTo(community.name, MailerRoutes.community(sellerExternalId, community.externalId), { target: "_blank", style: "text-decoration: none;" })}</h3>
            ${summary}
          </td>
        </tr>
        <tr>
          <td>${h(pluralize(recap.summarized_message_count, "message", "messages"))} summarised</td>
        </tr>
      </tbody>
    </table>
`;
    })
    .join("");
  const first = communityOf(recaps[0]!);
  const heading =
    frequency === "daily"
      ? `Here's a quick daily summary of what's been happening in ${sellerName} community.`
      : `Here's a weekly summary of what happened in ${sellerName} community.`;
  const content = `<div style="margin: 1em;">
    ${headerSection(heading)}

${tables}
  ${linkTo("Join the conversation", MailerRoutes.community(sellerExternalId, first.externalId), { class: "button primary", target: "_blank" })}

  <p>You are receiving this email because you're part of the ${h(seller.name)} community. To stop receiving ${h(frequency)} recap emails, please ${linkTo("update your notification settings", MailerRoutes.community(sellerExternalId, first.externalId, { notifications: "true" }), { target: "_blank" })}.</p>
</div>
`;
  return applicationMail(
    {
      mailerClass: "CommunityChatRecapMailer",
      mailerMethod: "community_chat_recap_notification",
      args: [userId, sellerId, recapIds],
      from: `noreply@${mailDomains().creators}`,
      to: isBlank(user.unconfirmed_email) ? (isBlank(user.email) ? null : user.email) : user.unconfirmed_email,
      subject,
      html: emailLayout(content),
      deliveryMethodOptions: await randomDeliveryMethodOptions("creators", {}, deps.router),
    },
    deps,
  );
}
