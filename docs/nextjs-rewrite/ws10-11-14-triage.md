# WS-10, WS-11 and WS-14 triage: what is left unregistered, and why

Every route that `node scripts/remaining-work.ts` still lists as "not registered" in WS-10, WS-11 and WS-14 (plus the one redirect-only
row, `GET /purchases`), checked against the Rails controller and `config/initializers/rack_attack.rb`, not against earlier notes. A throttled
route is never registered natively: Rack::Attack's counters live in Rails' Redis, so a Node answer would skip them
(`rack-attack-throttles.test.ts` fails if one is registered). Where a route has several reasons the row names the first that applies, in the
order throttled, mail, Stripe, external provider, S3, host, layout.

## What changed in this pass

The brief counted 97 + 14 (WS-10), 29 + 4 (WS-11) and 2 (WS-14) unregistered and hands-back rows. Most of them were the counter, not the work:

- **Parser artifacts (do not exist in Rails).** `api-coverage.ts` ignored `only: %i[...]` and a resource nested under a singular resource
  took the wrong base path, so rows existed for routes Rails never defines. Fixed in `parseArgs`, `onlyList` and the nesting base (about 99
  rows across the repo; WS-23n fixed the `preprocess` half in `remaining-work.ts` independently, and the two fixes agree).
- **Rows that were really served.** 18 WS-10/11 "hands back" rows were false negatives of the static check: template-literal patterns, a
  host-prefixed key and literals that carry regex characters. `sourceLiterals` now resolves them, so they count as native.
- **Placeholders replaced by real routes.** `/users/auth/:provider` (three rows) stood for the OmniAuth routes the parser cannot see. The
  28 real ones (`passthru` and `callback`, GET and POST, for 7 providers) replace them, which is why the total grows by 25.
- **Ported.** `GET /oauth/token/info`, the Notion `GET /notion/oauth2/authorize` alias, the signed-in `GET /oauth/authorize` and alias
  hand-backs (a hand-back is registered, so the replay proves it reaches Rails whole), `GET|POST /users/unsubscribe_feature_announcements/:token`
  (the POST one-click write), `GET|POST /users/auth/failure`, `GET /oauth/mobile_pre_authorization/{new,switch_account}`,
  `POST /save_to_library` and `GET /integrations/circle/{communities,space_groups,communities_and_space_groups}`. Each has a `parity: true`
  Rails request spec, recorded fixtures and a replay, with a "hands ..." example for every branch Node does not prove.

Share served natively by the static check: 715 of 953 routes (75.0%) on the `nextjs-rewrite` tip before this branch, 767 of 978 (78.4%)
after it.

## What is left (97 rows)

| Class | Rows |
| --- | --- |
| Throttled (Rack::Attack) | 35 |
| External provider (OmniAuth) | 28 |
| ERB layout page | 21 |
| External provider API | 7 |
| Stripe/PayPal | 1 |
| S3/Active Storage | 1 |
| Mail | 1 |
| Host not modelled | 1 |
| Infra probe | 1 |
| Portable, deferred | 1 |

Classes with no row left: parser artifact (all removed by the fixes above), Elasticsearch as a primary reason (`GET /discover` is throttled
first; it also lists through Elasticsearch) and random token (the token endpoints are throttled first and also issue random tokens).

Exclusion list for `remaining-work.ts`: none is added. After the parser fixes no remaining row is a route Rails does not define, so
excluding rows would only hide work that exists. The one wildcard row, `GET /(*path)`, is the real 404 catch-all.

## Rows

### Infra probe (1)

| Workstream | Route | Controller | Reason |
| --- | --- | --- | --- |
| WS-11 | `GET /healthcheck` | `healthcheck#index` | the blue/green deploy gate (comment in the controller): must answer with nothing else running, so it stays on Rails |

### Throttled (35)

