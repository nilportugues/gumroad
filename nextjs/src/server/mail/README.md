# Mail

Email from the Node side, sent byte for byte as ActionMailer sends it. Every stage is checked
against output recorded from the real gems (`__fixtures__/generate-*.rb`), and each stage refuses
input it cannot reproduce exactly instead of approximating it.

| Stage | File | Ruby counterpart |
| --- | --- | --- |
| Enqueue | `active-job.ts` | `deliver_later` → `MailDeliveryJob` in Sidekiq's `JobWrapper` |
| Route | `delivery.ts` `mailRoute` | — |
| Run | `delivery.ts`, `src/worker/jobs/active-job.ts` | `MailDeliveryJob#perform`, `retry_on`, `RescueSmtpErrors` |
| Arguments | `ruby-value.ts` | `ActiveJob::Arguments.deserialize`, Ruby 3.4 `#inspect` |
| Render | `mailers/*.ts`, `views.ts` | `app/mailers`, `app/views` (ERB) |
| ApplicationMailer | `application-mailer.ts`, `mailer-info.ts` | `ApplicationMailer`, `MailerInfo` (provider split, credentials, X-GUM headers) |
| Inline CSS, text part | `premailer/`, `stylesheet.ts` | premailer-rails 1.12, premailer 1.29, css_parser 1.22, Nokogiri 1.19 |
| Encode | `mime.ts`, `compose.ts` | `Mail::Message#encoded` (mail 2.9), including `cc` and multipart/mixed attachments |
| Attachment source | `s3-object.ts` | `Aws::S3::Resource` HEAD then GET, as InternalNotificationMailer reads them |
| Send | `smtp.ts` | `Mail::SMTP` over net-smtp 0.5 |

## How a mail gets sent

