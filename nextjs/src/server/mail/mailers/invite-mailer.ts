// Port of app/mailers/invite_mailer.rb with app/views/invite_mailer/receiver_signed_up.html.erb.
import { applicationMail, findRowOrRaise, type MailerDeps } from "../application-mailer.ts";
import type { RenderedMail } from "../compose.ts";
import { emailLayout, h, headerSection } from "../views.ts";

type InviteRow = { sender_id: number | bigint | null; receiver_id: number | bigint | null };
type UserRow = { name: string | null; email: string | null; unconfirmed_email: string | null };

const present = (value: string | null | undefined): value is string => value !== null && value !== undefined && /[^\s]/u.test(value);

export async function receiverSignedUp(inviteId: number | bigint, deps: MailerDeps = {}): Promise<RenderedMail | null> {
  const invite = await findRowOrRaise<InviteRow>("invites", "Invite", inviteId);
  const sender = await findRowOrRaise<UserRow>("users", "User", invite.sender_id);
  const receiver = await findRowOrRaise<UserRow>("users", "User", invite.receiver_id);

  const subject = present(receiver.name) ? `${receiver.name} has joined Gumroad, thanks to you.` : "A creator you invited has joined Gumroad.";
  // User#form_email
  const to = present(sender.unconfirmed_email) ? sender.unconfirmed_email : present(sender.email) ? sender.email : null;
  if (to === null) return null;

  const who = [present(receiver.name) ? receiver.name : null, receiver.email].filter(present).join(" - ");
  const content = `${headerSection(subject)}
<div>
  <p>
    We're happy to let you know that ${h(who)} has joined Gumroad from your referral.
  </p>
  <p>
    Thanks for spreading the good word!
  </p>
</div>
`;
  return applicationMail(
    { mailerClass: "InviteMailer", mailerMethod: "receiver_signed_up", args: [inviteId], to, subject, html: emailLayout(content, { subject }) },
    deps,
  );
}
