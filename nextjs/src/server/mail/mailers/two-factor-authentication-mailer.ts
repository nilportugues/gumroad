// Port of TwoFactorAuthenticationMailer#authentication_token (app/mailers/two_factor_authentication_mailer.rb)
// with app/views/two_factor_authentication_mailer/authentication_token.html.erb.
//
// The after_actions run in reverse order of definition: record_email_sent, then deliver_email
// (which calls `mail`), then ApplicationMailer's validate_from_email_domain!. So the fallback key
// is written even when the address is invalid and no mail goes out.
import { encrypt as obfuscateId } from "../../../lib/obfuscate-ids.ts";
import { totpAt } from "../../../lib/rotp.ts";
import { getRedis } from "../../infra/redis.ts";
import { isBlank, simpleFormat } from "../../html/text-helper.ts";
import { isValidEmailFormat } from "../../models/user.ts";
import { applicationMail, findRowOrRaise, type MailerDeps } from "../application-mailer.ts";
import type { RenderedMail } from "../compose.ts";
import { defaultDeliveryMethodOptions, deliveryMethodOptions, EMAIL_PROVIDER_RESEND, EMAIL_PROVIDER_SENDGRID, type EmailProvider } from "../mailer-info.ts";
import type { RubyValue } from "../ruby-value.ts";
import { distanceOfTimeInWords, linkTo, ViewHelperNotPortedError } from "../view-helpers.ts";
import { emailLayout, h, headerSection, mailerUrl } from "../views.ts";

type UserRow = { id: number | bigint; email: string | null; external_id: string | null; otp_secret_key: string | null };

// TwoFactorAuthentication::TOKEN_VALIDITY
const TOKEN_VALIDITY_SECONDS = 10 * 60;
// EmailRouterFallbackService::TTL
const FALLBACK_TTL_SECONDS = 5 * 60;

// Time.current.to_s in the app's UTC zone.
const timeCurrentToS = (now: Date) => `${now.toISOString().slice(0, 19).replace("T", " ")} UTC`;

// EmailRouterFallbackService.record_email_sent: `$redis.set(key, Time.current, ex: TTL)`.
async function recordEmailSent(userId: number | bigint, deps: MailerDeps): Promise<void> {
  const key = `email_router_fallback:${String(userId)}`;
  const value = timeCurrentToS(deps.now ? deps.now() : new Date());
  if (deps.redisSetEx) await deps.redisSetEx(key, value, FALLBACK_TTL_SECONDS);
  else await getRedis("main").set(key, value, "EX", FALLBACK_TTL_SECONDS);
}

// `mailerArgs` are the arguments as #process got them, for the X-GUM headers.
export async function authenticationToken(userId: number | bigint, emailProvider: string | null, mailerArgs: RubyValue[], deps: MailerDeps = {}): Promise<RenderedMail | null> {
  const user = await findRowOrRaise<UserRow>("users", "User", userId);
  // otp_code on a user without a secret raises in ROTP (nil.tr); Rails reports it.
  if (user.otp_secret_key === null) throw new ViewHelperNotPortedError("otp_code without an otp_secret_key");
  const token = totpAt(user.otp_secret_key, deps.now ? deps.now() : new Date());
  const subject = `Your authentication token is ${token}`;
  // encrypted_external_id: ObfuscateIds.encrypt(external_id.to_s).
  const encryptedExternalId = obfuscateId(user.external_id ?? "");
  const verifyUrl = mailerUrl("/two-factor/verify.html", { token, user_id: encryptedExternalId });

  // An unknown provider raises in Ruby after the fallback key is written; Rails gets it untouched.
  let options = defaultDeliveryMethodOptions("gumroad");
  if (!isBlank(emailProvider)) {
    if (emailProvider !== EMAIL_PROVIDER_SENDGRID && emailProvider !== EMAIL_PROVIDER_RESEND) throw new ViewHelperNotPortedError(`email provider ${emailProvider}`);
    options = deliveryMethodOptions("gumroad", emailProvider as EmailProvider);
  }

  await recordEmailSent(user.id, deps);

  if (!isValidEmailFormat(user.email)) return null;

  const content = `${headerSection("Two-Factor Authentication")}
<div>
  We have detected a new login to your Gumroad account. Please enter this authentication token in the challenge page to continue:
  <p>
    <strong>
      ${simpleFormat(token)}
    </strong>
  </p>
  You can also click the following button to continue with your login.
  ${linkTo("Login", verifyUrl, { class: "button primary" })}
  <p>
    This authentication token and login link will expire in ${h(distanceOfTimeInWords(TOKEN_VALIDITY_SECONDS))}.
  </p>
</div>
`;
  return applicationMail(
    {
      mailerClass: "TwoFactorAuthenticationMailer",
      mailerMethod: "authentication_token",
      args: mailerArgs,
      to: user.email,
      subject,
      html: emailLayout(content, { subject }),
      deliveryMethodOptions: options,
    },
    deps,
  );
}
