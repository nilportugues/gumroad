# Parity harness

Proves a port behaves like the Rails code it replaces (see "Parity" in
[docs/nextjs-rewrite](../../docs/nextjs-rewrite/README.md)). Two tools: golden vectors for pure
functions, and record/replay for endpoints.

```bash
npm run parity                                    # typecheck + all parity tests
PARITY_DATABASE_URL=mysql://root:password@127.0.0.1:3306/parity_test npm run parity   # include replays
ruby __tests__/canonical_test.rb                  # Ruby half of the shared vectors (no bundle needed)
```

## Golden vectors

```bash
bin/golden app/modules/obfuscate_ids.rb nextjs/parity/golden/obfuscate-ids.json
```

The spec JSON names the receiver, the `GlobalConfig` values the file reads at load time, and groups
of calls (`method`, `inputs`, optional `kwargs`, `spread` for multi-argument inputs, `require` and
`load` for dependencies). Output is `{ group: { input: result } }`; exceptions become
`{ "$raises", "message" }` and integers beyond 2^53 `{ "$big" }`. Keep specs in `golden/` so a
fixture can be regenerated. In Vitest, `loadGolden`, `goldenCases` and `goldenInput` from
`parity/src/golden.ts` read them (see `__tests__/golden.test.ts`). Run it with the repo's Ruby;
files that need ActiveSupport must list it under `require` and run under `bundle exec`.

## Recording an endpoint

Tag the example and record:

```ruby
it "follows the seller", parity: true do
  post "/follow", params: { seller_id: seller.external_id, email: "buyer@example.com" }
  ...
end
```

```bash
PARITY_RECORD=1   bin/rspec spec/requests/follow_spec.rb   # examples tagged parity: true
PARITY_RECORD=all bin/rspec spec/requests/follow_spec.rb   # every request/controller example
```

Each passing example writes `fixtures/<spec path>/<example>.json` with one exchange per request
(request and controller specs). An exchange holds:

| Key | Contents |
| --- | --- |
| `seed` | Every non-empty table's rows just before the request, plus `AUTO_INCREMENT` counters |
| `request` | Method, path, query, headers, cookies, raw body |
| `response` | Status, location, headers (minus volatile ones), cookies, and `json`, `inertia` (page props from the HTML) or `body` |
| `db` | Per table: `inserted`, `updated` (changed columns, before and after) and `deleted` rows |
| `redis` | The main Redis database's string, hash and set keys just before the request (Flipper features, the impersonation key), with TTLs |
| `jobs` | Every Sidekiq push: class, args, queue, `at`; ActiveJob wrappers unwrapped |
| `mails` | Every delivered mail: mailer, addresses, subject, text and HTML |
| `http` | Every WebMock-seen call: method, URL, content type, body, and the response it got |

Normalisation, shared by `spec/support/parity/canonical.rb` and `src/canonical.ts` and pinned by
`__tests__/canonical-vectors.json`:

- **Ids.** The recorder resets `AUTO_INCREMENT` before the example (outside its transaction), so ids,
  and the external ids derived from them, are the same on every run. The replayer restores the
  recorded counters, so the port assigns the same ids Rails did.
- **Times.** `DATETIME` values and ISO 8601 timestamps in strings become `<now>` (within 5 s of the
  request), `<now-30s>`, `<now+25m>` or `<now-48h>`; dates become `<today-3d>`. The replayer seeds
  them relative to its own clock.
- **Cookies** minted fresh on every request (`_gumroad_guid`) record their value as `<volatile>`;
  their presence and attributes still compare.
- **Values** are read as MySQL's own text (`CAST(... AS CHAR)`), so both drivers see the same bytes.
  Integers beyond 2^53 are `{ "$big" }`, binary columns `{ "$base64" }`.

## Replaying against Next.js

```ts
import { PrismaClient } from "@prisma/client";
import * as route from "@/app/healthcheck/route";
import { assertParity, prismaExecutor, replayFixture, routeHandlers } from "../src";

it("matches Rails", async () => {
  const sql = prismaExecutor(new PrismaClient());
  const result = await replayFixture("parity/fixtures/requests/healthcheck_spec/returns-ok.json", {
    sql,
    transport: routeHandlers(route), // or httpTransport("http://localhost:3100")
  });
  assertParity(result); // throws a per-path diff: rails value, then next value
});
```

For each exchange the replayer wipes and seeds the database, serves recorded responses to the
port's `fetch` calls, sends the request, and diffs every channel. Options:

- `jobs`, `mails`: `JobsChannel` and `MailChannel` (`src/channels.ts`). WS-05 and WS-06 provide the
  real ones; `memoryJobs()` and `memoryMails()` suit tests. A channel left out compares as empty.
- `compare.ignore`: paths to skip, e.g. `"db.users.updated.*.changes.last_sign_in_ip"` or `"**.token"`.
  The fixture's session cookie value is always skipped (it is encrypted with a random IV), and
  extra response headers on the port's side are allowed.
- `interceptHttp: false` with `httpTransport`: outbound calls then happen in the server process.

The replay database must be disposable: it is truncated table by table.

### Pages

Pages need the proxy (it attaches the Rails envelope) and Next's renderer (it produces the HTML),
so they can only be replayed against a running server: `startNextServer(env)` in `src/next-server.ts`
boots `next dev` on a free port, and `httpTransport(server.baseUrl)` sends the fixtures to it (see
`help-center.replay.test.ts`; the first request to each route compiles it, hence the long timeouts).
The response's `inertia` is read from the page's `data-page`. A controller spec records no Rack
middleware, so those replays use `compare.subset: ["response.cookies"]` and ignore `link` (Vite asset
names), `vary` (Next.js owns it on HTML), `csp_nonce` and the CSRF tokens.

### Signed-in visitors

A request spec that logs in through `POST /login` records the session, remember and
`current_seller_id` cookies a browser holds. They are encrypted with the recording app's
`secret_key_base` (random per checkout in the test environment), which the fixture carries as
`secretKeyBase`: `reencryptCookies` (`src/session.ts`) re-encrypts them for the server under test and
refreshes the remember cookie's timestamp. `redisSeeder` flushes the replay's Redis database and puts
the recorded keys back. Fixtures with setup requests (the CSRF fetch, the login) keep every exchange;
`replayFixtureExchange(fixture, index, options)` replays one.

```ts
await replayFixtureExchange(path, index, {
  sql,
  redis: redisSeeder(redis),
  rewriteRequest: (request, fixture, now) => reencryptCookies(request, fixture, SECRET_KEY_BASE, now),
  transport: httpTransport(server.baseUrl),
  interceptHttp: false,
});
```

Rails specs run with PaperTrail off, so `versions` rows are never recorded; ignore `db.versions` for
replays whose port saves a versioned model. `insert_all` timestamps come from the database clock,
which is the machine's time zone locally.

## Limits

- Elasticsearch and S3 state are not captured or seeded; Redis only for string, hash and set keys of the main database.
- `routeHandlers` calls a route module in-process; handlers using `cookies()` or `headers()` from
  `next/headers` need `httpTransport`.
- Recorded mail bodies and HTTP request bodies are kept verbatim apart from timestamps; random tokens
  in them need an `ignore` path.
- A spec that records times far from now without `travel_to` (`Time.utc(2019)`) re-records with a
  different offset each day; the replay is still correct.
