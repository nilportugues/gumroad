// Mail::Message#encoded (mail 2.9) for the messages our mailers build: plain ASCII headers and
// text/* parts under multipart/alternative. Anything the gem would RFC 2047-encode is refused,
// since a near miss there changes what the recipient's client shows.
import { randomInt } from "node:crypto";
import { hostname } from "node:os";

export class MimeNotPortedError extends Error {}

const FIELD_ORDER = [
  "return-path", "received",
  "resent-date", "resent-from", "resent-sender", "resent-to",
  "resent-cc", "resent-bcc", "resent-message-id",
  "date", "from", "sender", "reply-to", "to", "cc", "bcc",
  "message-id", "in-reply-to", "references",
  "subject", "comments", "keywords",
  "mime-version", "content-type", "content-transfer-encoding",
  "content-location", "content-disposition", "content-description",
];
const fieldOrder = (name: string) => {
  const i = FIELD_ORDER.indexOf(name.toLowerCase());
  return i === -1 ? 100 : i;
};

export type MimePart = { contentType: "text/plain" | "text/html"; body: string };

export type MimeMessage = {
  from: string;
  replyTo?: string | undefined;
  to: string[];
  subject: string;
  // Extra headers (X-*, List-Unsubscribe), in the order the mailer set them.
  headers?: [string, string][];
  // Sent as multipart/alternative, in the gem's part sort order.
  parts: MimePart[];
};

export type MimeIdentity = { date: Date; messageId: string; boundary: string };

// Mail.random_tag: "%x%x_%x%x%d%x" of seconds, usec, pid, thread id, a counter and rand(255).
let uniq = randomInt(1_000_000);
function randomTag(now: Date): string {
  const seconds = Math.floor(now.getTime() / 1000);
  const usec = (now.getTime() % 1000) * 1000 + randomInt(1000);
  uniq += 1;
  return `${seconds.toString(16)}${usec.toString(16)}_${process.pid.toString(16)}${randomInt(0xfffff).toString(16)}${uniq}${randomInt(255).toString(16)}`;
}

