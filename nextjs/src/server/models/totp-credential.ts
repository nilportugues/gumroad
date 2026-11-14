// Port of the recovery codes of app/models/totp_credential.rb (#generate_recovery_codes) and Settings::TotpController#format_recovery_codes.
import { randomInt } from "node:crypto";

import { Prisma } from "@prisma/client";
import { hash } from "bcryptjs";

import { column, execute, table } from "./sql.ts";

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_LENGTH = 8;
// BCrypt::Password.create's default cost (bcrypt-ruby's DEFAULT_COST), whatever Devise's stretches are.
const RECOVERY_CODE_BCRYPT_COST = 12;
const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// `SecureRandom.alphanumeric(RECOVERY_CODE_LENGTH).upcase`
const recoveryCode = (): string =>
  Array.from({ length: RECOVERY_CODE_LENGTH }, () => ALPHANUMERIC[randomInt(ALPHANUMERIC.length)])
    .join("")
    .toUpperCase();

// `"#{code[0...midpoint]}-#{code[midpoint..]}"`
export function formatRecoveryCode(code: string): string {
  const midpoint = RECOVERY_CODE_LENGTH / 2;
  return `${code.slice(0, midpoint)}-${code.slice(midpoint)}`;
}

// `generate_recovery_codes`: ten fresh codes, stored as a JSON list of bcrypt hashes (bcrypt-ruby writes `$2a$`). The caller owns the
// transaction; the plain codes are returned once, to be shown to the user.
export async function generateRecoveryCodes(credentialId: bigint, now: Date): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
  const hashed: string[] = [];
  for (const code of codes) hashed.push((await hash(code, RECOVERY_CODE_BCRYPT_COST)).replace(/^\$2b\$/u, "$2a$"));
  await execute(
    Prisma.sql`UPDATE ${table("totp_credentials")} SET ${column("totp_credentials", "recovery_codes")} = ${JSON.stringify(hashed)}, ${column("totp_credentials", "recovery_codes_generated_at")} = ${now}, ${column("totp_credentials", "updated_at")} = ${now} WHERE ${column("totp_credentials", "id")} = ${credentialId}`,
  );
  return codes;
}