`deliverLater` builds the exact Sidekiq item Rails pushes (`mail.golden.json`'s `enqueue` cases).
By default it goes to Sidekiq and Rails delivers it, so calling it from Node is safe for any
mailer. With `NODE_MAIL_DELIVERY=enabled` (production only), mailer methods listed in
`delivery.ts`'s `NODE_MAILERS` go to BullMQ instead and the Node worker delivers them. The worker
pushes a job back to Sidekiq unchanged when the method is not ported or rendering hits anything
the port refuses (`NOT_PORTED`), so Rails stays the fallback. Ruby's own `deliver_later` of a
method in `node-owned-mailers.generated.json` is diverted to the worker by `lib/sidekiq_node_bridge.rb`.

An `ApplicationMailer` method renders its view and hands the result to `applicationMail`, which
does what `mail` and `#process` do around it: the default From, the class default
`delivery_method_options` (the Router's SendGrid/Resend split, counted in Redis), the
`validate_from_email_domain!` check, the United Internet redirect to SendGrid, and the X-GUM
headers for the provider the message ends up on. The message carries its SMTP settings, and
`smtp.ts` sends with them; Devise's mails use `config.action_mailer.smtp_settings`.

`EmailDeliveryObserver` only records a `CustomerEmailInfo` for messages whose headers name a
purchase or charge. `MailerInfo`'s builders refuse `CustomerMailer` and the installment methods
unless the mailer hands them the ids it looked up (`recordIds`), so only `CustomerMailer#receipt`
makes the observer write: `sendComposed` records the row (`models/email-info.ts`) after the SMTP
hand-off, in the transaction Rails opens for `mark_sent!`, and not when `RescueSmtpErrors` swallowed the send.

## Porting a mailer

1. Add its calls to a golden generator and regenerate. `generate-mail-golden.rb` stubs the models
   (Devise mails); `generate-application-mailer-golden.rb` boots the real application in production
   mode against a scratch database, so its cases are rows plus a mailer call, and it records the
   statements the mailer sends.
2. Port each template as a function that returns the HTML string ERB produces. Erubi drops a line
   holding only `<% %>`, newline included; a `<%= %>` line keeps its indentation and newline even
   when it prints nothing, so write those blanks out (`${/* yield :style */ ""}`): editors strip
   trailing whitespace. Escape every interpolation with `h()` (`ERB::Util.html_escape`), build
   URLs with `mailerUrl()`, and reuse `views.ts` for the layout and partials.
3. Read rows with ActiveRecord's statements (`findRow` and `sql.ts`), so the golden's statements
   replay. Return `null` where the Ruby method returns without calling `mail`, otherwise
   `applicationMail({...})` with the arguments ActionMailer passed to `#process`.
4. Add the method to `NODE_MAILERS`, regenerate `node-owned-mailers.generated.json`, and add its
   golden cases to the loop in `application-mailer.test.ts`: statements, rendered HTML, the encoded
   message with the golden's Date, Message-ID and boundary, the SMTP settings and the Router's Redis.

## What is refused

- `<style>` or `<script>` content holding `<` or `&` (premailer re-parses it as markup), elements
  nested deeper than libxml2's 256, CSS selectors outside the ported Nokogiri subset, remote or
  missing stylesheets. Everything else goes through the port of libxml2's HTML parser in
  `src/server/html/`, restructuring included.
- Headers the mail gem would RFC 2047-encode or decode (non-ASCII, CR/LF, `=?`), addresses other
  than `addr` and `Name <addr>` in ASCII, more than one recipient, bcc, single-part messages.
  A single `cc` is ported. Long ASCII headers are folded as `UnstructuredField#fold` does.
- Mailer arguments whose Ruby `#inspect` is not ported: records (GlobalID), floats, non-ASCII strings.
- The email layout outside production: it adds a non-ASCII environment banner.
- CommentMailer for a comment on anything but a post; CommunityChatRecapMailer for a community
  whose resource is not a product, a nil summary, or empty or repeated recap ids;
  TwoFactorAuthenticationMailer for a user without an OTP secret or an unknown `email_provider`;
  InternalNotificationMailer for attachments whose file name is not `[A-Za-z0-9][A-Za-z0-9._-]*` or whose type is not
  text/csv, application/json, application/octet-stream or application/vnd.ms-excel (Mail quotes, RFC 2231-encodes,
  sorts and transfer-encodes the others differently), and for arguments that are not Strings and String-keyed Hashes;
  and view helper inputs `view-helpers.ts` does not cover (`ViewHelperNotPortedError`).

## CustomerMailer

Ported (goldens: `customer-mailer.golden.json`, from `generate-customer-mailer-golden.rb`, which runs the real
mailer against `db/schema.rb` rows): `paypal_purchase_failed`, `subscription_magic_link`,
`files_ready_for_download`, `refund`, `partial_refund`. The goldens record every statement, the rendered HTML and the
encoded message; the Node test replays the statements and compares the bytes.

- `User#mailer_level` is read from `Rails.cache`, then the `user_mailer_redis_namespace` key. A seller in neither would
  be summed up in Elasticsearch, so that delivery goes back to Rails, whose `fetch` fills both caches for the next one.
- Money is formatted for USD only (`formatted_dollar_amount`, with the `$0.99` to `99¢` rule). A refund of a purchase or
  product in another currency, one with a `purchase_presentments` row, and a purchase with a `price_id` or
  `subscription_id` (`price_for_recurrence`) are refused.
- Sender names must be ASCII (`from_email_address_name`'s Latin-script rule is not ported) and, like every address,
  made of plain words for `mime.ts`.
- `MailerInfo` still refuses `preorder_receipt` and `abandoned_cart`: their headers carry purchase, charge
  and workflow ids and `EmailDeliveryObserver` writes a `CustomerEmailInfo` after the send.

Not ported, and why:

| Method | Reason |
| --- | --- |
| `grouped_receipt` | Claims a 24-hour Redis send window (`claim_grouped_receipt_send`, a write before the mail) and renders several chargeables with one shared Reply-To; it also needs everything `receipt` still refuses. |
| `receipt` (the refused shapes) | See "CustomerMailer#receipt" below. |
| `preorder_receipt` | Header ids (`Preorder.find(...).authorization_purchase`), the `CustomerEmailInfo` write, and time-zone formatting of the release date. |
| `auto_invoice` | The invoice PDF is rendered by `InvoicePdfGenerator` through a headless browser, whose bytes are not reproducible. |
| `subscription_restarted` | `Subscription#refresh_token` writes a random token (`update!` with callbacks and PaperTrail) before rendering. |
| `abandoned_cart`, `abandoned_cart_preview` | Writes `SentAbandonedCartEmail` and Redis claims, and renders `message_with_inline_abandoned_cart_products`. |
| `review_response` | Takes a record (GlobalID), whose Ruby `#inspect` is not ported, and renders `ProductReviewPresenter`. |
| `upcoming_call_reminder` | Renders `ReceiptPresenter::ItemInfo` (product card, thumbnails, buyer-currency amounts). |
| `send_to_kindle` | Downloads the file with `Aws::S3::Object#download_file` (ranged GETs) and may attach a stamped PDF. |

## TeamMailer (WS-73)

`TeamMailer#invite` is ported (golden: `team-mailer.golden.json`, from `generate-team-mailer-golden.rb`; 16 messages and the
missing-record error, with every statement, the HTML and the encoded message). It is the first ported mailer that takes a record:
the delivery job locates the `TeamInvitation` (GlobalID), `invite` re-reads it from the writer with its seller preloaded, and the
X-GUM `mailer_args` carry the located record's `#inspect` (`record-inspect.ts`, rendered from the row, strings cut to 50 characters).

- Known divergence: a JavaScript Date holds milliseconds, so the microseconds of the invitation's `datetime(6)` columns read back as
  `.mmm000` in that header (the same limit as `models/README.md`, "Time"). Only the SendGrid tracking argument (or the encrypted Resend
  header) differs; the message itself does not.
- An invitation email Ruby's `Mail::AddressList` could read differently from the format check (a quoted local part, an IP literal, or
  characters outside `[A-Za-z0-9._%+-]`) is refused (`MailViewNotPortedError`) and the delivery goes back to Rails.
- `invitation_accepted` stays in Rails: it renders `User#avatar_url` (Active Storage variants through the Rails cache) and a sanitized display name.

Still Ruby, with the reasons in the table above: `grouped_receipt`, `preorder_receipt`, `auto_invoice`, `subscription_restarted`,
`abandoned_cart*`, `review_response`, `upcoming_call_reminder`, `send_to_kindle`, and the receipts below.

## CustomerMailer#receipt (WS-76, widened in WS-85)

`receipt(purchase_id)` renders in Node for the purchases below and refuses (`MailViewNotPortedError`, so the delivery or the job goes back
to Rails before anything is sent or written) for the rest. Goldens: `receipt-mailer.golden.json` from `generate-receipt-mailer-golden.rb`, which
runs the real mailer inside the Sidekiq executor (query cache on) against a scratch MySQL and Elasticsearch: 105 messages replayed statement for
statement (and Elasticsearch request for request), HTML, encoded message, Router Redis; 23 refusals Rails sends; one error. The generator puts a
recording proxy between `EsClient` and a scratch `ws85-link` index (`search/__fixtures__/es_recording_proxy.rb`), and the test hands the recorded
answers back through `setEsSender`. `mailers/receipt-presenter.ts` holds the presenter parts as pure functions of rows (`mailSubject`,
`chargeInfo`, `paymentInfo`, `shippingInfo`, `itemInfo`, `assertSupported`); `mailers/receipt-recommended.ts` the recommended products section and
`mailers/receipt-tax.ts` the tax lines; `mailers/receipt-mailer.ts` reads in the order the view asks (so the first occurrence of each distinct
statement matches; repeats are query-cache hits on both sides) and holds the templates.

Rendered: one successful purchase of a digital, course, ebook, newsletter, podcast, audiobook, physical or coffee product, outside a subscription,
preorder, gift, bundle, rental, call or commission, made by a guest or a signed-in buyer who is not the seller, with a per-variant name, quantity,
tip, custom fields (text and checkbox), refund policy, custom receipt text, a download button, a licence key, free or paid, shipping line and
address, a card or wallet line, and:

- **Another currency.** The price line is `get_usd_cents(displayed_price_currency_type, displayed_price_cents, rate: rate_converted_to_usd)`
  (`models/concerns/currency-helper.ts`); the product price and tip stay in the purchase's currency. A purchase without a stored rate (Rails looks
  it up in Redis) or in a currency the money gem does not know is refused.
- **Buyer currency.** A `purchase_presentments` row states price, shipping, tax and total in the buyer's currency through
  `formatChargePresentmentAmount`, and drops the USD note. `buyer_presentment_display?` reads the purchase's refunds that moved money; the receipt
  stays in the buyer's currency only if each has a buyer-currency snapshot, which is not read, so any such refund (including a failed one whose
  balance was not reversed) is refused.
