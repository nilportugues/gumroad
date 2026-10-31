// Port of lib/utilities/replica_lag_watcher.rb, with REPLICAS_HOSTS from
// config/initializers/004_constants.rb. Call watch() between write batches; it sleeps while any
// replica lags.
import { PrismaClient } from "@prisma/client";

export type ReplicaLagOptions = {
  checkEvery?: number;
  sleep?: number;
  maxLagAllowed?: number;
  silence?: boolean;
  // A monotonic time in seconds (see monotonicSeconds) after which watch() stops waiting.
  deadline?: number;
};

const DEFAULT_OPTIONS = { checkEvery: 1, sleep: 1, maxLagAllowed: 1, silence: false };

export type ReplicaConnection = { host: string; query(sql: string): Promise<Record<string, unknown>[]> };

const isPresent = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";

export function replicasHosts(env: Record<string, string | undefined> = process.env): string[] {
  const hosts: string[] = [];
  for (let i = 1; i <= 3; i++) hosts.push(...[env[`DATABASE_REPLICA${i}_HOST`], env[`DATABASE_WORKER_REPLICA${i}_HOST`]].filter(isPresent));
  return [...new Set(hosts)].filter((host) => host !== env.DATABASE_HOST);
}

// Mysql2::Client.new(username:, password:, database:, host:) in Ruby: the primary's credentials
// and database on another host, at MySQL's default port.
function prismaReplicaConnection(host: string): ReplicaConnection {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.hostname = host;
  url.port = "";
  const client = new PrismaClient({ datasourceUrl: url.toString() });
  return { host, query: (sql) => client.$queryRawUnsafe<Record<string, unknown>[]>(sql) };
}

export const monotonicSeconds = () => performance.now() / 1000;
const sleepSeconds = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const pluralizeSecond = (count: number) => (count === 1 ? "second" : "seconds");

type ReplicaLagWatcherDeps = {
  hosts: () => string[];
  connect: (host: string) => ReplicaConnection;
  now: () => number;
  sleep: (seconds: number) => Promise<unknown>;
  log: (line: string) => void;
};

export class ReplicaLagWatcher {
  private connections: ReplicaConnection[] | undefined;
  private lastCheckedAt: number | undefined;

  // A plain field, not a parameter property: the worker runs under Node's type stripping, which
  // rejects parameter properties.
  private readonly deps: ReplicaLagWatcherDeps;

  constructor(
    deps: ReplicaLagWatcherDeps = { hosts: () => replicasHosts(), connect: prismaReplicaConnection, now: monotonicSeconds, sleep: sleepSeconds, log: console.info },
  ) {
    this.deps = deps;
  }

  async watch(overrides: ReplicaLagOptions = {}): Promise<void> {
    const hosts = this.deps.hosts();
    if (hosts.length === 0) return;

    const options = { ...DEFAULT_OPTIONS, ...overrides };
    const { deadline } = options;
    if (deadline !== undefined && this.deps.now() >= deadline) return;

    this.connections ??= hosts.map((host) => this.deps.connect(host));

    while ((deadline === undefined || this.deps.now() < deadline) && (await this.lagging(options))) {
      let sleepDuration = options.sleep;
      if (deadline !== undefined) {
        const remaining = deadline - this.deps.now();
        if (remaining <= 0) break;
        sleepDuration = Math.min(sleepDuration, remaining);
      }
      if (!options.silence) this.deps.log(`sleeping ${sleepDuration} ${pluralizeSecond(sleepDuration)}`);
      await this.deps.sleep(sleepDuration);
    }
  }

  private async lagging(options: typeof DEFAULT_OPTIONS): Promise<boolean> {
    if (this.lastCheckedAt !== undefined && this.lastCheckedAt + options.checkEvery > this.deps.now()) return false;
    this.lastCheckedAt = this.deps.now();

    for (const connection of this.connections ?? []) {
      const [status] = await connection.query("SHOW REPLICA STATUS");
      if (status === undefined) {
        throw new Error(
          `${connection.host} is in REPLICAS_HOSTS but is not replicating — it is likely the primary. ` +
            "This happens when the process boots with DATABASE_HOST set to a read replica (e.g. the read-only console): " +
            "the replica is subtracted from REPLICAS_HOSTS, leaving the primary in the list. " +
            "Run ReplicaLagWatcher from a process connected to the primary.",
        );
      }
      const rawLag = status.Seconds_Behind_Source;
      if (rawLag === null || rawLag === undefined) throw new Error(`${connection.host} lag = null. Is this replica available and replicating?`);
      const lag = Number(rawLag);
      if (lag > options.maxLagAllowed) {
        if (!options.silence) this.deps.log(`${connection.host} lag = ${lag} ${pluralizeSecond(lag)}`);
        return true;
      }
    }
    return false;
  }
}

// Ruby keeps one per Sidekiq thread; one per Node process is the equivalent here, since jobs share
// the event loop rather than a thread each.
let shared: ReplicaLagWatcher | undefined;
export function replicaLagWatcher(): ReplicaLagWatcher {
  shared ??= new ReplicaLagWatcher();
  return shared;
}
