import { PrismaClient } from "@prisma/client";

// Reuse one client across dev hot reloads; each new client opens its own pool.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