| Workstream | Route | Controller | Reason |
| --- | --- | --- | --- |
| WS-10 | `POST /oauth/device/code` | `oauth/device_codes#create` | `oauth_device_code/ip` (rack_attack.rb); also issues a random device code |
| WS-10 | `GET /oauth/device` | `oauth/device_authorizations#new` | `oauth_device_authorization_lookup/ip` |
| WS-10 | `POST /oauth/device` | `oauth/device_authorizations#create` | `oauth_device_authorization_decision/ip` |
| WS-11 | `GET /` | `home#about` | `throttle_by_ip path: "/"` (60 per 30s); the page also depends on the request host (custom domain, subdomain or main) |
| WS-14 | `GET /discover` | `discover#index` | `throttle_by_ip path: "/discover"`; the page is also an Elasticsearch listing |
| WS-10 | `POST /mobile/forgot_password` | `user/passwords#create` | `password_reset/ip` and `password_reset/email`; sends the reset mail |
| WS-10 | `POST /muse/v1/oauth2/token(.:format)` | `oauth/tokens#create` | `oauth_token/ip` (+ `oauth_device_token/ip/device_code`); issues a random access token |
| WS-10 | `POST /claude/v1/oauth2/token(.:format)` | `oauth/tokens#create` | `oauth_token/ip` (+ `oauth_device_token/ip/device_code`); issues a random access token |
| WS-10 | `POST /chatgpt/v1/oauth2/token(.:format)` | `oauth/tokens#create` | `oauth_token/ip` (+ `oauth_device_token/ip/device_code`); issues a random access token |
| WS-11 | `POST /help/contact` | `help_center/contacts#create` | `help_center_contact/ip`; mails support |
| WS-10 | `GET /signup` | `signup#new` | `throttle_by_ip path: "/signup"` (every method) |
| WS-10 | `POST /signup` | `signup#create` | `throttle_by_ip path: "/signup"` (every method) |
| WS-10 | `POST /login` | `logins#create` | `throttle_by_ip path: "/login"` (POST); sets the session |
| WS-10 | `POST /login/passkey/options` | `logins/passkeys#options` | `/ip:/login/passkey/options:POST`; WebAuthn challenge |
| WS-10 | `POST /login/passkey` | `logins/passkeys#create` | `/ip:/login/passkey:POST`; WebAuthn assertion |
| WS-10 | `POST /sellers/brand_accounts` | `sellers/brand_accounts#create` | `throttle_by_ip path: "/sellers/brand_accounts"` (POST); confirmation mail |
| WS-10 | `POST /settings/totp/confirm` | `settings/totp#confirm` | `throttle_by_params path: "/settings/totp/confirm"` |
| WS-10 | `POST /settings/passkeys` | `settings/passkeys#create` | `/params:/settings/passkeys:POST` |
| WS-10 | `POST /settings/passkeys/registration_options` | `settings/passkeys#registration_options` | `/params:/settings/passkeys/registration_options:POST` |
| WS-10 | `POST /two-factor` | `two_factor_authentication#create` | `throttle_by_params path: "/two-factor"` (user_id) |
| WS-10 | `GET /two-factor/verify` | `two_factor_authentication#verify` | `throttle_by_params path: "/two-factor/verify"` (user_id) |
| WS-10 | `POST /two-factor/resend_authentication_token` | `two_factor_authentication#resend_authentication_token` | `throttle_by_params path: "/two-factor/resend_authentication_token"` (user_id) |
| WS-10 | `POST /two-factor/switch_to_email` | `two_factor_authentication#switch_to_email` | `throttle_by_params path: "/two-factor/switch_to_email"` (user_id) |
| WS-10 | `POST /two-factor/switch_to_recovery` | `two_factor_authentication#switch_to_recovery` | `throttle_by_params path: "/two-factor/switch_to_recovery"` (user_id) |
| WS-10 | `POST /two-factor/switch_to_authenticator` | `two_factor_authentication#switch_to_authenticator` | `throttle_by_params path: "/two-factor/switch_to_authenticator"` (user_id) |
| Redir | `GET /purchases` | `redirects#redirect` | `throttle_by_ip path: "/purchases"` and `throttle_by_ip_for_period` |
| WS-11 | `GET /charge_data` | `public#charge_data` | `/ip:<path>` and `grouped_receipt:email`; mails a grouped receipt |
| WS-11 | `GET /license_key_lookup_data` | `public#license_key_lookup_data` | `/ip:<path>` and `grouped_receipt:email`; mails a grouped receipt |
| WS-11 | `GET /paypal_charge_data` | `public#paypal_charge_data` | `/ip:<path>` and `grouped_receipt:email`; mails a grouped receipt |
| WS-11 | `GET /` | `public#home` | `throttle_by_ip path: "/"` (60 per 30s); the page also depends on the request host (custom domain, subdomain or main) |
| WS-10 | `GET /:username/landing/products` | `users#landing_products` | `throttle_by_ip_and_params` on `%r{\A/(?:[^/]+/)?landing/products\z}`; custom-domain host |
| WS-10 | `GET /landing/products` | `users#landing_products` | `throttle_by_ip_and_params` on `%r{\A/(?:[^/]+/)?landing/products\z}`; custom-domain host |
| WS-10 | `GET /` | `users#show` | `throttle_by_ip path: "/"` (60 per 30s); the page also depends on the request host (custom domain, subdomain or main) |
| WS-10 | `POST /users/forgot_password` | `user/passwords#create` | `password_reset/ip` and `password_reset/email`; sends the reset mail |
| WS-10 | `POST /oauth/token` | `oauth/tokens#create` | `oauth_token/ip` (+ `oauth_device_token/ip/device_code`); issues a random access token |

