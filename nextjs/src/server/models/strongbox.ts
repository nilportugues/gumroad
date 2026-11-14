// The read half of the strongbox gem (`encrypt_with_public_key ..., symmetric: :never`) as
// UserComplianceInfo, Guardian and BankAccount use it: the column holds the plaintext encrypted
// directly with the RSA public key (PKCS#1 v1.5), and reading it takes the private key and its password.
// Key material comes from GlobalConfig (STRONGBOX_GENERAL and STRONGBOX_GENERAL_PASSWORD).
import { constants, createPrivateKey, type KeyObject, privateDecrypt } from "node:crypto";

import { getConfig } from "../infra/config.ts";

const PKCS1_TYPE_2_PREFIX = [0x00, 0x02];
// PKCS#1 v1.5 requires at least eight padding bytes before the 0x00 separator.
const MIN_PADDING_BYTES = 8;

let cached: { pem: string; password: string; key: KeyObject } | undefined;

function privateKey(password: string): KeyObject {
  const pem = getConfig("STRONGBOX_GENERAL");
  if (pem === undefined) throw new Error("STRONGBOX_GENERAL is not configured");
  if (cached?.pem !== pem || cached.password !== password) cached = { pem, password, key: createPrivateKey({ key: pem, passphrase: password }) };
  return cached.key;
}

// Node refuses RSA_PKCS1_PADDING for private decryption, so the block is decrypted raw and unpadded here.
function unpadPkcs1v15(block: Buffer): Buffer {
  if (block[0] !== PKCS1_TYPE_2_PREFIX[0] || block[1] !== PKCS1_TYPE_2_PREFIX[1]) throw new Error("RSA decryption failed: padding check failed");
  const separator = block.indexOf(0x00, 2);
  if (separator < 2 + MIN_PADDING_BYTES) throw new Error("RSA decryption failed: padding check failed");
  return block.subarray(separator + 1);
}

// Strongbox::Lock#blank?: the column is nil or empty. (The ciphertext is random bytes, never whitespace.)
export const isStrongboxBlank = (ciphertext: Uint8Array | null | undefined): boolean => ciphertext == null || ciphertext.length === 0;

// Strongbox::Lock#decrypt(password): nil for a nil column, "" for an empty one.
export function strongboxDecrypt(ciphertext: Uint8Array | null | undefined, password: string): Buffer | null {
  if (ciphertext == null) return null;
  if (ciphertext.length === 0) return Buffer.alloc(0);
  const block = privateDecrypt({ key: privateKey(password), padding: constants.RSA_NO_PADDING }, Buffer.from(ciphertext));
  return unpadPkcs1v15(block);
}
