// Aws::SNS::MessageVerifier#authentic? (aws-sdk-sns 1.82.0, lib/aws-sdk-sns/message_verifier.rb).
import { createVerify, X509Certificate } from "node:crypto";

import { outboundFetch } from "../infra/outbound-http.ts";
import { NotPortedError } from "../page-props/not-ported.ts";

const SIGNABLE_KEYS = [
  "Message",
  "MessageId",
  "Subject",
  "SubscribeURL",
  "Timestamp",
  "Token",
  "TopicArn",
  "Type",
] as const;
const AWS_HOSTNAME = /^sns\.[a-zA-Z0-9-]{3,}\.amazonaws\.com(?:\.cn)?$/u;
const CERT_FORMAT = /^[\s]*-----BEGIN [A-Z]+-----\n[A-Za-z\d+/\n]+={0,2}\n-----END [A-Z]+-----[\s]*$/u;
const DOWNLOAD_ATTEMPTS = 3;
// URI.parse reads this shape; whatever else Ruby's RFC 3986 parser might accept or raise on is left to Rails.
const PLAIN_URI =
  /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([A-Za-z0-9.-]*)(?::(\d+))?(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$/u;

class VerificationError extends Error {}

type Message = Record<string, unknown>;

// File.extname(path) == ".pem"
const isPemPath = (path: string): boolean => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 && base.slice(dot) === ".pem";
};

async function downloadPem(url: string): Promise<string> {
  let lastError = "";
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const response = await outboundFetch(url, { method: "GET" });
      const body = await response.text();
      if (response.status === 200) return body;
      lastError = body;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new VerificationError(lastError);
}

function canonicalString(message: Message): string {
  let out = "";
  for (const key of SIGNABLE_KEYS) {
    const value = message[key];
    if (value === undefined || value === null) continue;
    // `value.empty?` raises NoMethodError on a number and the join stringifies a list or hash its own way.
    if (typeof value !== "string") throw new NotPortedError("an SNS notification field that is not a string");
    if (value !== "") out += `${key}\n${value}\n`;
  }
  return out;
}

async function authenticate(message: Message): Promise<void> {
  const normalized: Message = { ...message };
  if ("SigningCertUrl" in normalized) {
    normalized.SigningCertURL = normalized.SigningCertUrl;
    normalized.UnsubscribeURL = normalized.UnsubscribeUrl;
    delete normalized.SigningCertUrl;
    delete normalized.UnsubscribeUrl;
  }
  const algorithm =
    normalized.SignatureVersion === "1" ? "RSA-SHA1" : normalized.SignatureVersion === "2" ? "RSA-SHA256" : null;
  if (algorithm === null) throw new VerificationError("Invalid SignatureVersion");

  const certUrl = normalized.SigningCertURL;
  // URI.parse(nil) and a malformed URI raise, which is a 500.
  if (typeof certUrl !== "string") throw new NotPortedError("an SNS notification with no SigningCertURL");
  const parts = PLAIN_URI.exec(certUrl);
  if (parts === null) throw new NotPortedError("an SNS SigningCertURL Ruby's URI parser may reject");
  const [, scheme, host, , path = ""] = parts;
  if (scheme !== "https") throw new VerificationError("the SigningCertURL must be https");
  if (!AWS_HOSTNAME.test(host!)) throw new VerificationError("signing cert is not hosted by AWS");
  if (!isPemPath(path)) throw new VerificationError("the SigningCertURL must link to a .pem file");

  const pem = await downloadPem(certUrl);
  if (!CERT_FORMAT.test(pem)) throw new VerificationError("The certificate does not match expected X509 PEM format.");

  const signature = normalized.Signature;
  if (typeof signature !== "string") throw new NotPortedError("an SNS notification with no Signature");
  // Base64.decode64 skips characters Buffer would not, so only the plain alphabet is read here.
  if (!/^[A-Za-z0-9+/=\r\n]*$/u.test(signature))
    throw new NotPortedError("an SNS Signature outside the base64 alphabet");

  let publicKey;
  try {
    publicKey = new X509Certificate(pem).publicKey;
  } catch {
    // OpenSSL::X509::CertificateError is not a VerificationError.
    throw new NotPortedError("an SNS certificate that does not parse");
  }
  if (publicKey.asymmetricKeyType !== "rsa") throw new NotPortedError("an SNS certificate that is not RSA");
  const verifier = createVerify(algorithm);
  verifier.update(canonicalString(normalized));
  if (!verifier.verify(publicKey, Buffer.from(signature, "base64"))) {
    throw new VerificationError("the authenticity of the message cannot be verified");
  }
}

// `sns_notification?(body) && authentic?(body)` as the controller reads it.
export async function snsNotificationIsAuthentic(body: string): Promise<boolean> {
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return false;
  }
  if (message === null || typeof message !== "object" || Array.isArray(message)) return false;
  try {
    await authenticate(message as Message);
    return true;
  } catch (error) {
    if (error instanceof VerificationError) return false;
    throw error;
  }
}