- **Tax.** A purchase with the `was_purchase_taxable` flag shows the tax line `Purchase#tax_label` names (VAT/GST/CT/Service tax with the rate
  truncated, or Sales tax and "(included)"), from `non_refunded_tax_amount` (Gumroad-collected tax net of `refunds.effective`) or the seller's tax
  cents. Tax cents without the flag show no line, as in Rails. Canadian splits (a TaxJar row with GST/PST/QST rates) and a creator's own tax rate
  (the creator tax ID in the zip tax rate's JSON data) are refused.
- **Recommended products.** A seller who recommends their own products (`own_products`): `SalesRelatedProductsInfo.related_products` (the cached
  counts, highest first, ties by higher product id), then the creator-featured search (`searchProductsWithFacets`, so Elasticsearch gets the
  bytes Rails sent) for what is missing out of four. Rails loads the cards with `includes(ProductPresenter::ASSOCIATIONS_FOR_CARD)`, so a card costs
  no statements of its own; `preloadCardAssociations` sends the preloads in the order Rails' preloader sends them and the card is built from those
  rows. The title is "Customers who bought this item also bought" when every product came from the cache, else "More from this creator".
  Refused: the affiliate recommendation types; a recommended product with a thumbnail or asset preview, a SKU, a variant category or tier, bundle
  products, a purchase limit, a default offer code, a membership or bundle, or rental prices; a seller with a seller-wide sale or an uploaded avatar;
  four or more associated product ids (Rails samples half of them with `Array#sample`); a buyer who owns bundles.

Refused: a `Charge` receipt (`uses_charge_receipt?`), gift sender or receiver, preorder, membership/installment/free trial, bundle and bundle
member, rental, call and commission, a licensed product with versions (the license key's rich-content check), an uploaded avatar or thumbnail
(Active Storage variants), a test purchase (seller buying their own product), a Canadian tax split, a buyer-currency purchase with refunds, and a
seller with an affiliate recommendation type. Text that goes through `auto_link` or `simple_format` (custom field values, the custom receipt text,
shipping lines, the refund fine print) is refused unless it is plain ASCII (or a currency sign: `¢€£¥₩`) without markup, a URL, an address or an
entity, because rails_autolink and the HTML sanitizer are not ported. **Sellers with an uploaded avatar, products with a thumbnail and receipts
with links in the custom text still go to Rails**: the avatar URL reads `Rails.cache` (memcached) and asks storage whether the variant file
exists, neither of which the golden generator records yet.

- The IVs. `SecureExternalId` (the unsubscribe link, a GCM message with a 12-byte IV) and the Resend X-GUM headers (CBC, 16 bytes) draw from
  `OpenSSL::Cipher#random_iv`. The generator stubs it with a numbered sequence (`"%06d-ws76-iv-x"` cut to the cipher's `iv_len`), records the
  bytes it handed out in each case's `ivs`, and the Node test injects the same bytes through `MailerDeps.randomIv` in the same order, so the
  unsubscribe token and the encrypted headers are compared byte for byte. In production both are random, as in Ruby.
- Reads Node does not make: none that change what is sent. `$redis.get("recommended_products_associated_product_ids_limit")` is read (default
  100); the `Array#sample` of four or more associated ids is refused rather than reproduced.
- The sender name must be plain words for `mime.ts` (a name such as `Tom & <Jerry>` is refused at encoding, not rendering).
- `delivery_method_options` counts against the Router after the content renders, so a refusal never counts a Resend send; Ruby counts it
  before rendering. (Same ordering as the refund mails.)

`SendPurchaseReceiptJob` is ported (`src/worker/jobs/send-purchase-receipt-job.ts`, golden cases `jobs` in the same file): it renders and sends
inline, then `markCustomerEmailSent` writes the `email_infos` row (`BEGIN`, `INSERT`, `COMMIT` as `mark_sent!` sends them). It hands the job back
to Rails, before it has sent or written anything, when the purchase needs its PDFs stamped (`StampPdfForPurchaseJob.perform_async` is the job's
first write and is not ported) or when the receipt is refused above.

## Behaviour kept from Ruby on purpose

These look like bugs but are what recipients get today, so the port reproduces them:

- premailer inlines rules from `@media print` (no parentheses, so not treated as a media query).
- `bgcolor` from an `rgb()` colour is written without `#` (`ensure_hex`).
- A `font` shorthand does not override weight properties already set (`||=`).
- A `style` value containing `]` loses its declarations (the `[SPEC=…[…]]` parser).
- `html_to_text`'s last substitution reuses `$1` where it means the third group.
- A dimension shorthand with more than four values raises in css_parser and fails the email.
- The Router reads its Redis numbers with `to_f`/`to_i`, so `"12abc"` is 12 and unset counters
  keep a domain on SendGrid. Folding turns tabs in a header into spaces and drops trailing ones.
- `validate_from_email_domain!` runs before the United Internet redirect, and the X-GUM headers
  after it, so a redirected message carries SendGrid's headers.

`mime.ts` writes the Date header in the process's time zone, as `DateTime.now` does; production
runs in UTC.

## Known differences

- A delivery the port refuses after the Router picked Resend has already counted against the
  day's Resend cap; Rails counts it again when it renders the handed-back job.
