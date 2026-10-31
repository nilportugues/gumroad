// The SMTP transaction Mail::SMTP (mail 2.9) runs through net-smtp 0.5 for
// `delivery_method: :smtp` with STARTTLS when offered and AUTH PLAIN: open and read timeouts of
// 5 seconds, EHLO falling back to HELO, Net::InternetMessageIO's CRLF normalisation and
// dot-stuffing for DATA. Failures carry the Ruby exception they stand for, since the job's retry
// and rescue rules key on those classes.
import net from "node:net";
import tls from "node:tls";

export type SmtpSettings = {
  address: string;
  port: number;
  // The EHLO domain.
  domain: string;
  userName: string;
  password: string;
  openTimeoutMs?: number;
  readTimeoutMs?: number;
  // Tests only: the fake server presents a self-signed certificate.
  tlsOptions?: tls.ConnectionOptions;
};

export type RubySmtpError =
  | "Net::OpenTimeout"
  | "Net::ReadTimeout"
  | "EOFError"
  | "Net::SMTPServerBusy"
  | "Net::SMTPSyntaxError"
  | "Net::SMTPAuthenticationError"
  | "Net::SMTPFatalError"
  | "Net::SMTPUnknownError";

export class SmtpError extends Error {
  readonly rubyClass: RubySmtpError;
  constructor(rubyClass: RubySmtpError, message: string) {
    super(message);
    this.rubyClass = rubyClass;
  }
}

// Net::SMTP::Response#exception_class
function errorClassFor(status: string): RubySmtpError {
  if (status.startsWith("4")) return "Net::SMTPServerBusy";
  if (status.startsWith("50")) return "Net::SMTPSyntaxError";
  if (status.startsWith("53")) return "Net::SMTPAuthenticationError";
  if (status.startsWith("5")) return "Net::SMTPFatalError";
  return "Net::SMTPUnknownError";
}

type Reply = { status: string; lines: string[] };

class Connection {
  private socket: net.Socket;
  private buffer = "";
  private waiter: (() => void) | undefined;
  private failure: SmtpError | undefined;
  private readonly readTimeoutMs: number;

  constructor(socket: net.Socket, readTimeoutMs: number) {
    this.socket = socket;
    this.readTimeoutMs = readTimeoutMs;
    this.attach(socket);
  }

  private attach(socket: net.Socket): void {
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.waiter?.();
    });
    socket.on("end", () => this.fail(new SmtpError("EOFError", "end of file reached")));
    socket.on("error", (error) => this.fail(new SmtpError("EOFError", error.message)));
  }

  private fail(error: SmtpError): void {
    this.failure ??= error;
    this.waiter?.();
  }

  private async readLine(): Promise<string> {
    const deadline = Date.now() + this.readTimeoutMs;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index !== -1) {
        const line = this.buffer.slice(0, index).replace(/\r$/u, "");
        this.buffer = this.buffer.slice(index + 1);
        return line;
      }
      if (this.failure) throw this.failure;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SmtpError("Net::ReadTimeout", "Net::ReadTimeout");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.waiter = undefined;
    }
  }

  async reply(): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      lines.push(line);
      if (line[3] !== "-") return { status: line.slice(0, 3), lines };
    }
  }

  async command(line: string, expect: string): Promise<Reply> {
    this.socket.write(`${line}\r\n`, "latin1");
    const reply = await this.reply();
    if (!reply.status.startsWith(expect)) throw new SmtpError(errorClassFor(reply.status), reply.lines.join("\n"));
    return reply;
  }

  async upgrade(host: string, options: tls.ConnectionOptions | undefined): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("end");
    plain.removeAllListeners("error");
    const secure = tls.connect({ socket: plain, servername: host, ...options });
    await new Promise<void>((resolve, reject) => {
      secure.once("secureConnect", resolve);
      secure.once("error", reject);
    });
    this.socket = secure;
    this.buffer = "";
    this.attach(secure);
  }

  write(data: string): void {
    this.socket.write(data, "utf8");
  }

  close(): void {
    this.socket.destroy();
  }
}

async function connect(settings: SmtpSettings): Promise<net.Socket> {
  const socket = net.connect({ host: settings.address, port: settings.port });
  const timeoutMs = settings.openTimeoutMs ?? 5000;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SmtpError("Net::OpenTimeout", `Timeout to open TCP connection to ${settings.address}:${settings.port} (exceeds ${timeoutMs / 1000} seconds)`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return socket;
}

// Net::InternetMessageIO#write_message: every line ends in CRLF, a leading "." is doubled, then
// the terminating ".".
export function dataBody(message: string): string {
  const lines = message.replace(/\r\n|\r|\n/gu, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return `${lines.map((line) => (line.startsWith(".") ? `.${line}` : line)).join("\r\n")}\r\n.\r\n`;
}

async function hello(connection: Connection, domain: string): Promise<string[]> {
  try {
    return (await connection.command(`EHLO ${domain}`, "2")).lines;
  } catch (error) {
    if (!(error instanceof SmtpError) || error.rubyClass === "EOFError" || error.rubyClass === "Net::ReadTimeout") throw error;
    return (await connection.command(`HELO ${domain}`, "2")).lines;
  }
}

// Net::SMTP.start(...) { |smtp| smtp.sendmail(message, from, to) }
export async function sendSmtp(settings: SmtpSettings, envelope: { from: string; to: string[] }, message: string): Promise<void> {
  const connection = new Connection(await connect(settings), settings.readTimeoutMs ?? 5000);
  try {
    const greeting = await connection.reply();
    if (!greeting.status.startsWith("2")) throw new SmtpError(errorClassFor(greeting.status), greeting.lines.join("\n"));
    const capabilities = await hello(connection, settings.domain);
    if (capabilities.some((line) => /^250[- ]STARTTLS\b/iu.test(line))) {
      await connection.command("STARTTLS", "2");
      await connection.upgrade(settings.address, settings.tlsOptions);
      await hello(connection, settings.domain);
    }
    const credentials = Buffer.from(`\0${settings.userName}\0${settings.password}`, "utf8").toString("base64");
    try {
      await connection.command(`AUTH PLAIN ${credentials}`, "2");
    } catch (error) {
      // Net::SMTP#check_auth_response: any non-2xx reply to AUTH is an authentication error.
      if (error instanceof SmtpError && error.rubyClass.startsWith("Net::SMTP")) throw new SmtpError("Net::SMTPAuthenticationError", error.message);
      throw error;
    }
    await connection.command(`MAIL FROM:<${envelope.from}>`, "2");
    for (const to of envelope.to) await connection.command(`RCPT TO:<${to}>`, "2");
    await connection.command("DATA", "3");
    connection.write(dataBody(message));
    const accepted = await connection.reply();
    if (!accepted.status.startsWith("2")) throw new SmtpError(errorClassFor(accepted.status), accepted.lines.join("\n"));
    await connection.command("QUIT", "2");
  } finally {
    connection.close();
  }
}
