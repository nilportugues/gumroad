// Port of CommentMailer#notify_seller_of_new_comment (app/mailers/comment_mailer.rb) with
// app/views/comment_mailer/notify_seller_of_new_comment.html.erb.
import { Prisma } from "@prisma/client";

import { domainConfig } from "../../infra/domain.ts";
import { autoLink } from "../../html/rinku.ts";
import { stripTags } from "../../html/sanitizer.ts";
import { isBlank } from "../../html/text-helper.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { applicationMail, findRow, findRowOrRaise, type MailerDeps } from "../application-mailer.ts";
import type { RenderedMail } from "../compose.ts";
import { mailDomains, randomDeliveryMethodOptions } from "../mailer-info.ts";
import { MailerRoutes } from "../routes.ts";
import { linkTo, localizeTime } from "../view-helpers.ts";
import { emailLayout, h, headerSection, MailViewNotPortedError } from "../views.ts";

type CommentRow = { commentable_id: number | bigint | null; commentable_type: string | null; author_name: string | null; content: string | null; created_at: Date };
type InstallmentRow = { name: string | null; slug: string | null; seller_id: number | bigint | null };
type SellerRow = { username: string | null; external_id: string | null; email: string | null; unconfirmed_email: string | null };

// Calling a method on a nil association raises NoMethodError, and the job fails as in Ruby.
export class NilAssociationError extends Error {}

const presence = (value: string | null) => (isBlank(value) ? null : value);

// User#subdomain_with_protocol: the username, else the external id, as a subdomain of ROOT_DOMAIN.
function subdomainWithProtocol(seller: SellerRow): string | null {
  const username = presence(seller.username) ?? seller.external_id;
  if (isBlank(username)) return null;
  const { protocol, rootDomain } = domainConfig();
  return `${protocol}://${username!.replaceAll("_", "-")}.${rootDomain}`;
}

const COMMENT_LINK_ATTRIBUTES = 'target="_blank" rel="noopener noreferrer nofollow"';

export async function notifySellerOfNewComment(commentId: number | bigint, deps: MailerDeps = {}): Promise<RenderedMail | null> {
  const comment = await findRowOrRaise<CommentRow>("comments", "Comment", commentId);
  // Only posts have the slug the view links to; Rails renders the other commentables.
  if (comment.commentable_type !== "Installment") throw new MailViewNotPortedError(`CommentMailer for a ${comment.commentable_type} commentable`);
  // includes(:commentable): the preload has no LIMIT.
  const [installment] =
    comment.commentable_id === null
      ? []
      : await selectRows<InstallmentRow>(
          Prisma.sql`SELECT ${Prisma.raw("`installments`.*")} FROM ${table("installments")} WHERE ${column("installments", "id")} = ${comment.commentable_id}`,
        );
  if (!installment) throw new NilAssociationError("undefined method 'name' for nil (Comment#commentable)");
  const subject = `New comment on ${installment.name ?? ""}`;
  const seller = installment.seller_id === null ? null : await findRow<SellerRow>("users", installment.seller_id);
  if (!seller) throw new NilAssociationError("undefined method 'form_email' for nil (Installment#seller)");

  const createdAt = localizeTime(comment.created_at, "%B %-d, %Y %-I:%M%p");
  const body = autoLink(stripTags(comment.content ?? ""), COMMENT_LINK_ATTRIBUTES);
  const viewComment = MailerRoutes.customDomainViewPost(installment.slug, subdomainWithProtocol(seller));
  const content = `${headerSection(`${comment.author_name ?? ""} commented on ${installment.name ?? ""}`)}

<div>
  <h3>${h(comment.author_name)}</h3>

  <small style="display: block">${h(createdAt)}</small>

  <p style="white-space: pre-wrap">${body}</p>

  ${linkTo("View comment", viewComment, { class: "button primary", target: "_blank" })}
</div>

<p>To stop receiving comment notifications, please ${linkTo("change your notification settings", MailerRoutes.settingsMain("notifications"), { target: "_blank" })}.</p>
`;
  const to = presence(seller.unconfirmed_email) ?? presence(seller.email);
  return applicationMail(
    {
      mailerClass: "CommentMailer",
      mailerMethod: "notify_seller_of_new_comment",
      args: [commentId],
      from: `noreply@${mailDomains().creators}`,
      to,
      subject,
      html: emailLayout(content),
      deliveryMethodOptions: await randomDeliveryMethodOptions("creators", {}, deps.router),
    },
    deps,
  );
}