### ERB layout page (21)

| Workstream | Route | Controller | Reason |
| --- | --- | --- | --- |
| WS-11 | `GET /profile/:username` | `third_party_analytics#profile` | `third_party_analytics#profile` renders the analytics snippets inside a bare layout with CSP off |
| WS-11 | `GET /(*path)` | `application#e404_page` | `e404` renders the 404 layout |
| WS-11 | `GET /js/gumroad` | `embedded_javascripts#overlay` | `render :index` with Vite stylesheet lookup (`resolve_entries`) and the bundle path |
| WS-11 | `GET /js/gumroad-overlay` | `embedded_javascripts#overlay` | `render :index` with Vite stylesheet lookup (`resolve_entries`) and the bundle path |
| WS-11 | `GET /js/gumroad-embed` | `embedded_javascripts#embed` | `render :index` with Vite stylesheet lookup (`resolve_entries`) and the bundle path |
| WS-11 | `GET /js/gumroad-multioverlay` | `embedded_javascripts#overlay` | `render :index` with Vite stylesheet lookup (`resolve_entries`) and the bundle path |
| WS-11 | `GET /about` | `home#about` | `layout "home"` marketing page |
| WS-11 | `GET /gumclaw` | `gumclaw#index` | `layout "home"` marketing page |
| WS-11 | `GET /muse` | `mcp_connectors#show` | `layout "home"` marketing page |
| WS-11 | `GET /claude` | `mcp_connectors#show` | `layout "home"` marketing page |
| WS-11 | `GET /mcp` | `mcp_connectors#index` | `layout "home"` marketing page |
| WS-11 | `GET /features` | `home#features` | `layout "home"` marketing page |
| WS-11 | `GET /pricing` | `home#pricing` | `layout "home"` marketing page |
| WS-11 | `GET /terms` | `home#terms` | `layout "home"` marketing page |
| WS-11 | `GET /prohibited` | `home#prohibited` | `layout "home"` marketing page |
| WS-11 | `GET /privacy` | `home#privacy` | `layout "home"` marketing page |
| WS-11 | `GET /dpa` | `home#dpa` | `layout "home"` marketing page |
| WS-11 | `GET /hackathon` | `home#hackathon` | `layout "home"` marketing page |
| WS-11 | `GET /small-bets` | `home#small_bets` | `layout "home"` marketing page |
| WS-11 | `GET /saas` | `home#saas` | `layout "home"` marketing page |
| WS-10 | `GET /users/confirmation/new` | `confirmations#new` | Devise view rendered through the layout |

### Portable, deferred (1)

| Workstream | Route | Controller | Reason |
| --- | --- | --- | --- |
| WS-10 | `GET /profile/products/:id` | `settings/profile/products#show` | `ProductPresenter#product_props` JSON for a non-editable product; the presenter is not ported (WS-12) |

### Stripe/PayPal (1)

| Workstream | Route | Controller | Reason |
| --- | --- | --- | --- |
| WS-10 | `GET /seller_plan/checkout` | `seller_plan#checkout` | `SellerPlan::Checkout` creates a hosted Stripe Checkout session |

### External provider API (7)

| Workstream | Route | Controller | Reason |
| --- | --- | --- | --- |
| WS-10 | `GET /integrations/discord/server_info` | `integrations/discord#server_info` | `DiscordApi` call to the guild |
| WS-10 | `GET /integrations/zoom/account_info` | `integrations/zoom#account_info` | Zoom OAuth/API call |
| WS-10 | `GET /integrations/zoom/oauth_redirect` | `integrations/zoom#oauth_redirect` | Zoom OAuth/API call |
| WS-10 | `GET /integrations/google_calendar/account_info` | `integrations/google_calendar#account_info` | Google OAuth/Calendar API call |
| WS-10 | `GET /integrations/google_calendar/calendar_list` | `integrations/google_calendar#calendar_list` | Google OAuth/Calendar API call |
| WS-10 | `GET /integrations/google_calendar/oauth_redirect` | `integrations/google_calendar#oauth_redirect` | Google OAuth/Calendar API call |
| WS-10 | `POST /custom_domain/verify` | `custom_domain/verifications#create` | `CustomDomainVerificationService` resolves DNS |

