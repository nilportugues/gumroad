// Generates docs/nextjs-rewrite/backlog.md: what is left to port, counted from the code, with the tasks that cover it.
// Run `node scripts/backlog.ts` from nextjs/; `--check` fails when the document is stale (wired next to remaining-work).
// Everything in the tables is counted (routes, pages, jobs, hand-back sites in src, recorded `hands ...` examples in spec/).
// The epics in EPICS are written by hand: their counts are computed from a path pattern, their state and estimate are not.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CRON_SCHEDULE, JOB_REGISTRY } from "../src/server/jobs/registry.generated.ts";
import { pageStatus, parseRoutes, rows } from "./remaining-work.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OUTPUT = join(repoRoot, "docs/nextjs-rewrite/backlog.md");
const SRC_DIRS = ["nextjs/src/server", "nextjs/src/worker"];
const SPEC_DIR = join(repoRoot, "spec");

// A hand-back site is one place where Node refuses part of a request or run and Rails (or Ruby) does the rest.
const SITE = /new HandBackToRails\b|new NotPortedError\b|\bhandBack\(|\bnotPorted\(/gu;
// A recorded unported shape is a Rails parity example whose title says it hands the request to Rails.
const HANDS_EXAMPLE = /^\s*(?:it|specify)\s+["'][^"'\n]*\bhands?\b[^"'\n]*["']/gmu;

function walk(dir: string, keep: (name: string, full: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "__fixtures__" || name === ".next") continue;
      walk(full, keep, out);
    } else if (keep(name, full)) out.push(full);
  }
  return out;
}

const rel = (full: string) => relative(repoRoot, full);

function handBackSites(): Map<string, number> {
  const bySite = new Map<string, number>();
  for (const dir of SRC_DIRS) {
    const files = walk(join(repoRoot, dir), (name) => name.endsWith(".ts") && !/\.(test|replay\.test)\.ts$/u.test(name));
    for (const file of files) {
      const count = [...readFileSync(file, "utf8").matchAll(SITE)].length;
      if (count > 0) bySite.set(rel(file), count);
    }
  }
  return bySite;
}

function recordedHandBacks(): Map<string, number> {
  const bySpec = new Map<string, number>();
  for (const file of walk(SPEC_DIR, (name) => name.endsWith("_parity_spec.rb"))) {
    const count = [...readFileSync(file, "utf8").matchAll(HANDS_EXAMPLE)].length;
    if (count > 0) bySpec.set(rel(file), count);
  }
  return bySpec;
}

type Epic = {
  id: string;
  title: string;
  // Hand-back sites in these source files and recorded examples in these specs belong to the epic.
  files: RegExp;
  // Second pass: only consulted for a path no epic's `files` claims, so widening a long tail never steals from another epic.
  fallback?: RegExp;
  state: string;
  blocker: string;
  scope: string;
};

// Order matters: a file belongs to the first epic whose pattern matches it.
const EPICS: Epic[] = [
  {
    id: "E01",
    title: "Paid checkout (card purchase, order, charge)",
    files: /orders|purchase-(create|success|fees|response|license)|charge-|order-|free-order|checkout|customer-surcharge|purchase-sales-tax|stripe\/(payment|charge|setup)/u,
    fallback: /purchase-pricing|merge-carts|models\/(charge|order|credit)\.ts|cart-items/u,
    state: "in progress (WS-20; free orders done, paid shape recorded, post-charge half being ported)",
    blocker:
      "Rails order recorded for one happy path only; ambiguous outcomes (timeout after intent create, 3DS, late client confirmation) have no recording, and a Node failure between intent create and purchase update would leave a charged card.",
    scope:
      "Order::ChargeService (930 lines), Charge::CreateService (491), payment-intent create with mandate/UPI/FX/direct-charge branches, processor fee and balance rows, affiliate credits, success jobs; then memberships, discounts, tips, tax, buyer currency, PayPal and 3DS.",
  },
  {
    id: "E02",
    title: "Payouts (instant payout, create_payments, ProcessPaymentWorker)",
    files: /payout|payment-state|process-payment|bank-account|stripe\/payout/u,
    fallback: /models\/payment\.ts/u,
    state: "in progress (failure paths recorded: 17 examples; Node models and Stripe client being built)",
    blocker: "Payment state machine, Payouts.create_payments, a Stripe client with the gem's retry/idempotency behaviour.",
    scope: "Instant payout, scheduled payouts, PayPal payouts, payout holds, reversal of internal transfers, payouts page branches.",
  },
  {
    id: "E03",
    title: "Refunds and the ledger (FlowOfFunds)",
    files: /refund|flow-of-funds|dispute|balance/u,
    state: "in progress (post-call failure branches being recorded; ledger being ported)",
    blocker: "Only the success path was recorded; ledger, error handling around StripeChargeProcessor#refund!, Connect, PayPal, Braintree refunds.",
    scope: "Full and partial refund, destination-charge and fee-reversal paths, refund policy enforcement tail, dispute handling writes.",
  },
  {
    id: "E04",
    title: "Stripe account creation and Connect",
    files: /merchant-account|stripe-connect|stripe\/account|settings-payments/u,
    state: "started (failure and no-verdict recordings of the creation save: six hand-back examples; the account, person, company and bank account payload builders are ported against Ruby goldens but no route calls them; UpdateUserComplianceInfo and UpdatePayoutMethod not ported; Stripe Connect callback: documented decision to stay handed back)",
    blocker: "StripeMerchantAccountManager is ~4.8k lines of country and entity payloads; only the US-individual shape is recorded. Stripe Connect code is spent in the token exchange, so no earlier idempotent read exists.",
    scope: "create_account/update_account per country and entity type, Connect OAuth callback, account reconciliation after a Stripe error.",
  },
  {
    id: "E05",
    title: "PayPal, Braintree and processor webhooks",
    files: /paypal|braintree|foreign-webhooks|webhook/u,
    state: "started (HandleStripeEventWorker runs in Node for the deauthorization, capability.updated, standard account.updated, the charge, refund, payment_intent, capital and radar events that end before the ledger or a Stripe call, the seller plan subscription events and the events no branch routes; webhook receivers done; the ledger and Stripe-calling events, PayPal handlers and Braintree hand back)",
    blocker: "No recordings of PayPal/Braintree request sequences; their routes are not registered.",
    scope: "PayPal controller (4 routes), Braintree (2), PayPal orders, refunds, payouts, IPN; Braintree token and charge.",
  },
  {
    id: "E06",
    title: "Sales tax and VAT (WS-22)",
    files: /tax|vat|zip-tax|geoip/u,
    state: "partial (TaxJar via WebMock for the rate update job); validators not started",
    blocker: "TaxJar, ZipTaxRate selection, GeoIP and VAT validators (VIES, Vatstack, IRAS, Revenu Quebec) hand back.",
    scope: "Sales tax at checkout, surcharge preview, VAT id validation, tax forms and transaction reports.",
  },
  {
    id: "E07",
    title: "Sign-in providers and account security",
    files: /omniauth|social-|oauth|passkey|webauthn|totp|team-invit|auth-|login|signup|session|confirmation/u,
    fallback: /instagram/u,
    state: "mostly done (Apple, Twitter, Google, YouTube, Instagram, TikTok, TOTP, team join, passkey login and registration in Node); the Stripe Connect callback, the POST callbacks and the unprovable passkey shapes (signed attestation formats, non-ES256 keys) left",
    blocker: "Single-use codes must not be spent unless every outcome is reproducible.",
    scope: "Remaining OmniAuth callbacks, passkey registration shapes, team invitation for the Gumroad account's own team, unconfirmed-account adoption.",
  },
  {
    id: "E08",
    title: "Content delivery and downloads (WS-16)",
    files: /url-redirect|content-deliver|stream|read-|play|download|media-location|product-file|dropbox/u,
    fallback: /integrations?-|discord|s3-utility/u,
    state: "partial (access gates done; bytes, rich content, posts, integrations, licenses, polls hand back)",
    blocker: "Signed URLs, S3 presign of the test environment, Cloudflare production key and distribution.",
    scope: "stream/read/play/captions past the gate, download pages with files and rich content, ProductFile creation and build promote.",
  },
  {
    id: "E09",
    title: "Product pages, profiles and custom HTML (WS-11/12)",
    files: /profile|product-page|cover|custom-html|interpolator|page-sanitizer|home|pages|asset-preview|section/u,
    fallback: /recommended|widgets|embedded-javascripts/u,
    state: "in progress (covers, nav done; Interpolator wiring and custom HTML pages being ported)",
    blocker: "Pages::ProfileData, ProductPrices, Ai::PageSanitizer.",
    scope: "Custom HTML pages, uploaded video covers, asset previews, product sections, impersonated session on the home pages.",
  },
  {
    id: "E10",
    title: "Public/v2 API and mobile API (WS-17)",
    files: /api-v2|mobile|product-(resource|build|write|create)|link-(create|publish|update)|offer-code|variant|price-writes/u,
    fallback: /api\/v2\//u,
    state: "in progress (v2 create/update done for plain digital products; mobile sales/library shapes left)",
    blocker: "Files, rich content, refund-policy params, covers, non-USD currency, other native types in v2; media location, preorder, membership, refund and review serialization on mobile.",
    scope: "Remaining v2 product params, mobile library and search rows, sales show (CustomerPresenter), remaining mobile writes.",
  },
  {
    id: "E11",
    title: "MCP and AI (WS-19)",
    files: /mcp|ai-|agent|moderation|llm/u,
    state: "in progress (read tools done; OAuth client registration and permalink changes done; memberships in create_draft_product, add_cover, add_file, bundle tools, ProductFileIngest left)",
    blocker: "get_subscriptions churn breakdown (Ruby Float vs Node cached payload).",
    scope: "create_draft_product, update_product, add_cover, add_file, bundle and discount-code tools, client registration.",
  },
  {
    id: "E12",
    title: "Audience, emails, workflows and the receipt mailer (WS-13/15)",
    files: /mail|receipt|workflow|installment|post-|audience|follower|export|customers|analytics/u,
    fallback: /marketing|\bposts?[-.]|imported-customer|events-mutations|test-ping/u,
    state: "partial (renewal receipts, fixed-length, installment and gifted membership receipts hand back; export variants hand back)",
    blocker: "Mailer templates with files that have thumbnails.",
    scope: "Remaining receipt shapes, workflow emails with thumbnails, purchases export families (several variants, gifts, preorders, subscriptions, PayPal, Connect).",
  },
  {
    id: "E13",
    title: "Subscriptions, preorders and memberships",
    files: /subscription|preorder|membership|recurring/u,
    state: "partial (cancellations done; charges and plan changes hand back)",
    blocker: "Charge path (E01) and processor calls.",
    scope: "Subscription charges, plan changes and price updates, preorder charges, free-trial conversions, installment plans.",
  },
  {
    id: "E14",
    title: "Settings, team and admin (WS-10/18)",
    files: /settings|admin|team|brand-account|user-|account/u,
    fallback: /users?-controller|models\/user\.ts|seller-|json-seller|json-actions|custom-domain|help-center|feature-announcement|connections-mutations|piracy/u,
    state: "mostly done; brand accounts that copy a payout setup and the admin web UIs (Flipper, Sidekiq web) left",
    blocker: "Vendor Rack apps (Flipper UI, Sidekiq web) have no Rails recording; the payout copy needs the Stripe account job.",
    scope: "Brand account payout copy, Flipper UI and Sidekiq web.",
  },
  {
    id: "E15",
    title: "Sidekiq jobs and cron (WS-30)",
    files: /^nextjs\/src\/(worker|server\/jobs)|jobs?\/|-job\.|-worker\./u,
    state: "in progress (two agents on it; 187 of 296 classes run in Node, many with prefix hand-backs)",
    blocker: "Money jobs wait on E01-E03; Marshal cache entries and Sidekiq changelog writes for a few.",
    scope: "The Ruby-runtime classes listed in section 4, then the hand-back tails of the ported ones, then removing the Sidekiq bridge.",
  },
  {
    id: "E16",
    title: "Affiliates, collaborators, wishlists, comments and reviews",
    files: /affiliate|collaborator|wishlist|comment|review|follower|utm|commission/u,
    fallback: /communit/u,
    state: "partial (most reads and writes done; each controller still refuses some shapes)",
    blocker: "Per-shape recordings; commission completion needs balance charge (E01/E03).",
    scope: "Affiliate redirect and requests, collaborator invitations, wishlist items, comments, product reviews and responses, UTM links, commissions.",
  },
  {
    id: "E17",
    title: "Purchase management (customers, receipts JSON, license JSON)",
    files: /purchase-json|license-purchase|purchases-controller|purchases-|customer-actions|library|invoice/u,
    fallback: /purchase-custom-field|purchase-product-updates|models\/purchase\.ts|purchase-access-writes|customer-details|shipment|buyer\/products/u,
    state: "partial (revoke access, search, export done; refund, update, resend receipt, confirm and charge actions hand back)",
    blocker: "Refund and charge paths (E01, E03).",
    scope: "PurchasesController actions beyond revoke access, purchase and license JSON shapes, invoices, library writes.",
  },
  {
    id: "E18",
    title: "Request and response fidelity (Rails params/body parsing, ERB, rate limits)",
    files: /rails-(body|params)|erb\/|rack-attack|application-controller|\/infra\/|route-table|mutation\.ts/u,
    fallback: /number-with-delimiter|friendly-id|html-fragment|row-reads|with-filtering|public-handlers|public-data|secure-encrypt|route-redirects/u,
    state: "ongoing (generic refusals for inputs Rails munges or rejects; each is a deliberate hand-back, not a missing feature)",
    blocker: "None; port only if a real request needs the shape.",
    scope: "Nested/duplicate query keys, JSON bodies Rails munges, unsafe numbers, ERB helpers, Rack::Attack corner cases.",
  },
  {
    id: "E19",
    title: "Product editor, bundles and internal endpoints",
    files: /internal|product-editor|editor|seller-products|product-props|links-mutations|bundle|secure-redirect|listing|presenters\//u,
    fallback: /links?-(create|controller|metrics)|models\/link\.ts|products-mutations|rich-content-writes|upsell|product-tags|thumbnails|call-availab|models\/call\.ts/u,
    state: "partial (editor JSON and mutations mostly done; sections, files and rich content shapes hand back)",
    blocker: "ProductFile creation (E08), rich content writes.",
    scope: "Product editor mutations, bundle edits, internal admin endpoints, listing pages and presenters.",
  },
];

const OTHER: Epic = {
  id: "E99",
  title: "Unassigned (no epic pattern matched; triage these)",
  files: /./u,
  state: "n/a",
  blocker: "n/a",
  scope: "Sites and examples that no epic pattern claims.",
};

function epicOf(path: string): Epic {
  const normalized = path.replace(/_/gu, "-");
  return EPICS.find((epic) => epic.files.test(normalized)) ?? EPICS.find((epic) => epic.fallback?.test(normalized)) ?? OTHER;
}

const NON_CODE = [
  "N1 Flag rollout: every converted route sits behind a Flipper flag and none is enabled in production. Enabling each needs the shadow period README.md requires, lowest blast radius first (reads, JSON writes, then money).",
  "N2 Shadow traffic: no GET mirroring or rolled-back write comparison has run in staging or production.",
  "N3 Parity proof for money and security paths: the open items of parity-debt.md section 4 (Cloudflare signed URLs, bucket and distribution choice, receipt rental redirects, the `$` flags).",
  "N4 Open parity tasks (parity-tasks.md): E2 to E5 (cases ported without a recording), E6 (taxonomy routing 404 for one discover example), E8 (lint debt), E9 (`api-coverage.test.ts` and `lint:baseline` in CI for every branch).",
  "N5 Production cutover: per-route flag flips, a written rollback plan per money stream (checkout, refunds, payouts, subscriptions), and the database, Redis and Sidekiq bridges under production load.",
  "N6 Retire the Sidekiq bridge: port every remaining class and cron entry; `critical` (receipts) moves last.",
  "N7 WS-40 Rails removal: delete Rails, the Ruby specs whose fixtures are captured, and the Gemfile; Prisma Migrate takes over the schema from a baseline migration. Not started.",
  "N8 WS-41 drop Inertia (after WS-40): pages become plain Server Components; `routes.ts`, the compat router and `app/javascript` go. Not started.",
];

function rubyLines(file: string): number {
  const full = join(repoRoot, file);
  return existsSync(full) ? readFileSync(full, "utf8").split("\n").length : 0;
}

const n = (value: number) => value.toLocaleString("en-US");
const pct = (part: number, whole: number) => (whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`);

function build(): string {
  const all = rows(parseRoutes());
  const nativeRoutes = all.filter((row) => row.status === "native");
  const remainingRoutes = all.filter((row) => row.status !== "native");
  const pages = pageStatus();
  const jobEntries = Object.entries(JOB_REGISTRY);
  const rubyJobs = jobEntries
    .filter(([, job]) => job.runtime === "ruby")
    .map(([name, job]) => ({ name, queue: String((job.options as Record<string, unknown>).queue ?? "default"), file: job.file, lines: rubyLines(job.file) }))
    .sort((a, b) => a.lines - b.lines || a.name.localeCompare(b.name));
  const nodeJobs = jobEntries.length - rubyJobs.length;
  const cronByClass = new Map(CRON_SCHEDULE.map((entry) => [entry.class, entry.cron]));
  const sites = handBackSites();
  const siteTotal = [...sites.values()].reduce((sum, count) => sum + count, 0);
  const recorded = recordedHandBacks();
  const recordedTotal = [...recorded.values()].reduce((sum, count) => sum + count, 0);

  const perEpic = new Map<string, { epic: Epic; sites: number; siteFiles: number; examples: number; specs: number }>();
  for (const epic of [...EPICS, OTHER]) perEpic.set(epic.id, { epic, sites: 0, siteFiles: 0, examples: 0, specs: 0 });
  for (const [file, count] of sites) {
    const bucket = perEpic.get(epicOf(file).id)!;
    bucket.sites += count;
    bucket.siteFiles += 1;
  }
  for (const [file, count] of recorded) {
    const bucket = perEpic.get(epicOf(file).id)!;
    bucket.examples += count;
    bucket.specs += 1;
  }

  const out: string[] = [];
  out.push("# Backlog: what is left to port");
  out.push("");
  out.push(
    "Generated by `nextjs/scripts/backlog.ts` (run `node scripts/backlog.ts` from `nextjs/`); do not edit by hand. Every number in sections 1 to 6 is counted from the repository; the epics in section 7 are written by hand in the script (their counts are computed, their state and blockers are not). [remaining-work.md](remaining-work.md) has the route/page/job percentages and the method.",
  );
  out.push("");
  out.push("## 1. What is measured");
  out.push("");
  out.push("| Unit | Done | Remaining | Total | How it is counted |");
  out.push("| --- | ---: | ---: | ---: | --- |");
  out.push(`| Routes served natively | ${n(nativeRoutes.length)} | ${n(remainingRoutes.length)} | ${n(all.length)} | \`config/routes*.rb\` against \`routes.json\` and Node code (static) |`);
  out.push(`| Inertia pages with Node props | ${n(pages.ported.length)} | ${n(pages.missing.length)} | ${n(pages.total)} | component names Rails renders against string literals in src/server |`);
  out.push(`| Sidekiq classes running in Node | ${n(nodeJobs)} | ${n(rubyJobs.length)} | ${n(jobEntries.length)} | \`runtime\` in \`registry.generated.ts\` |`);
  out.push(`| Hand-back sites inside ported code | not applicable | ${n(siteTotal)} | in ${n(sites.size)} files | \`HandBackToRails\`, \`NotPortedError\`, \`handBack(\`, \`notPorted(\` in non-test source under src/server and src/worker |`);
  out.push(`| Recorded unported shapes | not applicable | ${n(recordedTotal)} | in ${n(recorded.size)} specs | Rails parity examples whose title says Rails keeps the request ("hands ...") |`);
  out.push("");
  out.push(
    "How to read it. Routes, pages and job classes are the headline units, but a route counts as native once its common path runs, so the real remainder is the hand-back sites row: each is a branch Node refuses and Rails still serves. A site is a place in the code, not a request; several sites can guard one shape and one site can cover many requests, so the number measures where work remains, not how many hours it takes. The recorded-shapes row is the part of that remainder that already has a Rails recording, which is the cheapest to port because the proof exists.",
  );
  out.push("");
  out.push("## 2. Routes not served natively");
  out.push("");
  out.push(`${n(remainingRoutes.length)} routes: ${n(remainingRoutes.filter((r) => r.status === "hands back").length)} listed in \`routes.json\` without Node code (hands back) and ${n(remainingRoutes.filter((r) => r.status === "not registered").length)} not registered (Rails serves them).`);
  out.push("");
  out.push(
    "Known scanner false positives (the static check cannot see these): `GET /products/:product_id/{other_refund_policies,available_offer_codes,builds}` are App Router routes already, and the Google, YouTube, Instagram and TikTok OmniAuth callbacks run in Node through the shared phases handler (`nextjs_omniauth_phases`) although their routes are built from the strategy name. So at least 7 of the rows below are served; the true remainder is correspondingly smaller. The reverse error also exists: a route counted native can still refuse most of its shapes, which is why section 5 matters more than this table.",
  );
  out.push("");
  out.push("| Route | Controller#action | Status | Workstream |");
  out.push("| --- | --- | --- | --- |");
  for (const row of remainingRoutes.sort((a, b) => b.weight - a.weight || `${a.controller}#${a.action}`.localeCompare(`${b.controller}#${b.action}`))) {
    out.push(`| \`${row.method} ${row.path}\` | \`${row.controller}#${row.action}\` | ${row.status} | ${row.workstream} |`);
  }
  out.push("");
  out.push("## 3. Inertia pages without Node props");
  out.push("");
  for (const page of pages.missing) out.push(`- \`${page}\``);
  out.push("");
  out.push("## 4. Sidekiq classes still running in Ruby");
  out.push("");
  out.push(`${n(rubyJobs.length)} classes, smallest Ruby file first (a rough proxy for effort). The ${n(CRON_SCHEDULE.length)} cron entries are in \`registry.generated.ts\`; the Cron column shows the schedule of the class when it has one.`);
  out.push("");
  out.push("| Class | Queue | Ruby lines | Cron | File |");
  out.push("| --- | --- | ---: | --- | --- |");
  for (const job of rubyJobs) out.push(`| \`${job.name}\` | ${job.queue} | ${n(job.lines)} | ${cronByClass.get(job.name) ?? ""} | \`${job.file}\` |`);
  out.push("");
  out.push("## 5. Hand-back sites by area and file");
  out.push("");
  const byArea = new Map<string, { sites: number; files: number }>();
  for (const [file, count] of sites) {
    const parts = file.split("/");
    const area = parts.slice(2, parts[2] === "server" ? 4 : 3).join("/") || parts.slice(0, 3).join("/");
    const key = parts[1] === "src" ? parts.slice(2, 4).join("/") : area;
    const bucket = byArea.get(key) ?? { sites: 0, files: 0 };
    bucket.sites += count;
    bucket.files += 1;
    byArea.set(key, bucket);
  }
  out.push("| Area | Sites | Files |");
  out.push("| --- | ---: | ---: |");
  for (const [area, bucket] of [...byArea].sort((a, b) => b[1].sites - a[1].sites)) out.push(`| \`${area}\` | ${n(bucket.sites)} | ${n(bucket.files)} |`);
  out.push("");
  out.push("The 40 files with the most sites:");
  out.push("");
  out.push("| File | Sites | Epic |");
  out.push("| --- | ---: | --- |");
  for (const [file, count] of [...sites].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40)) out.push(`| \`${file}\` | ${n(count)} | ${epicOf(file).id} |`);
  out.push("");
  out.push("## 6. Recorded unported shapes (Rails examples that say Rails keeps the request)");
  out.push("");
  out.push("The 40 specs with the most. Each example is a concrete shape with a fixture; serving it in Node and flipping the example to a served one is a well-defined task.");
  out.push("");
  out.push("| Spec | Examples | Epic |");
  out.push("| --- | ---: | --- |");
  for (const [file, count] of [...recorded].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40)) out.push(`| \`${file}\` | ${n(count)} | ${epicOf(file).id} |`);
  out.push("");
  out.push("## 7. Epics: the task list");
  out.push("");
  out.push(
    "Each epic owns the hand-back sites and recorded shapes whose file path matches its pattern (first match wins, so the counts add up to the totals above). State and blockers are hand-written as of the date in the script history; the counts are not.",
  );
  out.push("");
  out.push("| Epic | Task | Sites | Recorded shapes | State |");
  out.push("| --- | --- | ---: | ---: | --- |");
  for (const { epic, sites: siteCount, examples } of perEpic.values()) out.push(`| ${epic.id} | ${epic.title} | ${n(siteCount)} | ${n(examples)} | ${epic.state} |`);
  const totalSites = [...perEpic.values()].reduce((sum, bucket) => sum + bucket.sites, 0);
  const totalExamples = [...perEpic.values()].reduce((sum, bucket) => sum + bucket.examples, 0);
  out.push(`| | **Total** | **${n(totalSites)}** | **${n(totalExamples)}** | |`);
  out.push("");
  for (const { epic } of perEpic.values()) {
    if (epic.id === OTHER.id) continue;
    out.push(`### ${epic.id} ${epic.title}`);
    out.push("");
    out.push(`- Scope: ${epic.scope}`);
    out.push(`- Blocker: ${epic.blocker}`);
    out.push(`- State: ${epic.state}`);
    out.push("");
  }
  const other = perEpic.get(OTHER.id)!;
  out.push(`### ${OTHER.id} ${OTHER.title}`);
  out.push("");
  out.push(`${n(other.sites)} sites in ${n(other.siteFiles)} files and ${n(other.examples)} recorded examples in ${n(other.specs)} specs match no epic pattern. Unassigned files with sites:`);
  out.push("");
  for (const [file, count] of [...sites].filter(([file]) => epicOf(file).id === OTHER.id).sort((a, b) => b[1] - a[1]).slice(0, 200)) out.push(`- \`${file}\` (${n(count)})`);
  out.push("");
  const otherSpecs = [...recorded].filter(([file]) => epicOf(file).id === OTHER.id).sort((a, b) => b[1] - a[1]);
  if (otherSpecs.length > 0) {
    out.push("Unassigned specs with recorded examples:");
    out.push("");
    for (const [file, count] of otherSpecs) out.push(`- \`${file}\` (${n(count)})`);
    out.push("");
  }
  out.push("## 8. Non-code tasks (not in any percentage)");
  out.push("");
  for (const item of NON_CODE) out.push(`- ${item}`);
  out.push("");
  out.push("## 9. Estimating the effort");
  out.push("");
  out.push(
    "There is no honest hours figure: the remainder is the hard part (money, processors, ambiguous outcomes), and each port needs a Rails recording before it can be written. What can be stated is observed throughput of the work done so far, one agent run per lane: job rounds ported 3 to 6 classes each (some only as prefix ports), and route/shape rounds closed 3 to 6 routes or one or two recorded families each. Extrapolating, the Ruby job classes alone are about 20 to 35 further rounds, the routes in section 2 about 10 to 15, and the money epics (E01 to E05) are the unknown: each has to land its failure-path recordings before any Node port is safe, so treat them as separate projects and re-estimate after the first one ships.",
  );
  out.push("");
  return out.join("\n");
}

if (import.meta.main) {
  const document = build();
  if (process.argv.includes("--stdout")) process.stdout.write(document);
  else if (process.argv.includes("--check")) {
    if (!existsSync(OUTPUT) || readFileSync(OUTPUT, "utf8") !== document) {
      console.error("docs/nextjs-rewrite/backlog.md is stale; run `node scripts/backlog.ts` from nextjs/");
      process.exit(1);
    }
  } else {
    writeFileSync(OUTPUT, document);
    process.stdout.write(`wrote ${OUTPUT}\n`);
  }
}
