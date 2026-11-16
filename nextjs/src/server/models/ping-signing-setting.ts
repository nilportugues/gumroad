// PingSigningSetting (app/models/ping_signing_setting.rb) and User#ping_signing_secret. Raw SQL: the table has no Prisma model, and the
// row must stay out of paper_trail like in Rails (a live credential must not land in `versions`).
import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";

import { transaction } from "./runtime/transaction.ts";
import { column, execute, selectRows, table } from "./sql.ts";

const SETTINGS = "ping_signing_settings";
// PingSigningSetting::SECRET_BYTES
export const SECRET_BYTES = 32;

export const generateSecret = () => randomBytes(SECRET_BYTES).toString("hex");

// `ping_signing_setting&.secret`
export async function pingSigningSecretOf(userId: bigint): Promise<string | null> {
  const [row] = await selectRows<{ secret: string }>(
    Prisma.sql`SELECT ${column(SETTINGS, "secret")} FROM ${table(SETTINGS)} WHERE ${column(SETTINGS, "user_id")} = ${userId} LIMIT 1`,
  );
  return row?.secret ?? null;
}

// The seller's lock serializes concurrent enable, rotate and disable calls, including two first-time enables racing on the unique user_id index.
const lockSeller = (userId: bigint) =>
  selectRows(
    Prisma.sql`SELECT ${column("users", "id")} FROM ${table("users")} WHERE ${column("users", "id")} = ${userId} LIMIT 1 FOR UPDATE`,
  );

// `with_lock { (ping_signing_setting || build_ping_signing_setting).update!(secret:) }`
export function rotatePingSigningSecret(userId: bigint, secret: string, now: Date): Promise<void> {
  return transaction(async () => {
    await lockSeller(userId);
    const updated = await execute(
      Prisma.sql`UPDATE ${table(SETTINGS)} SET ${column(SETTINGS, "secret")} = ${secret}, ${column(SETTINGS, "updated_at")} = ${now} WHERE ${column(SETTINGS, "user_id")} = ${userId}`,
    );
    if (updated > 0) return;
    await execute(
      Prisma.sql`INSERT INTO ${table(SETTINGS)} (${column(SETTINGS, "user_id")}, ${column(SETTINGS, "secret")}, ${column(SETTINGS, "created_at")}, ${column(SETTINGS, "updated_at")}) VALUES (${userId}, ${secret}, ${now}, ${now})`,
    );
  });
}

// `with_lock { ping_signing_setting&.destroy }`
export function disablePingSigning(userId: bigint): Promise<void> {
  return transaction(async () => {
    await lockSeller(userId);
    await execute(Prisma.sql`DELETE FROM ${table(SETTINGS)} WHERE ${column(SETTINGS, "user_id")} = ${userId}`);
  });
}
