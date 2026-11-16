// Port of CreatorMailer#marketing_x_reconnect (app/mailers/creator_mailer.rb) with
// app/views/creator_mailer/marketing_x_reconnect.html.erb.
import { Prisma } from "@prisma/client";

import { domainConfig } from "../../infra/domain.ts";
import { isValidEmailFormat } from "../../models/user.ts";
import { column } from "../../models/sql.ts";
import { applicationMail, findRow, type MailerDeps, RecordNotFoundError } from "../application-mailer.ts";
import type { RenderedMail } from "../compose.ts";
import { RubyHash, RubySymbol } from "../ruby-value.ts";
import { emailLayout, h, headerSection } from "../views.ts";

const ACTIONS = "marketing_actions";
// Marketing::Action::TERMINAL_STATUSES and X_WRITE_PERMISSION_MISSING
export const TERMINAL_STATUSES = ["posted", "failed", "cancelled"];
export const X_WRITE_PERMISSION_MISSING = "x_write_permission_missing";

// Marketing::Action.awaiting_reconnect: `open.where(error_code: X_WRITE_PERMISSION_MISSING)`.
export const awaitingReconnect = () =>
  Prisma.sql`${column(ACTIONS, "status")} NOT IN (${Prisma.join(TERMINAL_STATUSES, ", ")}) AND ${column(ACTIONS, "error_code")} = ${X_WRITE_PERMISSION_MISSING}`;

type ActionRow = { user_id: number | bigint; link_id: number | bigint };
type UserRow = { email: string | null; unconfirmed_email: string | null };
type LinkRow = { name: string; unique_permalink: string | null };

const presence = (value: string | null) => (value !== null && /[^\s]/u.test(value) ? value : null);

// A nil association raises NoMethodError on the next call in Ruby; the job fails the same way.
async function belongsTo<T>(tableName: string, id: number | bigint, name: string): Promise<T> {
  const row = await findRow<T>(tableName, id);
  if (!row) throw new RecordNotFoundError(`undefined method for nil (Marketing::Action#${name})`);
  return row;
}

export async function marketingXReconnect(marketingActionId: number | bigint, deps: MailerDeps = {}): Promise<RenderedMail | null> {
  const action = await findRow<ActionRow>(ACTIONS, marketingActionId, awaitingReconnect());
  if (action === null) return null;

  const seller = await belongsTo<UserRow>("users", action.user_id, "user");
  const email = presence(seller.unconfirmed_email) ?? presence(seller.email);
  if (!isValidEmailFormat(email)) return null;

  const product = await belongsTo<LinkRow>("links", action.link_id, "link");
  const { protocol, domain } = domainConfig();
  const shareUrl = `${protocol}://${domain}/products/${product.unique_permalink ?? ""}/edit/share`;
  const subject = "Reconnect X to send your launch post";
  const content = `${headerSection("Reconnect X to send your launch post")}
<div>
  <p>
    Your launch post for <strong>${h(product.name)}</strong> did not go out. Gumroad asked X for
    read access when you connected your account, so we could not post on your behalf.
  </p>
  <p>
    We fixed that. Reconnecting takes one click and your post is ready to send.
  </p>
  <p>
    <a class="button primary" href="${h(shareUrl)}">Reconnect X and send your post</a>
  </p>
  <p>
    X asks you to select "I trust this app" before it enables the Authorize button. That step is
    what grants posting access.
  </p>
  <p>
    You can also post it yourself at any time from the same page.
  </p>
</div>
`;
  return applicationMail(
    {
      mailerClass: "CreatorMailer",
      mailerMethod: "marketing_x_reconnect",
      args: [new RubyHash([[new RubySymbol("marketing_action_id"), marketingActionId]])],
      to: email,
      subject,
      html: emailLayout(content, { subject }),
    },
    deps,
  );
}
