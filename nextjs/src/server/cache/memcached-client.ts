// A minimal memcached client over the text protocol (get/set/add/delete), one connection per
// server, requests pipelined in order. Rails talks Dalli's binary protocol, but memcached stores
// the same key, flags and bytes whichever protocol wrote them, so the two interoperate.
//
// Only ever exercised against the fake server in memcached-client.test.ts, never against a real
// memcached: smoke-test it there before relying on it.
import { connect, type Socket } from "node:net";

import { buildRing, type MemcachedServer, parseServer } from "./dalli-ring.ts";
import type { CacheTransport, StoredValue } from "./transport.ts";

const CRLF = "\r\n";
const DEFAULT_TIMEOUT_MS = 1000; // Dalli's socket_timeout default (1s)

type Pending = {
  kind: "get" | "store" | "delete";
  resolve(value: StoredValue | null | boolean): void;
  reject(error: Error): void;
};

export class MemcachedError extends Error {}

type Connection = { request(line: Buffer, kind: Pending["kind"]): Promise<StoredValue | null | boolean>; close(): void };

function openConnection(server: MemcachedServer, timeoutMs: number): Connection {
  let socket: Socket | undefined;
  let buffer = Buffer.alloc(0);
  const pending: Pending[] = [];

  const fail = (error: Error) => {
    socket?.destroy();
    socket = undefined;
    buffer = Buffer.alloc(0);
    for (const request of pending.splice(0)) request.reject(error);
  };

  // Consumes one complete response for the oldest request, or returns false to wait for more.
  const parseOne = (): boolean => {
    const request = pending[0];
    const lineEnd = buffer.indexOf(CRLF);
    if (!request || lineEnd === -1) return false;
    const line = buffer.subarray(0, lineEnd).toString("latin1");
    if (line === "ERROR" || line.startsWith("CLIENT_ERROR") || line.startsWith("SERVER_ERROR")) {
      buffer = buffer.subarray(lineEnd + 2);
      pending.shift();
      request.reject(new MemcachedError(`${server.name}: ${line}`));
      return true;
    }
    if (request.kind === "get") {
      if (line === "END") {
        buffer = buffer.subarray(lineEnd + 2);
        pending.shift();
        request.resolve(null);
        return true;
      }
      const match = /^VALUE \S+ (\d+) (\d+)$/u.exec(line);
      if (!match) {
        fail(new MemcachedError(`${server.name}: unexpected ${line}`));
        return false;
      }
      const length = Number(match[2]);
      const total = lineEnd + 2 + length + 2 + "END\r\n".length;
      if (buffer.length < total) return false;
      const value = Buffer.from(buffer.subarray(lineEnd + 2, lineEnd + 2 + length));
      buffer = buffer.subarray(total);
      pending.shift();
      request.resolve({ value, flags: Number(match[1]) });
      return true;
    }
    buffer = buffer.subarray(lineEnd + 2);
    pending.shift();
    request.resolve(request.kind === "store" ? line === "STORED" : line === "DELETED");
    return true;
  };

  const ensureSocket = (): Socket => {
    if (socket) return socket;
    const opened = connect({ host: server.host, port: server.port });
    opened.setNoDelay(true);
    // Armed only while requests are outstanding, so an idle connection stays open.
    opened.on("timeout", () => fail(new MemcachedError(`${server.name}: timed out`)));
    opened.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (parseOne());
      if (pending.length === 0) opened.setTimeout(0);
    });
    opened.on("error", (error) => fail(new MemcachedError(`${server.name}: ${error.message}`)));
    opened.on("close", () => {
      if (socket === opened) fail(new MemcachedError(`${server.name}: connection closed`));
    });
    socket = opened;
    return opened;
  };

  return {
    request(line, kind) {
      return new Promise((resolve, reject) => {
        const target = ensureSocket();
        pending.push({ kind, resolve, reject });
        target.setTimeout(timeoutMs);
        target.write(line);
      });
    },
    close() {
      const closing = socket;
      socket = undefined;
      closing?.end();
    },
  };
}

function assertKey(key: string): void {
  if (key.length === 0 || key.length > 250 || /[\x00-\x20\x7f]/u.test(key)) throw new MemcachedError(`invalid memcached key ${JSON.stringify(key)}`);
}

export function createMemcachedTransport(serverConfigs: string[], options: { timeoutMs?: number } = {}): CacheTransport {
  const ring = buildRing(serverConfigs.map(parseServer));
  const connections = new Map<string, Connection>();
  const connectionFor = (key: string) => {
    assertKey(key);
    const server = ring.serverFor(key);
    let connection = connections.get(server.name);
    if (!connection) connections.set(server.name, (connection = openConnection(server, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
    return connection;
  };
  const storage = (command: "set" | "add") => async (key: string, value: Buffer, flags: number, exptime: number) =>
    (await connectionFor(key).request(
      Buffer.concat([Buffer.from(`${command} ${key} ${flags} ${exptime} ${value.length}${CRLF}`, "latin1"), value, Buffer.from(CRLF)]),
      "store",
    )) as boolean;

  return {
    async get(key) {
      return (await connectionFor(key).request(Buffer.from(`get ${key}${CRLF}`, "latin1"), "get")) as StoredValue | null;
    },
    set: storage("set"),
    add: storage("add"),
    async delete(key) {
      return (await connectionFor(key).request(Buffer.from(`delete ${key}${CRLF}`, "latin1"), "delete")) as boolean;
    },
    async close() {
      for (const connection of connections.values()) connection.close();
      connections.clear();
    },
  };
}
