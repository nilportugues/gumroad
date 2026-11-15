// The two pages PurchasesController renders without a write behind them (app/views/purchases): the form that asks a visitor for the
// buyer's email (`confirm_receipt_email`) and the resubscribe prompt (`subscribe` over GET). Both run under `hide_layouts`, which sets
// the body id and drops the base entrypoint. A signed-in viewer keeps Rails' analytics and layout reads, so the page is Rails'.
import { encrypt } from "../../lib/obfuscate-ids.ts";
import { railsLoggedInUser } from "../auth/resolve.ts";
import { DEFAULT_FOOTER_CONTENT } from "../erb/home-layout.ts";
import { buttonTag, escapeHtml } from "../erb/html.ts";
import { perFormCsrfToken } from "../page-props/csrf.ts";
import { domainConfig } from "../page-props/domain.ts";
import { PurchaseFlags } from "../search/flags.ts";

import { type ActionResult, HandBackToRails } from "./application-controller.ts";
import { renderApplicationPage } from "./erb-pages.ts";
import type { MutationInput } from "./mutation.ts";
import { setPurchase } from "./purchase-access-writes.ts";
import { requireHtml } from "./users-controller.ts";

const FOOTER = `  ${DEFAULT_FOOTER_CONTENT}\n`;
const CONFIRM_EMAIL_TITLE = "Confirm Email";
const BODY_ID = "app";
const BUTTON_CLASS =
  "inline-flex items-center justify-center gap-2 cursor-pointer border border-border rounded font-[inherit] no-underline transition-transform hover:-translate-1 hover:shadow active:translate-0 active:shadow-none disabled:opacity-30 disabled:hover:translate-0 disabled:hover:shadow-none px-4 py-3 text-base leading-snug bg-primary text-primary-foreground hover:bg-accent-with-text hover:text-accent-foreground w-full";
const EMAIL_FIELD_CLASS =
  "w-full border border-border rounded bg-background px-4 py-3 text-base leading-snug font-[inherit] outline-none focus:ring-2 focus:ring-accent";
const MAIN_OPEN =
  '<main class="grid divide-y divide-border bg-background border border-border rounded mx-auto my-8 h-min max-w-md w-[calc(100%-2rem)]">';

// `button_tag text, type: "submit", class:, name: nil`
const submitButton = (text: string) => buttonTag(text, { type: "submit", class: BUTTON_CLASS, name: null }).value;

// app/views/purchases/confirm_receipt_email.html.erb
function confirmReceiptEmailView(externalId: string, giftReceiver: boolean): string {
  const prompt = giftReceiver
    ? "Please enter the email address this gift was sent to in order to view your receipt."
    : "Please enter the email address used to purchase this product to view your receipt.";
  return `${MAIN_OPEN}
  <header class="flex flex-col gap-4 p-4 text-center">
    <h2>Confirm your email address</h2>
      <p>${prompt}</p>
  </header>
  <form class="flex flex-col gap-4 p-4" action="/purchases/${escapeHtml(externalId)}/receipt" accept-charset="UTF-8" method="get">
    <label class="form-label" for="email">Email address:</label>
    <input type="email" name="email" id="email" placeholder="Email address" required="required" class="${EMAIL_FIELD_CLASS}" />
    ${submitButton("View receipt")}
</form></main>
`;
}

// app/views/purchases/subscribe.html.erb before the buyer posts (`@subscribed` unset)
function subscribeView(externalId: string, csrfToken: string): string {
  const action = `/purchases/${externalId}/subscribe`;
  const token = perFormCsrfToken(csrfToken, action, "post");
  return `${MAIN_OPEN}
    <header class="flex flex-col gap-4 p-4 text-center">
      <h2>Resubscribe to this creator's emails?</h2>
      <p>You previously unsubscribed from this creator's emails. Click the button below to start receiving their posts and updates again.</p>
    </header>
    <form class="flex flex-col gap-4 p-4" action="${escapeHtml(action)}" accept-charset="UTF-8" method="post"><input type="hidden" name="authenticity_token" value="${escapeHtml(token)}" autocomplete="off" />
      ${submitButton("Resubscribe")}
</form></main>
`;
}

function assertAnonymousHtml(input: MutationInput): void {
  requireHtml(input);
  if (railsLoggedInUser(input.context) !== null) throw new HandBackToRails("a signed-in visitor of a purchase page");
}

// `confirm_receipt_email`: `set_analytics_meta_tags(seller: @purchase.seller)` reads the seller's third-party analytics setting in
// production and staging only; every other environment answers false.
export async function confirmReceiptEmailPage(input: MutationInput): Promise<ActionResult> {
  const purchase = await setPurchase(input.routeParams.id!);
  assertAnonymousHtml(input);
  const { railsEnv } = domainConfig(process.env);
  if (railsEnv === "production" || railsEnv === "staging")
    throw new HandBackToRails("the analytics setting of the purchase's seller");
  const giftReceiver = PurchaseFlags.isSet(purchase.flags, "is_gift_receiver_purchase");
  return renderApplicationPage(
    input.request,
    input,
    null,
    () => confirmReceiptEmailView(encrypt(purchase.id), giftReceiver),
    {
      footer: FOOTER,
      hideBase: true,
      bodyId: BODY_ID,
      title: CONFIRM_EMAIL_TITLE,
      analyticsEnabled: false,
      analyticsFirst: false,
      handBackFlash: true,
      // set_noindex_header
      headers: { "x-robots-tag": "noindex" },
    },
  );
}

// `subscribe` over GET: the prompt only; the state change waits for the POST.
export async function subscribePage(input: MutationInput): Promise<ActionResult> {
  const purchase = await setPurchase(input.routeParams.id!);
  assertAnonymousHtml(input);
  return renderApplicationPage(
    input.request,
    input,
    null,
    (_ctx, csrfToken) => subscribeView(encrypt(purchase.id), csrfToken),
    {
      footer: FOOTER,
      hideBase: true,
      bodyId: BODY_ID,
      analyticsFirst: false,
      handBackFlash: true,
    },
  );
}
