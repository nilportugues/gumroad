// Api::Internal::Admin::WhoamiController and AuthController (#exchange, #revoke, #rotate), with AdminApiAuthorizationCode.exchange!
// and AdminApiToken#revoke! / #rotate!.
import { createHash, randomInt } from "node:crypto";

import { db } from "../../../lib/db.ts";
import { NotPortedError } from "../../models/user.ts";
import { type AdminRequest, failure, hashToken, isBlank, jsonRendered, recordAdminWrite, serializeAdminActor, serializeAdminToken, timeJson, type AdminToken } from "./base.ts";
import { defineAdminRoute } from "./registry.ts";

const TOKEN_ALPHABET = "_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PLAINTEXT_TOKEN_LENGTH = 43;
const EXTERNAL_ID_LENGTH = 21;
const HUMAN_TOKEN_TTL_MS = 30 * 86_400_000;
const ADMIN_SCOPE = "admin";

const generateToken = (length: number) => Array.from({ length }, () => TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)]).join("");

async function generateExternalId(): Promise<string> {
  for (;;) {
    const candidate = generateToken(EXTERNAL_ID_LENGTH);
    if ((await db.adminApiToken.findFirst({ where: { external_id: candidate }, select: { id: true } })) === null) return candidate;
  }
}

type Client = Pick<typeof db, "adminApiToken">;

// AdminApiToken.mint_with_plaintext!
async function mintWithPlaintext(client: Client, attributes: { actorUserId: bigint; expiresAt: Date | null; scope: string }) {
  const plaintext = generateToken(PLAINTEXT_TOKEN_LENGTH);
  const now = new Date();
  const token = await client.adminApiToken.create({
    data: { external_id: await generateExternalId(), actor_user_id: attributes.actorUserId, token_hash: hashToken(plaintext), expires_at: attributes.expiresAt, scope: attributes.scope, created_at: now, updated_at: now },
  });
  return { plaintext, token };
}

// A param Rails would hand to String#to_s as something other than the string it was sent as.
function stringParam(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new NotPortedError("a non-string authorization parameter", "app/controllers/api/internal/admin/auth_controller.rb");
  return value;
}

const codeChallengeFor = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

// AdminApiAuthorizationCode.exchange!
async function exchange(admin: AdminRequest) {
  const code = stringParam(admin.params.code);
  const verifier = stringParam(admin.params.code_verifier);
  return db.$transaction(async (tx) => {
    const found = await tx.adminApiAuthorizationCode.findFirst({ where: { code_hash: hashToken(code) } });
    if (found === null) return null;
    const [locked] = await tx.$queryRaw<{ id: bigint }[]>`SELECT id FROM admin_api_authorization_codes WHERE id = ${found.id} FOR UPDATE`;
    if (locked === undefined) return null;
    const current = await tx.adminApiAuthorizationCode.findFirstOrThrow({ where: { id: found.id } });
    const expected = codeChallengeFor(verifier);
    const exchangeable = current.used_at === null && current.expires_at.getTime() > Date.now() && current.code_challenge.length === expected.length && Buffer.from(current.code_challenge).equals(Buffer.from(expected));
    if (!exchangeable) return null;
    const minted = await mintWithPlaintext(tx, { actorUserId: current.actor_user_id, expiresAt: new Date(Date.now() + HUMAN_TOKEN_TTL_MS), scope: ADMIN_SCOPE });
    const now = new Date();
    await tx.adminApiAuthorizationCode.update({ where: { id: current.id }, data: { used_at: now, admin_api_token_id: minted.token.id, updated_at: now } });
    return minted;
  });
}

defineAdminRoute({
  method: "GET",
  pattern: "/internal/admin/whoami",
  run: async ({ admin }) =>
    jsonRendered({
      actor: admin.token.legacy ? { external_id: null, name: "Legacy internal admin token", email: null } : serializeAdminActor(admin.actor),
      token: serializeAdminToken(admin.token),
      scopes: ["admin"],
    }),
});

defineAdminRoute({
  method: "POST",
  pattern: "/internal/admin/auth/exchange",
  unauthenticated: true,
  run: async (admin) => {
    const result = await exchange(admin);
    if (result === null) return { ...failure("authorization code is invalid", 401) };
    const actor = await db.user.findFirstOrThrow({ where: { id: result.token.actor_user_id }, select: { external_id: true, name: true, email: true } });
    return jsonRendered({
      token: result.plaintext,
      token_external_id: result.token.external_id,
      expires_at: timeJson(result.token.expires_at),
      actor: serializeAdminActor({ id: result.token.actor_user_id, ...actor }),
    });
  },
});

const notFound = () => failure("admin token not found", 404);
const WRAPPER = { key: "auth" };

// token_to_manage: the bearer token itself, or a service token by external id.
async function tokenToManage(admin: AdminRequest) {
  const externalId = admin.params.external_id;
  if (isBlank(externalId)) return db.adminApiToken.findFirst({ where: { id: admin.admin.token.id } });
  if (typeof externalId !== "string") throw new NotPortedError("a non-string external_id", "app/controllers/api/internal/admin/auth_controller.rb");
  const token = await db.adminApiToken.findFirst({ where: { external_id: externalId, revoked_at: null, OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] } });
  if (token === null) return null;
  if (token.actor_user_id === admin.admin.actor.id) return token;
  if (token.scope === ADMIN_SCOPE) return null;
  return token;
}

const target = (token: { id: bigint; external_id: string }) => ({ type: "AdminApiToken", id: token.id, externalId: token.external_id });

defineAdminRoute({
  method: "POST",
  pattern: "/internal/admin/auth/revoke",
  run: async (admin) => {
    const token = await tokenToManage(admin);
    if (token === null) return notFound();
    return recordAdminWrite(admin, { action: "auth.revoke", target: target(token), wrapper: WRAPPER }, async () => {
      const now = new Date();
      await db.adminApiToken.update({ where: { id: token.id }, data: { revoked_at: now, updated_at: now } });
      return jsonRendered({ success: true });
    });
  },
});

defineAdminRoute({
  method: "POST",
  pattern: "/internal/admin/auth/rotate",
  run: async (admin) => {
    const token = await tokenToManage(admin);
    if (token === null) return notFound();
    return recordAdminWrite(admin, { action: "auth.rotate", target: target(token), wrapper: WRAPPER }, async () => {
      if (token.expires_at !== null) return failure("only a token without an expiry can be rotated; revoke it instead", 422);
      // AdminApiToken#rotate!: a second call on a revoked row returns nil, so two concurrent rotations cannot mint two tokens.
      const rotated = await db.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<{ id: bigint }[]>`SELECT id FROM admin_api_tokens WHERE id = ${token.id} FOR UPDATE`;
        if (locked === undefined) return null;
        const fresh = await tx.adminApiToken.findFirstOrThrow({ where: { id: token.id } });
        if (fresh.revoked_at !== null) return null;
        const now = new Date();
        await tx.adminApiToken.update({ where: { id: fresh.id }, data: { revoked_at: now, updated_at: now } });
        return mintWithPlaintext(tx, { actorUserId: fresh.actor_user_id, expiresAt: null, scope: fresh.scope });
      });
      if (rotated === null) return notFound();
      return jsonRendered({ success: true, token: rotated.plaintext, token_external_id: rotated.token.external_id });
    });
  },
});

export type { AdminToken };
