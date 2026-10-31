// The reads auth needs, behind an interface so the resolution logic is unit-testable and WS-02's
// model services and WS-06's Redis client can replace the direct Prisma and ioredis calls.
import type { TeamMembership, User } from "@prisma/client";
import { Redis } from "ioredis";

import { db } from "../../lib/db";
import { getConfig } from "../infra/config";

export type AuthStore = {
  // User.find_by(id:): deleted users included, as User.serialize_from_session does.
  findUserById(id: bigint): Promise<User | null>;
  // User.alive.find_by(id:)
  findAliveUserById(id: bigint): Promise<User | null>;
  // User#user_memberships_not_deleted_and_ordered: `switchable` (not deleted, seller alive),
  // most recently accessed first.
  switchableMemberships(userId: bigint): Promise<TeamMembership[]>;
  // $redis.get(RedisKey.impersonated_user(admin_id))
  impersonatedUserId(adminUserId: bigint): Promise<string | null>;
  // $redis.del(RedisKey.impersonated_user(admin_id))
  clearImpersonation(adminUserId: bigint): Promise<void>;
  // Devise's forget_me! with expire_all_remember_me_on_sign_out (its default).
  forgetRememberedLogins(userId: bigint, now: Date): Promise<void>;
};

const impersonationKey = (adminUserId: bigint) => `impersonated_user_by_admin_${adminUserId}`;

let redis: Redis | undefined;
// config/redis.rb: `Redis.new(url: "redis://#{ENV["REDIS_HOST"]}")`, no namespace.
function redisClient(): Redis {
  redis ??= new Redis(`redis://${getConfig("REDIS_HOST") ?? "127.0.0.1:6379"}`, { lazyConnect: true, maxRetriesPerRequest: 1 });
  return redis;
}

export const prismaAuthStore: AuthStore = {
  findUserById: (id) => db.user.findUnique({ where: { id } }),
  findAliveUserById: (id) => db.user.findFirst({ where: { id, deleted_at: null } }),
  async switchableMemberships(userId) {
    const memberships = await db.teamMembership.findMany({
      where: { user_id: userId, deleted_at: null },
      orderBy: [{ last_accessed_at: "desc" }, { created_at: "desc" }],
    });
    if (memberships.length === 0) return [];
    const aliveSellerIds = new Set(
      (await db.user.findMany({ where: { id: { in: memberships.map((m) => m.seller_id) }, deleted_at: null }, select: { id: true } })).map((u) => u.id),
    );
    return memberships.filter((m) => aliveSellerIds.has(m.seller_id));
  },
  impersonatedUserId: (adminUserId) => redisClient().get(impersonationKey(adminUserId)),
  async clearImpersonation(adminUserId) {
    await redisClient().del(impersonationKey(adminUserId));
  },
  async forgetRememberedLogins(userId, now) {
    // TODO(WS-02): go through the User model service so paper_trail records the change.
    await db.user.update({ where: { id: userId }, data: { remember_created_at: null, updated_at: now } });
  },
};
