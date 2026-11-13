# Sourced by bin/e2e-up, bin/e2e-down and bin/e2e-run. Dev lane 3 only (see docs/local-dev-parallel-lanes.md).
# Everything the Rails app needs lives in one container on the shared gumroad_default network, next to the
# shared MySQL, Redis, Elasticsearch and DynamoDB containers, which this tooling only ever uses, never recreates.

E2E_LANE=3
E2E_CONTAINER="${E2E_CONTAINER:-gr-e2e-lane3}"
E2E_NETWORK="${E2E_NETWORK:-gumroad_default}"
E2E_PORT=3003
E2E_APP_DIR=/work
E2E_NODE_DIR=/opt/node
# The image only needs Ruby 3.4 plus the native libs the shared gr_bundle volume was compiled against.
E2E_IMAGE="${E2E_IMAGE:-$(docker image inspect gr-ruby-img25 >/dev/null 2>&1 && echo gr-ruby-img25 || echo ruby:3.4.12-bookworm)}"
E2E_BUNDLE_VOLUME="${E2E_BUNDLE_VOLUME:-gr_bundle}"
E2E_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Shared services, addressed by their network aliases.
E2E_DB_CONTAINER=gumroad-db-1
E2E_REDIS_CONTAINER=gumroad-redis-1
E2E_ES_CONTAINER=gumroad-elasticsearch-1
E2E_DYNAMO_CONTAINER=gr-dynamo

e2e_log() { printf '[e2e] %s\n' "$*" >&2; }
e2e_die() { e2e_log "ERROR: $*"; exit 1; }

e2e_container_exists() { docker container inspect "$E2E_CONTAINER" >/dev/null 2>&1; }
e2e_container_running() { [[ "$(docker container inspect -f '{{.State.Running}}' "$E2E_CONTAINER" 2>/dev/null)" == true ]]; }

# Lane 3's environment, rewritten for in-network service names. Refuses to continue unless it resolves to the
# lane 3 resources, so no later command can reach another lane's database, Redis dbs or indices.
e2e_lane_env() {
  local out
  out="$("$E2E_ROOT/bin/dev-lane" "$E2E_LANE" --print-env)"
  out="${out//localhost:6379/redis:6379}"
  out="${out//redis:\/\/localhost/redis://redis}"
  grep -qx 'DATABASE_NAME=gumroad_development_lane3' <<<"$out" &&
    grep -qx 'REDIS_HOST=redis:6379/8' <<<"$out" &&
    grep -qx 'RPUSH_REDIS_HOST=redis:6379/8' <<<"$out" &&
    grep -qx 'SIDEKIQ_REDIS_HOST=redis:6379/9' <<<"$out" &&
    grep -qx 'RACK_ATTACK_REDIS_HOST=redis:6379/9' <<<"$out" &&
    grep -qx 'ES_INDEX_SUFFIX=_lane3' <<<"$out" &&
    grep -qx 'DYNAMODB_TABLE_PREFIX=lane3_' <<<"$out" || e2e_die "bin/dev-lane 3 no longer resolves to the lane 3 resources"
  printf '%s\n' "$out"
  printf '%s\n' \
    "RAILS_ENV=development" "BUNDLE_PATH=/bundle" "SKIP_TEST_DATABASE=true" \
    "DATABASE_HOST=db" "DATABASE_PORT=3306" \
    "ELASTICSEARCH_HOST=http://elasticsearch:9200" "DYNAMODB_ENDPOINT=http://dynamodb:8000" \
    "VITE_RUBY_MODE=test" "VITE_RUBY_PUBLIC_OUTPUT_DIR=vite-test" "VITE_RUBY_AUTO_BUILD=false" \
    "BASE_URL=http://localhost:$E2E_PORT"
  # The receipt page answers 500 without these; development has none. Copied from .env.test, never printed.
  grep -E '^SECURE_EXTERNAL_ID__' "$E2E_ROOT/.env.test" || true
}

# Writes the lane environment inside the container (as `export K="V"` lines) so nothing secret reaches argv or stdout.
e2e_write_env() {
  e2e_lane_env | sed -E 's/^([A-Za-z0-9_]+)=(.*)$/export \1="\2"/' |
    docker exec -i "$E2E_CONTAINER" sh -c "cat > $E2E_APP_DIR/.e2e.env"
}

# Runs a shell snippet in the app dir with the lane environment and Node on PATH.
e2e_exec() {
  docker exec -i -w "$E2E_APP_DIR" "$E2E_CONTAINER" bash -c ". $E2E_APP_DIR/.e2e.env; export PATH=$E2E_NODE_DIR/bin:\$PATH; $*"
}

e2e_runner() { e2e_exec "bundle exec rails runner '$1'"; }

# Copies the tracked files of this checkout into the container; node_modules and build output stay container-local.
e2e_sync_code() {
  e2e_log "syncing tracked files into $E2E_CONTAINER:$E2E_APP_DIR"
  (cd "$E2E_ROOT" && git ls-files -z --cached --exclude-standard | tar --null -T - -cf -) |
    docker exec -i "$E2E_CONTAINER" tar -x -C "$E2E_APP_DIR" --no-same-owner
}

e2e_wait_http() { # url, attempts
  local url="$1" tries="${2:-120}" code
  for ((i = 0; i < tries; i++)); do
    code="$(e2e_exec "curl -sL -o /dev/null -m 120 -w '%{http_code}' $url" 2>/dev/null || true)"
    [[ "$code" == 200 ]] && return 0
    sleep 3
  done
  return 1
}
