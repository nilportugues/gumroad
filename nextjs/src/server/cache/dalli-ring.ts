// Dalli::Ring (dalli 3.2.8): which memcached server holds a key, so Node and Rails read and
// write the same server. Dalli's failover (re-hashing past a server it has marked down) is not
// ported: Node always uses the first choice, and a dead server reads as a miss.
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";

export type MemcachedServer = { name: string; host: string; port: number; weight: number };

const POINTS_PER_SERVER = 160;
const SERVER_CONFIG = /^(\[([\da-fA-F:]+)\]|[^:]+)(?::(\d+))?(?::(\d+))?$/u;

// Dalli::Protocol::ServerConfigParser for "host[:port[:weight]]" (no memcached:// URIs, no
// unix sockets).
export function parseServer(config: string): MemcachedServer {
  const match = SERVER_CONFIG.exec(config);
  if (!match || match[1] === "[]" || config.startsWith("/") || config.startsWith("memcached://")) {
    throw new Error(`Could not parse memcached server ${config}`);
  }
  const host = match[2] ?? match[1]!;
  const port = Number(match[3] ?? 11211);
  return { name: `${host}:${port}`, host, port, weight: Number(match[4] ?? 1) };
}

export type Ring = { servers: MemcachedServer[]; serverFor(key: string): MemcachedServer };

export function buildRing(servers: MemcachedServer[]): Ring {
  if (servers.length === 0) throw new Error("No memcached servers");
  if (servers.length === 1) return { servers, serverFor: () => servers[0]! };
  const totalWeight = servers.reduce((sum, server) => sum + server.weight, 0);
  const continuum: { value: number; server: MemcachedServer }[] = [];
  for (const server of servers) {
    const count = Math.floor((servers.length * POINTS_PER_SERVER * server.weight) / totalWeight);
    for (let idx = 0; idx < count; idx++) {
      const hash = createHash("sha1").update(`${server.name}:${idx}`).digest("hex");
      continuum.push({ value: Number.parseInt(hash.slice(0, 8), 16), server });
    }
  }
  continuum.sort((a, b) => a.value - b.value);
  return {
    servers,
    serverFor(key) {
      const hashKey = crc32(Buffer.from(key, "latin1"));
      // Ring#server_for_hash_key: the last point at or below the hash, wrapping to the end.
      let low = 0;
      let high = continuum.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (continuum[mid]!.value > hashKey) high = mid;
        else low = mid + 1;
      }
      const index = low === continuum.length ? continuum.length - 1 : low - 1;
      return continuum.at(index)!.server;
    },
  };
}
