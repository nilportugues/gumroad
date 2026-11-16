// Port of TeamMailer#invite (app/mailers/team_mailer.rb) with app/views/team_mailer/invite.html.erb.
// Pinned by team-mailer.golden.json (__fixtures__/generate-team-mailer-golden.rb).
import { Prisma } from "@prisma/client";

import { encrypt as obfuscateId } from "../../../lib/obfuscate-ids.ts";
import { domainConfig } from "../../infra/domain.ts";
import { selectRows, table, column } from "../../models/sql.ts";
import { isValidEmailFormat, RISK_STATES } from "../../models/user.ts";
import { applicationMail, findRow, type MailerDeps, noreplyEmail, noreplyEmailWithName, RecordNotFoundError } from "../application-mailer.ts";
import type { RenderedMail } from "../compose.ts";
import { type InspectColumn, inspectRecord } from "../record-inspect.ts";
import { GlobalIdRef, type RubyValue } from "../ruby-value.ts";
import { linkTo } from "../view-helpers.ts";
import { emailLayout, h, mailerUrl, MailViewNotPortedError } from "../views.ts";

type TeamInvitationRow = {
  id: number | bigint;
  seller_id: number | bigint;
  email: string;
  role: string;
  expires_at: Date;
  accepted_at: Date | null;
  deleted_at: Date | null;
};
type SellerRow = { email: string | null; deleted_at: Date | null; user_risk_state: string | null };

const TEAM_INVITATION_COLUMNS: readonly InspectColumn[] = [
  ["id", "integer"],
  ["seller_id", "integer"],
  ["email", "string"],
  ["role", "string"],
  ["created_at", "datetime"],
  ["updated_at", "datetime"],
  ["expires_at", "datetime"],
  ["accepted_at", "datetime"],
  ["deleted_at", "datetime"],
];

const SUBJECT = "Gumroad team invitation";
const MILLISECONDS_PER_DAY = 86_400_000;

// TeamInvitation#single_mailbox_email?: EmailFormatValidator.valid? first, then Mail::AddressList must
// read back exactly this one bare address. Only a plain dot-atom local part and a hostname are shown
// to do that; quoted local parts and IP literals stay with Rails.
function isSingleMailbox(email: string, formatIsValid: boolean): boolean {
  if (!formatIsValid) return false;
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/u.test(email)) throw new MailViewNotPortedError("team invitation email that Mail::AddressList may read differently");
  return true;
}

// GlobalID::Locator.locate(TeamInvitation) inside the delivery job.
async function locateInvitation(argument: RubyValue | undefined): Promise<{ row: TeamInvitationRow; record: RubyValue }> {
  const gid = argument instanceof GlobalIdRef ? argument.gid : "";
  const match = /^gid:\/\/gumroad\/TeamInvitation\/(\d+)$/u.exec(gid);
  if (!match) throw new MailViewNotPortedError(`GlobalID not ported: ${gid}`);
  const row = await findRow<TeamInvitationRow & Record<string, unknown>>("team_invitations", BigInt(match[1]!));
  if (!row) throw new RecordNotFoundError(`Error while trying to deserialize arguments: Couldn't find TeamInvitation with 'id'="${match[1]}"`);
  return { row, record: inspectRecord("TeamInvitation", TEAM_INVITATION_COLUMNS, row) };
}

export async function invite(args: RubyValue[], deps: MailerDeps): Promise<RenderedMail | null> {
  const { row: located, record } = await locateInvitation(args[0]);
  const jobArgs = [record];

  // Delayed jobs re-read the invitation from the writer: `find_by(id:)` with the seller preloaded
  // in a second statement that has no LIMIT.
  const invitation = await findRow<TeamInvitationRow>("team_invitations", located.id);
  if (!invitation) return null;
  const [seller] = await selectRows<SellerRow>(Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${invitation.seller_id}`);
  const now = (deps.now ?? (() => new Date()))();
  if (!seller || seller.deleted_at !== null || (RISK_STATES.SUSPENDED as readonly (string | null)[]).includes(seller.user_risk_state)) return null;
  if (invitation.deleted_at !== null || invitation.accepted_at !== null || invitation.expires_at < now) return null;
  if (!isSingleMailbox(invitation.email, isValidEmailFormat(invitation.email))) return null;
  // Acceptance deletes an invitation addressed to the owner's own mailbox, so it is never sent.
  if (invitation.email.toLowerCase() === seller.email?.toLowerCase()) return null;

  const externalId = obfuscateId(invitation.id);
  if (!/^[A-Za-z0-9_=-]+$/u.test(externalId)) throw new MailViewNotPortedError("external id that needs URL escaping");
  const acceptUrl = mailerUrl(`/settings/team/invitations/${externalId}/accept`, { email: invitation.email });
  const expiresInDays = Math.trunc((Date.UTC(...utcDate(invitation.expires_at)) - Date.UTC(...utcDate(now))) / MILLISECONDS_PER_DAY);
  const role = invitation.role.replaceAll("_", " ").replace(/^./u, (c) => c.toUpperCase());
  const assetHost = domainConfig().assetHost ?? "";
  const content = `<div>
  <p>
    <img alt="Gumroad" style="height: 22px; margin: 0 auto;" height="22" src="${h(`${assetHost}/images/email/wordmark_logo.png`)}" />
  </p>
</div>
<div style="background-color: #f4f4f0">
  <h2 style="text-align: center;">${h(SUBJECT)}</h2>
</div>
<div>
  <p>You have been invited to join a team on Gumroad with the role of ${h(role)}.</p>
  <p>This is a team invitation, not a purchase receipt or a charge notice.</p>
  <p>
    <strong>This invitation will expire in ${expiresInDays} days.</strong>
  </p>
  <p>
    If you are not expecting an invitation, please ignore this email.
  </p>
  <p>
    ${linkTo("Accept invitation", acceptUrl, { class: "button primary" })}
  </p>
</div>
<div>
  <p>
    <strong>Button not working?</strong>
  </p>
  <p>
    Copy and paste this link into your browser: ${linkTo(acceptUrl, acceptUrl, { target: "_blank" })}
  </p>
</div>
<div>
  <p>If this invitation expires, ask the account owner to send a new invitation.</p>
</div>
`;
  return applicationMail(
    {
      mailerClass: "TeamMailer",
      mailerMethod: "invite",
      args: jobArgs,
      from: noreplyEmailWithName(),
      to: invitation.email,
      replyTo: noreplyEmail(),
      subject: SUBJECT,
      html: emailLayout(content, { subject: SUBJECT }),
    },
    deps,
  );
}

const utcDate = (time: Date): [number, number, number] => [time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate()];
