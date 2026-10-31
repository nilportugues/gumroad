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
| Encode | `mime.ts`, `compose.ts` | `Mail::Message#encoded` (mail 2.9) |
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
purchase or charge. `MailerInfo`'s builders refuse `CustomerMailer` and the installment methods,
the only ones that write those ids, so for every ported mailer the observer does nothing.

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

- Markup libxml2 would restructure (implied or auto-closed elements, unknown entities), CSS
  selectors outside the ported Nokogiri subset, remote or missing stylesheets.
- Headers the mail gem would RFC 2047-encode or decode (non-ASCII, CR/LF, `=?`), addresses other
  than `addr` and `Name <addr>` in ASCII, more than one recipient, cc/bcc, single-part messages.
  Long ASCII headers are folded as `UnstructuredField#fold` does.
- Mailer arguments whose Ruby `#inspect` is not ported: records (GlobalID), floats, non-ASCII strings.
- The email layout outside production: it adds a non-ASCII environment banner.

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
