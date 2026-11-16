import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { dataBody, sendSmtp, SmtpError } from "./smtp.ts";

type Script = Partial<Record<"greeting" | "ehlo" | "auth" | "mail" | "rcpt" | "data" | "accepted" | "quit", string>>;

// A scripted SMTP server that records what the client sent.
async function fakeServer(script: Script = {}) {
  const received: string[] = [];
  let data = "";
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = "";
    const send = (line: string | undefined, fallback: string) => {
      if (line !== "") socket.write(`${line ?? fallback}\r\n`);
    };
    send(script.greeting, "220 fake ESMTP");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          data = buffer.slice(0, end + 5);
          buffer = buffer.slice(end + 5);
          inData = false;
          send(script.accepted, "250 queued");
          continue;
        }
        const index = buffer.indexOf("\r\n");
        if (index === -1) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        received.push(line);
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO") send(script.ehlo, "250-fake\r\n250 AUTH PLAIN");
        else if (verb === "AUTH") send(script.auth, "235 ok");
        else if (verb === "MAIL") send(script.mail, "250 ok");
        else if (verb === "RCPT") send(script.rcpt, "250 ok");
        else if (verb === "DATA") {
          inData = true;
          send(script.data, "354 go");
        } else if (verb === "QUIT") {
          send(script.quit, "221 bye");
          socket.end();
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  servers.push(server);
  return { port, received, data: () => data };
}

const servers: net.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const settings = (port: number) => ({ address: "127.0.0.1", port, domain: "gumroad.com", userName: "apikey", password: "secret", readTimeoutMs: 300 });
const envelope = { from: "noreply@gumroad.com", to: ["seller@example.com"] };

async function rubyClassOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "none";
  } catch (error) {
    return error instanceof SmtpError ? error.rubyClass : String(error);
  }
}

describe("sendSmtp", () => {
  it("runs Net::SMTP's transaction and dot-stuffs the message", async () => {
    const server = await fakeServer();
    await sendSmtp(settings(server.port), envelope, "Subject: x\r\n\r\n.leading dot\r\nlast");
    expect(server.received).toEqual([
      "EHLO gumroad.com",
      `AUTH PLAIN ${Buffer.from("\0apikey\0secret").toString("base64")}`,
      "MAIL FROM:<noreply@gumroad.com>",
      "RCPT TO:<seller@example.com>",
      "DATA",
      "QUIT",
    ]);
    expect(server.data()).toBe("Subject: x\r\n\r\n..leading dot\r\nlast\r\n.\r\n");
  });

  it.each([
    ["a 4xx reply", { rcpt: "451 try later" }, "Net::SMTPServerBusy"],
    ["a 50x reply", { mail: "501 bad address" }, "Net::SMTPSyntaxError"],
    ["a 55x reply", { accepted: "554 rejected" }, "Net::SMTPFatalError"],
    ["any rejected AUTH", { auth: "454 temporary" }, "Net::SMTPAuthenticationError"],
    ["a silent server", { greeting: "" }, "Net::ReadTimeout"],
  ] as [string, Script, string][])("maps %s to %s's Ruby class", async (_name, script, expected) => {
    const server = await fakeServer(script);
    expect(await rubyClassOf(sendSmtp(settings(server.port), envelope, "x"))).toBe(expected);
  });

  it("raises EOFError when the server hangs up", async () => {
    const server = net.createServer((socket) => socket.end("220 hi\r\n"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    expect(await rubyClassOf(sendSmtp(settings((server.address() as net.AddressInfo).port), envelope, "x"))).toBe("EOFError");
  });

  it("writes DATA as Net::InternetMessageIO does", () => {
    expect(dataBody("a\nb\r\n")).toBe("a\r\nb\r\n.\r\n");
    expect(dataBody(".\r\n..x")).toBe("..\r\n...x\r\n.\r\n");
  });
});
