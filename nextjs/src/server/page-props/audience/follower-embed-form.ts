// The two renders of `Followers/FromEmbedForm` in FollowersController#from_embed_form (the HTML answer of POST /follow_from_embed_form),
// and the message both endpoints share (`follow_confirmation_message`). A mutation cannot render a page in Node yet, so
// controllers/followers-create.ts still hands the HTML request back; these props are checked against Rails' own in
// follower-embed-form.test.ts. A waitlist signup words its message differently and carries a `waitlist_url`: not modelled.
import { nameOrUsername, subdomain, subdomainWithProtocol, type UserRecord } from "../../models/user.ts";

export const FROM_EMBED_FORM_COMPONENT = "Followers/FromEmbedForm";

// FollowersController#follow_confirmation_message without a waitlist product
export const followConfirmationMessage = (seller: UserRecord, confirmed: boolean): string =>
  confirmed
    ? `You are now following ${nameOrUsername(seller)}!`
    : `Check your inbox to confirm your follow request to ${nameOrUsername(seller)}.`;

// `props: { success: true, message:, confirmed: @follower.confirmed? }`
export const embedFormFollowedProps = (seller: UserRecord, confirmed: boolean) => ({
  success: true,
  message: followConfirmationMessage(seller, confirmed),
  confirmed,
});

// A seller who has not been reviewed: the follow is refused and the visitor is sent to the seller's own subscribe page, which has the CAPTCHA.
// `subscribe_url` is nil only when the seller has no subdomain at all.
export const embedFormCaptchaProps = (seller: UserRecord) => ({
  success: false,
  message: `Please subscribe from ${nameOrUsername(seller)}'s subscribe page so we can confirm you're not a bot.`,
  subscribe_url: subdomain(seller) ? `${subdomainWithProtocol(seller)}/subscribe` : null,
  waitlist_url: null,
});
