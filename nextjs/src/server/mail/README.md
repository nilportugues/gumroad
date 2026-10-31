# Mail

Email from the Node side, sent byte for byte as ActionMailer sends it. Every stage is checked
against output recorded from the real gems (`__fixtures__/generate-*.rb`), and each stage refuses
input it cannot reproduce exactly instead of approximating it.

| Stage | File | Ruby counterpart |
| --- | --- | --- |
| Enqueue | `active-job.ts` | `deliver_later` → `MailDeliveryJob` in Sidekiq's `JobWrapper` |
| Route | `delivery.ts` `mailRoute` | — |
| Run | `delivery.ts`, `src/worker/jobs/active-job.ts` | `MailDeliveryJob#perform`, `retry_on`, `RescueSmtpErrors` |
| Render | `mailers/*.ts`, `views.ts` | `app/mailers`, `app/views` (ERB) |
| Inline CSS, text part | `premailer/`, `stylesheet.ts` | premailer-rails 1.12, premailer 1.29, css_parser 1.22, Nokogiri 1.19 |
| Encode | `mime.ts`, `compose.ts` | `Mail::Message#encoded` (mail 2.9) |
| Send | `smtp.ts` | `Mail::SMTP` over net-smtp 0.5 |

## How a mail gets sent

`deliverLater` builds the exact Sidekiq item Rails pushes (`mail.golden.json`'s `enqueue` cases).
By default it goes to Sidekiq and Rails delivers it, so calling it from Node is safe for any
mailer. With `NODE_MAIL_DELIVERY=enabled` (production only), mailer methods listed in
`delivery.ts`'s `NODE_MAILERS` go to BullMQ instead and the Node worker delivers them. The worker
pushes a job back to Sidekiq unchanged when the method is not ported or rendering hits anything
the port refuses (`NOT_PORTED`), so Rails stays the fallback.

Ruby's `deliver_later` calls still go to Sidekiq: `lib/sidekiq_node_bridge.rb` diverts by
`job["class"]`, which is `JobWrapper` for every ActiveJob. Diverting Ruby-enqueued mail needs the
bridge to also match `job["wrapped"] == "MailDeliveryJob"` and the mailer name in
`job["args"][0]["arguments"][0]`; `src/worker/bridge.ts` already routes such items.

## Porting a mailer

1. Add its calls to `__fixtures__/generate-mail-golden.rb` (`MAILS` for messages, `ENQUEUES` for
   payloads) and regenerate. The script stubs only what the views read; keep the real mailer,
   views, helpers and initializers in play.
2. Port each template as a function that returns the HTML string ERB produces. Erubi drops a line
   holding only `<% %>`, newline included; a `<%= %>` line keeps its indentation and newline even
   when it prints nothing, so write those blanks out (`${/* yield :style */ ""}`): editors strip
   trailing whitespace. Escape every interpolation with `h()` (`ERB::Util.html_escape`), build
   URLs with `mailerUrl()`, and reuse `views.ts` for the layout and partials.
3. Return a `RenderedMail` with the headers the mailer sets. `ApplicationMailer` subclasses also
   need `MailerInfo`'s X-GUM headers, provider routing and `validate_from_email_domain`, which are
   not ported yet.
4. Add the method to `NODE_MAILERS` with its argument deserialization, and a test in the shape of
   `mailers/user-signup-mailer.test.ts`: rendered HTML equals `rendered_html`, and `composeMail`
   with the golden's Date, Message-ID and boundary equals `encoded` and the SMTP envelope.

## What is refused

- Markup libxml2 would restructure (implied or auto-closed elements, unknown entities), CSS
  selectors outside the ported Nokogiri subset, remote or missing stylesheets.
- Headers the mail gem would fold or RFC 2047-encode (non-ASCII, longer than 78 characters),
  addresses other than `addr` and `Name <addr>` in ASCII, more than one recipient, single-part
  messages.
- The email layout outside production: it adds a non-ASCII environment banner.

## Behaviour kept from Ruby on purpose

These look like bugs but are what recipients get today, so the port reproduces them:

- premailer inlines rules from `@media print` (no parentheses, so not treated as a media query).
- `bgcolor` from an `rgb()` colour is written without `#` (`ensure_hex`).
- A `font` shorthand does not override weight properties already set (`||=`).
- A `style` value containing `]` loses its declarations (the `[SPEC=…[…]]` parser).
- `html_to_text`'s last substitution reuses `$1` where it means the third group.
- A dimension shorthand with more than four values raises in css_parser and fails the email.

`mime.ts` writes the Date header in the process's time zone, as `DateTime.now` does; production
runs in UTC.