### S3/Active Storage (1)

| Workstream | Route | Controller | Reason |
| --- | --- | --- | --- |
| WS-11 | `GET /_/test/outgoing_traffic` | `test#outgoing_traffic` | reads an object from the `gumroad` S3 bucket; a probe, not product traffic |

### Host not modelled (1)

| Workstream | Route | Controller | Reason |
| --- | --- | --- | --- |
| WS-11 | `GET /.well-known/acme-challenge/:token` | `acme_challenges#show` | challenge content for the host the certificate is being issued for (`request.host`); the answer is per custom domain |

### Mail (1)

| Workstream | Route | Controller | Reason |
| --- | --- | --- | --- |
| WS-10 | `POST /users/confirmation` | `confirmations#create` | Devise `resend_confirmation_instructions` mails the user (no rack_attack rule) |

### External provider (OmniAuth) (28)

| Workstream | Route | Controller | Reason |
| --- | --- | --- | --- |
| WS-10 | `GET /users/auth/twitter` | `user/omniauth_callbacks#passthru` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `POST /users/auth/twitter` | `user/omniauth_callbacks#passthru` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `GET /users/auth/twitter/callback` | `user/omniauth_callbacks#twitter` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `POST /users/auth/twitter/callback` | `user/omniauth_callbacks#twitter` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `GET /users/auth/stripe_connect` | `user/omniauth_callbacks#passthru` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `POST /users/auth/stripe_connect` | `user/omniauth_callbacks#passthru` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `GET /users/auth/stripe_connect/callback` | `user/omniauth_callbacks#stripe_connect` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `POST /users/auth/stripe_connect/callback` | `user/omniauth_callbacks#stripe_connect` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `GET /users/auth/google_oauth2` | `user/omniauth_callbacks#passthru` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `POST /users/auth/google_oauth2` | `user/omniauth_callbacks#passthru` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `GET /users/auth/google_oauth2/callback` | `user/omniauth_callbacks#google_oauth2` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `POST /users/auth/google_oauth2/callback` | `user/omniauth_callbacks#google_oauth2` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `GET /users/auth/youtube` | `user/omniauth_callbacks#passthru` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `POST /users/auth/youtube` | `user/omniauth_callbacks#passthru` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `GET /users/auth/youtube/callback` | `user/omniauth_callbacks#youtube` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `POST /users/auth/youtube/callback` | `user/omniauth_callbacks#youtube` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `GET /users/auth/instagram` | `user/omniauth_callbacks#passthru` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `POST /users/auth/instagram` | `user/omniauth_callbacks#passthru` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `GET /users/auth/instagram/callback` | `user/omniauth_callbacks#instagram` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `POST /users/auth/instagram/callback` | `user/omniauth_callbacks#instagram` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `GET /users/auth/tiktok` | `user/omniauth_callbacks#passthru` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `POST /users/auth/tiktok` | `user/omniauth_callbacks#passthru` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `GET /users/auth/tiktok/callback` | `user/omniauth_callbacks#tiktok` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `POST /users/auth/tiktok/callback` | `user/omniauth_callbacks#tiktok` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `GET /users/auth/apple` | `user/omniauth_callbacks#passthru` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `POST /users/auth/apple` | `user/omniauth_callbacks#passthru` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `GET /users/auth/apple/callback` | `user/omniauth_callbacks#apple` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |
| WS-10 | `POST /users/auth/apple/callback` | `user/omniauth_callbacks#apple` | OmniAuth middleware redirects to the provider and `/callback` exchanges its code for a token over HTTP; the sign-in that follows creates users and sessions |

## Portable but not ported

`GET /profile/products/:id` (`Settings::Profile::ProductsController#show`) is a read-only JSON page, but its body is
`ProductPresenter#product_props`, which belongs to WS-12 (covers, files, taxonomy, tiers, preorders). It should be ported with that
presenter, not on its own.
