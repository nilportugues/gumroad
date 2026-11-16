import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

export type NextServer = { baseUrl: string; stop: () => Promise<void>; output: () => string };

const READY_TIMEOUT_MS = 120_000;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

// Boots `next dev` for the pages that the proxy and App Router answer together: the Rails envelope
// is attached by the proxy and the HTML only exists once Next renders it, so there is no in-process
// way to replay them. The first request to each route compiles it; give those a generous timeout.
export async function startNextServer(env: Record<string, string>): Promise<NextServer> {
  const port = await freePort();
  const root = path.resolve(import.meta.dirname, "..", "..");
  const child: ChildProcess = spawn(
    path.join(root, "node_modules/.bin/next"),
    ["dev", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: root,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );

  let output = "";
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const stop = async () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    process.kill(-child.pid, "SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!/Ready in/u.test(output)) {
    if (child.exitCode !== null) throw new Error(`next dev exited early:\n${output}`);
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`next dev did not become ready:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { baseUrl: `http://127.0.0.1:${port}`, stop, output: () => output };
}
