// The text-protocol client against an in-process fake memcached (no real server here).
import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { buildRing, parseServer } from "./dalli-ring.ts";
import { createMemcachedTransport } from "./memcached-client.ts";
import { createRailsCache } from "./rails-cache.ts";

type FakeServer = { port: number; store: Map<string, { value: Buffer; flags: number; exptime: number }>; commands: string[]; close(): Promise<void> };

// Answers get/set/add/delete as memcached 1.6 does, one byte at a time to exercise reassembly.
async function fakeMemcached(): Promise<FakeServer> {
  const store: FakeServer["store"] = new Map();
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    const reply = (text: string | Buffer) => {
      for (const byte of Buffer.from(text)) socket.write(Buffer.from([byte]));
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const lineEnd = buffer.indexOf("\r\n");
        if (lineEnd === -1) return;
        const [command, key, ...rest] = buffer.subarray(0, lineEnd).toString("latin1").split(" ");
        if (command === "set" || command === "add") {
          const length = Number(rest[2]);
          if (buffer.length < lineEnd + 2 + length + 2) return;
          const value = Buffer.from(buffer.subarray(lineEnd + 2, lineEnd + 2 + length));
          buffer = buffer.subarray(lineEnd + 2 + length + 2);
          commands.push(`${command} ${key} ${rest.join(" ")}`);
          if (command === "add" && store.has(key!)) reply("NOT_STORED\r\n");
          else {
            store.set(key!, { value, flags: Number(rest[0]), exptime: Number(rest[1]) });
            reply("STORED\r\n");
          }
          continue;
        }
        buffer = buffer.subarray(lineEnd + 2);
        commands.push(`${command} ${key}`);
        if (command === "get") {
          const entry = store.get(key!);
          reply(entry ? Buffer.concat([Buffer.from(`VALUE ${key} ${entry.flags} ${entry.value.length}\r\n`), entry.value, Buffer.from("\r\nEND\r\n")]) : "END\r\n");
        } else if (command === "delete") reply(store.delete(key!) ? "DELETED\r\n" : "NOT_FOUND\r\n");
        else reply("ERROR\r\n");
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    store,
    commands,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const servers: FakeServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe("memcached text-protocol client", () => {
  it("stores, reads, adds and deletes with flags and exptime, pipelining requests", async () => {
    const server = await fakeMemcached();
    servers.push(server);
    const transport = createMemcachedTransport([`127.0.0.1:${server.port}`]);
    const binary = Buffer.from([0, 13, 10, 255, 69, 78, 68, 13, 10]); // contains "\r\n" and "END\r\n"

    const results = await Promise.all([
      transport.set("a", binary, 1, 600),
      transport.get("a"),
      transport.add("a", Buffer.from("x"), 0, 0),
      transport.get("missing"),
      transport.add("b", Buffer.from("y"), 3, 0),
      transport.delete("a"),
      transport.delete("a"),
    ]);
    expect(results).toEqual([true, { value: binary, flags: 1 }, false, null, true, true, false]);
    expect(server.commands).toEqual(["set a 1 600 9", "get a", "add a 0 0 1", "get missing", "add b 3 0 1", "delete a", "delete a"]);
    await transport.close();
  });

  it("rejects pending requests when the server is gone, and the store reads that as a miss", async () => {
    const server = await fakeMemcached();
    const transport = createMemcachedTransport([`127.0.0.1:${server.port}`], { timeoutMs: 200 });
    await server.close();
    await expect(transport.get("a")).rejects.toThrow();
    const errors: unknown[] = [];
    const cache = createRailsCache({ transport, namespace: "rev", onError: (error) => errors.push(error) });
    expect(await cache.fetch("a", {}, () => "fresh")).toBe("fresh");
    expect(errors.length).toBe(2);
    await transport.close();
  });

  it("refuses keys memcached would reject", async () => {
    const transport = createMemcachedTransport(["127.0.0.1:1"]);
    await expect(transport.get("has space")).rejects.toThrow("invalid memcached key");
    await expect(transport.get("k".repeat(251))).rejects.toThrow("invalid memcached key");
  });

  it("sends each key to the server Dalli's ring picks", async () => {
    const [first, second] = [await fakeMemcached(), await fakeMemcached()];
    servers.push(first, second);
    const configs = [`127.0.0.1:${first.port}`, `127.0.0.1:${second.port}`];
    const ring = buildRing(configs.map(parseServer));
    const cache = createRailsCache({ transport: createMemcachedTransport(configs), namespace: "rev" });
    const names = Array.from({ length: 20 }, (_, i) => `key-${i}`);
    for (const name of names) await cache.write(name, name);
    for (const name of names) {
      const owner = ring.serverFor(`rev:${name}`).port === first.port ? first : second;
      expect(owner.store.has(`rev:${name}`)).toBe(true);
      expect(await cache.read(name)).toBe(name);
    }
    expect(first.store.size).toBeGreaterThan(0);
    expect(second.store.size).toBeGreaterThan(0);
    await cache.transport.close();
  });
});
