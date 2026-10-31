// app/mailers/user_signup_mailer.rb over Devise::Mailer, with app/views/user_signup_mailer.
// Devise::Mailer is not an ApplicationMailer: no X-GUM headers or provider routing, and it
// sends through config.action_mailer.smtp_settings (SendGrid, the gumroad domain).
import type { MimeMessage } from "../mime.ts";
import { emailLayout, h, headerSection, mailerUrl, MailViewNotPortedError } from "../views.ts";

// ApplicationMailer::NOREPLY_EMAIL_WITH_NAME, which config/initializers/devise.rb sets as
// mailer_sender and UserSignupMailer#email_changed sets explicitly.
const NOREPLY_EMAIL_WITH_NAME = "Gumroad <noreply@gumroad.com>";

// The User attributes the templates read, as stored at render time.
export type SignupMailUser = {
  email: string;
  unconfirmedEmail: string | null;
  confirmationToken: string | null;
  externalId: string;
};

// Devise's opts hash. A present key overrides the default even when blank, as Hash#merge does.
export type DeviseMailOptions = { to?: string | null };

// The message before premailer adds its text part.
export type RenderedMail = Omit<MimeMessage, "parts" | "to"> & { to: string | null; html: string };

const blank = (value: string | null | undefined) => value === null || value === undefined || !/[^\s]/u.test(value);

// Devise::Mailers::Helpers#headers_for, then `mail`.
function deviseMail(user: SignupMailUser, subject: string, options: DeviseMailOptions, content: string): RenderedMail {
  const to = "to" in options ? (options.to ?? null) : user.email;
  return { from: NOREPLY_EMAIL_WITH_NAME, replyTo: NOREPLY_EMAIL_WITH_NAME, to, subject, html: emailLayout(content) };
}

// Devise::Mailer#confirmation_instructions. The template links the token stored on the user,
// not the raw token Devise passes in.
export function confirmationInstructions(user: SignupMailUser, _token: string, options: DeviseMailOptions = {}): RenderedMail {
  if (user.confirmationToken === null) throw new MailViewNotPortedError("confirmation_url without a confirmation_token");
  const url = h(mailerUrl("/users/confirmation", { confirmation_token: user.confirmationToken }));
  const content = `${headerSection("Confirm your email address")}
<div>
  <p>Please confirm your account by clicking the button below.</p>
  <p><a class="button primary" href="${url}">Confirm email</a></p>
  <p>Or you can click here: <a href="${url}">${url}</a></p>
  <p>If you didn't request this, please ignore this email. You won't get another one!</p>
</div>
`;
  // devise gem config/locales/en.yml devise.mailer.confirmation_instructions.subject
  return deviseMail(user, "Confirmation instructions", options, content);
}

// UserSignupMailer#email_changed
export function emailChanged(user: SignupMailUser, options: DeviseMailOptions = {}): RenderedMail {
  const oldEmail = blank(options.to) ? user.email : options.to!;
  const newEmail = blank(user.unconfirmedEmail) ? user.email : user.unconfirmedEmail!;
  const content = `${headerSection("Your Gumroad account email is being changed")}
<div>
  <p>We're contacting you to notify that your Gumroad account email is being changed from ${h(oldEmail)} to ${h(newEmail)}.</p>
  <p>If you did not make this change, please contact support immediately by replying to this email.</p>
  <p>User ID: ${h(user.externalId)}</p>
</div>
`;
  // config/locales/devise.en.yml devise.mailer.email_changed.subject
  return deviseMail(user, "Security alert: Your Gumroad account email is being changed", options, content);
}
