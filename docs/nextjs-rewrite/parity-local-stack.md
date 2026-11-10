# Running the parity suite locally (Docker)

The stack that recorded and replayed fixtures for the `nextjs-rewrite` branch. Everything runs from
`docker/docker-compose-local.yml` plus one Ruby container; nothing needs Sidekiq Pro credentials.

## Services

```bash
docker compose -f docker/docker-compose-local.yml -p gumroad up -d db redis elasticsearch minio createbuckets
# DynamoDB Local on a host port can collide (8002 was taken), so run it without publishing:
docker run -d --name gr-dynamo --network gumroad_default --network-alias dynamodb --user root \
  -w /home/dynamodblocal amazon/dynamodb-local:3.3.1 -jar DynamoDBLocal.jar -sharedDb -inMemory
```

Ruby: `ruby:3.4.12-bookworm` with the repo mounted at `/app`, `BUNDLE_PATH=/bundle` on a named volume,
`apt-get install default-libmysqlclient-dev libvips libmagickwand-dev libpq-dev libyaml-dev`, `bundle install`
(`sidekiq-pro` is `install_if`-guarded and skipped), then `rails db:create db:schema:load` with `RAILS_ENV=test`.

## Recording environment

Point Rails at the service names, and record with the values the replays use:

| Variable | Value | Why |
| --- | --- | --- |
| `DATABASE_HOST`, `REDIS_HOST`, `ELASTICSEARCH_HOST`, `DYNAMODB_ENDPOINT` | `db`, `redis:6379/10`, `http://elasticsearch:9200`, `http://dynamodb:8000` | `dynamodb`, `redis`, `elasticsearch` and `minio` are in VCR's ignored hosts; `gr-dynamo` is not |
| `AWS_S3_ENDPOINT` | `http://localhost:9010` | The fixtures embed this host in file URLs and the Node parser only recognises it. Forward `localhost:9010` to `minio:9000` in the Ruby container (`socat`) and on the machine running the replays |
| `SECRET_KEY_BASE` | `parity-replay-secret-key-base` | Signed tokens in a fixture (unsubscribe links, admin cursors) verify only under the secret the replay boots with |

`PARITY_RECORD=1` for request specs, `PARITY_RECORD=all` for controller specs. Re-recording rewrites every
fixture of the file, so `git checkout` the ones that did not change meaning and keep the new or fixed ones.

## Replay environment

Use a database **other than the recording one** (`gumroad_replay`, schema copied with `mysqldump --no-data`): a
replay seeds rows into it, and the next recording then fails on taken usernames. Use a Redis database outside the
`14`-`21` block the recorder leases.

```bash
PARITY_DATABASE_URL=mysql://root:password@<db-ip>:3306/gumroad_replay PARITY_REDIS_HOST=<redis-ip>:6379/40 \
ELASTICSEARCH_HOST=http://<es-ip>:9200 AWS_S3_ENDPOINT=http://localhost:9010 DYNAMODB_ENDPOINT=http://localhost:8012 \
npx vitest run --config parity/vitest.config.ts parity/__tests__/<file>
```

## Traps that cost time

- The purchase factories charge a card through Stripe and fail with "We couldn't charge your card". Specs that only
  need the row build it: `build(:purchase, ..., purchase_state: "successful").save!(validate: false)`. A later
  `update!` on that row revalidates and fails the same way: use `update_attribute` / `update_columns`.
- A request spec with `has_http_status(:found)` on an Inertia write gets `303`; the fixture records what Rails says.
- A hand-back example must be named `hands a ...` (`hands an ...` in the mobile and auth replays): the replay then
  asserts the request reached the Rails stand-in and wrote nothing, instead of comparing a response.
- Mail enqueued by a request spec goes through the test adapter, so fixtures hold no mail job; the replays assert it.
- Hour-granular relative timestamps (`<now-7296h>`) flip a date near UTC midnight: two `subscription_end_date`
  examples in `api-v2-ws17b` fail between roughly 23:00 and 01:00 UTC and pass otherwise.

## State at the last full run

All 59 replay files pass (2,653 tests); see [parity-tasks.md](parity-tasks.md) for what is left. Run replays one at a time per checkout:
two `next dev` servers in the same directory fight over `.next/dev`. For parallel lanes use a git worktree with its own copy of
`node_modules` (symlink it to the main checkout; for the replay server set `TURBOPACK_ROOT` to a directory holding both the worktree and the target, e.g. `/Users/nportugues/gumroad`, or Turbopack cannot see the package), its own `gumroad_replay_<N>` database and Redis db.