export function newIdentity(now = new Date()): MimeIdentity {
  return { date: now, messageId: `<${randomTag(now)}@${hostname()}.mail>`, boundary: `--==_mimepart_${randomTag(now)}` };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => n.toString().padStart(2, "0");

// DateTime.now.strftime("%a, %d %b %Y %H:%M:%S %z"), in the process's local zone as Ruby's is.
export function rfc2822Date(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${DAYS[date.getDay()]}, ${pad(date.getDate())} ${MONTHS[date.getMonth()]} ${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

const SIMPLE_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/u;
const NAMED_ADDRESS = /^[A-Za-z0-9 ]+ <[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+>$/u;

function checkAddress(address: string): string {
  if (!SIMPLE_ADDRESS.test(address) && !NAMED_ADDRESS.test(address)) throw new MimeNotPortedError(`address not ported: ${JSON.stringify(address)}`);
  return address;
}

// UnstructuredField#encoded for an ASCII value: split on single spaces and tabs, then refilled
// greedily to 78 columns, the first line counting "Name: ". Non-ASCII values would be RFC 2047
// encoded and "=?" would be decoded first, so both are refused.
export function unstructured(name: string, value: string): string {
  if (!/^[\x20-\x7e\t]+$/u.test(value) || value.includes("=?") || !/[^ \t]/u.test(value)) {
    throw new MimeNotPortedError(`header would be encoded: ${name}`);
  }
  const words = value.split(/[ \t]/u);
  // String#split drops trailing empty fields.
  while (words.at(-1) === "") words.pop();
  const lines: string[] = [];
  let prepend = name.length + 2;
  while (words.length > 0) {
    const limit = 78 - prepend;
    let line = "";
    let first = true;
    while (words.length > 0) {
      const word = words[0]!;
      if (line !== "" && line.length + word.length + 1 > limit) break;
      words.shift();
      if (first) first = false;
      else line += " ";
      line += word;
    }
    lines.push(line);
    prepend = 0;
  }
  return `${name}: ${lines.join("\r\n ")}`;
}

const blank = (s: string) => !/[^ \t\r\n\f\v]/u.test(s);
const toLf = (s: string) => s.replace(/\r\n|\r/gu, "\n");
const toCrlf = (s: string) => s.replace(/(?<!\r)\n|\r(?!\n)/gu, "\r\n");

// Array#pack("M"): Ruby's qpencode with its 72-column soft breaks.
export function packM(bytes: Uint8Array): string {
  const HEX = "0123456789ABCDEF";
  let out = "";
  let n = 0;
  let prev = -1;
  for (const b of bytes) {
    if (b > 126 || (b < 32 && b !== 10 && b !== 9) || b === 61) {
      out += `=${HEX[b >> 4]}${HEX[b & 15]}`;
      n += 3;
      prev = -1;
    } else if (b === 10) {
      if (prev === 32 || prev === 9) out += "=\n";
      out += "\n";
      n = 0;
      prev = b;
    } else {
      out += String.fromCharCode(b);
      n += 1;
      prev = b;
    }
    if (n > 72) {
      out += "=\n";
      n = 0;
      prev = 10;
    }
  }
  if (n > 0) out += "=\n";
  return out;
}

// Array#pack("m"): 60-character lines, each ending in "\n".
export function packBase64(bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes).toString("base64");
  let out = "";
  for (let i = 0; i < encoded.length; i += 60) out += `${encoded.slice(i, i + 60)}\n`;
  return out;
}

type TransferEncoding = "7bit" | "quoted-printable" | "base64";

// Body#negotiate_best_encoding for a 7bit transport: a 7bit-compatible body stays 7bit; otherwise the
// cheaper of quoted-printable and base64, quoted-printable on a tie.
function negotiate(raw: string): TransferEncoding {
  const bytes = Buffer.from(raw, "utf8");
  const asciiOnly = bytes.length === raw.length;
  if (asciiOnly && !raw.split(/(?<=\n)/u).some((line) => line.length > 998)) return "7bit";
  let printable = 0;
  for (const b of bytes) if (b === 9 || b === 10 || b === 13 || (b >= 0x20 && b <= 0x3c) || (b >= 0x3e && b <= 0x7e)) printable += 1;
  const qpCost = ((bytes.length - printable) * 3 + printable) / bytes.length;
  return qpCost <= 4 / 3 ? "quoted-printable" : "base64";
}

// Body#encoded(transfer_encoding) for a text body: the source encoding's decode (7bit normalises
// line endings), then the negotiated encoding's encode.
function encodeBody(rawBody: string): { encoding: TransferEncoding; encoded: string } {
  const raw = blank(rawBody) ? "" : rawBody;
  const encoding = negotiate(raw);
  const asciiOnly = Buffer.byteLength(raw, "utf8") === raw.length;
  const decoded = asciiOnly ? toLf(raw) : raw;
  switch (encoding) {
    case "7bit":
      return { encoding, encoded: toCrlf(decoded) };
    case "quoted-printable":
      return { encoding, encoded: toCrlf(packM(Buffer.from(toLf(decoded), "utf8"))) };
    case "base64":
      return { encoding, encoded: toCrlf(packBase64(Buffer.from(decoded, "utf8"))) };
  }
}

function encodeHeaders(fields: [string, string][]): string {
  return fields
    .map((field, index) => ({ field, index }))
    .sort((a, b) => fieldOrder(a.field[0]) - fieldOrder(b.field[0]) || a.index - b.index)
    .map(({ field }) => `${field[1]}\r\n`)
    .join("");
}

// Mail::Part#encoded: Content-Type with its charset parameter, then the negotiated encoding.
export function encodePart(part: MimePart): string {
  const { encoding, encoded } = encodeBody(part.body);
  return `${encodeHeaders([
    ["content-type", `Content-Type: ${part.contentType};\r\n charset=UTF-8`],
    ["content-transfer-encoding", `Content-Transfer-Encoding: ${encoding}`],
  ])}\r\n${encoded}`;
}

const PART_SORT_ORDER = ["text/plain", "text/enriched", "text/html", "multipart/alternative"];

export function encodeMessage(message: MimeMessage, identity: MimeIdentity = newIdentity()): string {
  if (message.parts.length < 2) throw new MimeNotPortedError("only multipart/alternative messages are ported");
  if (message.to.length !== 1) throw new MimeNotPortedError("only single-recipient messages are ported");
  const fields: [string, string][] = [
    ["from", `From: ${checkAddress(message.from)}`],
    ...(message.replyTo !== undefined ? ([["reply-to", `Reply-To: ${checkAddress(message.replyTo)}`]] as [string, string][]) : []),
    ["to", `To: ${checkAddress(message.to[0]!)}`],
    ["subject", unstructured("Subject", message.subject)],
    ...(message.headers ?? []).map(([name, value]): [string, string] => [name, unstructured(name, value)]),
    ["date", `Date: ${rfc2822Date(identity.date)}`],
    ["mime-version", "MIME-Version: 1.0"],
    ["message-id", `Message-ID: ${identity.messageId}`],
  ];

  const parts = message.parts
    .map((part, index) => ({ part, index }))
    .sort((a, b) => PART_SORT_ORDER.indexOf(a.part.contentType) - PART_SORT_ORDER.indexOf(b.part.contentType) || a.index - b.index)
    .map(({ part }) => encodePart(part));
  fields.push(
    ["content-type", `Content-Type: multipart/alternative;\r\n boundary="${identity.boundary}"`],
    ["content-transfer-encoding", "Content-Transfer-Encoding: 7bit"],
  );
  const body = ["", ...parts].join(`\r\n--${identity.boundary}\r\n`) + `\r\n--${identity.boundary}--\r\n`;
  return `${encodeHeaders(fields)}\r\n${body}`;
}
