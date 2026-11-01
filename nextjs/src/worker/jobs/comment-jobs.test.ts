// Replays comment.golden.json (generate-comment-golden.rb): the Comment model service and the jobs
// that write comments must send the statements Rails sent, given the same answers, and leave the
// same record and Sidekiq state. The release job's enqueues take unique-jobs locks, so those cases
// need JOBS_REDIS_URL=redis://127.0.0.1:6379/12 npm test.
import { readFileSync } from "node:fs";

import { Prisma, type Comment } from "@prisma/client";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { JOB_REGISTRY } from "../../server/jobs/registry.generated.ts";
import type { JobDefinition } from "../../server/jobs/registry-types.ts";
import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";
import { commentMailer, CommentDeletable, Comments, normalizeContent, type CommentRecord } from "../../server/models/comment.ts";
import { RecordInvalid } from "../../server/models/runtime/errors.ts";
import { castRow, column, selectRows, table } from "../../server/models/sql.ts";
import { asSidekiqJob, contextFor, recordingSidekiqRedis, sequentialJids, snapshotRedis, type RedisSnapshot } from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { contentModerationAdminCommentJobWith, detectLegalEntityCountryDriftJobWith, releaseChargebackRatePayoutPausesJobWith } from "./comment-jobs.ts";

type Outcome = { saved: boolean; full_messages: string[]; attributes: Record<string, JsonValue> };
type GoldenCase = {
  name: string;
  args?: JsonValue[];
  error?: { class: string; message: string };
  result?: Outcome;
  statements: Statement[];
  redis: RedisSnapshot;
  deliveries?: [string, number][];
};
const golden = parseRubyJson(readFileSync(new URL("./__fixtures__/comment.golden.json", import.meta.url), "utf8")) as unknown as {
  now: number;
  model: GoldenCase[];
  jobs: Record<string, GoldenCase[]>;
  normalize_content: [string, string][];
};
const now = () => new Date(Math.round(golden.now * 1000));

async function find(id: number): Promise<CommentRecord> {
  const [row] = await selectRows(Prisma.sql`SELECT ${Prisma.raw("`comments`.*")} FROM ${table("comments")} WHERE ${column("comments", "id")} = ${id} LIMIT 1`);
  return Comments.load(castRow<Comment>("Comment", row!));
}

async function saved(record: CommentRecord): Promise<boolean> {
  return Comments.save(record, { now });
}

// What each Ruby case did, in Node.
const MODEL_CASES: Record<string, () => Promise<[CommentRecord, boolean]>> = {
  "note on a user, content trimmed": async () => {
    const r = Comments.build({ commentable_type: "User", commentable_id: 5n, author_name: "ContentModeration", comment_type: "note", content: "  first\n\n\n\nsecond\r\n\r\n\r\nthird \n" });
    return [r, await saved(r)];
  },
  "note through user.comments.create!": async () => {
    await selectRows(Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${5} LIMIT 1`);
    const r = await Comments.createBang({ commentable_id: 5n, commentable_type: "User", author_name: "admin", comment_type: "payout_note", content: "Scheduled payout" }, { now });
    return [r, true];
  },
  "team member author may use adult keywords": async () => {
    const r = Comments.build({ commentable_type: "Link", commentable_id: 3n, author_id: 9n, comment_type: "note", content: "nsfw review" });
    return [r, await saved(r)];
  },
  "other authors may not": async () => {
    const r = Comments.build({ commentable_type: "Purchase", commentable_id: 3n, author_id: 9n, comment_type: "user_submitted", content: "nsfw review", ancestry: "11" });
    return [r, await saved(r)];
  },
  "an author id that matches no user": async () => {
    const r = Comments.build({ commentable_type: "Installment", commentable_id: 3n, author_id: 404n, author_name: "ContentModeration", comment_type: "note", content: "lewd" });
    return [r, await saved(r)];
  },
  "blank fields": async () => {
    const r = Comments.build({ content: " \n " });
    return [r, await saved(r)];
  },
  "unknown commentable type": async () => {
    const r = Comments.build({ commentable_type: "Wishlist", commentable_id: 1n, author_name: "a", comment_type: "note", content: "x" });
    return [r, await saved(r)];
  },
  "commentable that does not exist": async () => {
    const r = Comments.build({ commentable_type: "User", commentable_id: 77n, author_name: "a", comment_type: "note", content: "x" });
    return [r, await saved(r)];
  },
  "content over 10,000 characters": async () => {
    const r = Comments.build({ commentable_type: "User", commentable_id: 5n, author_name: "a", comment_type: "note", content: "é".repeat(10_001) });
    return [r, await saved(r)];
  },
  "reply at the maximum depth": async () => {
    const r = Comments.build({ commentable_type: "User", commentable_id: 5n, author_name: "a", comment_type: "user_submitted", content: "deep", ancestry: "1/2/3/4" });
    return [r, await saved(r)];
  },
  "reply past the maximum depth": async () => {
    const r = Comments.build({ commentable_type: "User", commentable_id: 5n, author_name: "a", comment_type: "user_submitted", content: "deeper", ancestry: "1/2/3/4/5" });
    return [r, await saved(r)];
  },
  "malformed ancestry": async () => {
    const r = Comments.build({ commentable_type: "User", commentable_id: 5n, author_name: "a", comment_type: "note", content: "x", ancestry: "1/x" });
    return [r, await saved(r)];
  },
  "root comment on a post mails the seller": async () => {
    const r = Comments.build({ commentable_type: "Installment", commentable_id: 3n, author_name: "Fan", comment_type: "user_submitted", content: "Great post" });
    return [r, await saved(r)];
  },
  "the seller's own comment on their post": async () => {
    const r = Comments.build({ commentable_type: "Installment", commentable_id: 3n, author_id: 7n, comment_type: "user_submitted", content: "Thanks all" });
    return [r, await saved(r)];
  },
  "a seller with comment emails off": async () => {
    const r = Comments.build({ commentable_type: "Installment", commentable_id: 3n, author_id: 9n, comment_type: "user_submitted", content: "Great post" });
    return [r, await saved(r)];
  },
  "a reply on a post": async () => {
    const r = Comments.build({ commentable_type: "Installment", commentable_id: 3n, author_name: "Fan", comment_type: "user_submitted", content: "Agreed", ancestry: "40" });
    return [r, await saved(r)];
  },
  "mark_deleted! on a stored comment": async () => {
    const r = await find(21);
    await CommentDeletable.markDeletedBang(r, { now });
    return [r, true];
  },
  "content edit re-runs the content validations only": async () => {
    const r = await find(21);
    r.set("content", "\n\nEdited\n\n\n\n");
    return [r, await saved(r)];
  },
  "an edit that adds an adult keyword fails": async () => {
    const r = await find(21);
    r.set("content", "nsfw now");
    return [r, await saved(r)];
  },
  "saving without changes": async () => {
    const r = await find(21);
    return [r, await saved(r)];
  },
  "stored depth is recomputed from the ancestry": async () => {
    const r = await find(21);
    r.set("comment_type", "flag_note");
    return [r, await saved(r)];
  },
};

describe("Comment", () => {
  it.each(golden.model.map((c) => [c.name, c] as const))("%s", async (name, c) => {
    const sql = sqlReplay(c.statements);
    const deliveries: [string, number][] = [];
    const deliver = commentMailer.notifySellerOfNewComment;
    commentMailer.notifySellerOfNewComment = async (id) => deliveries.push(["notify_seller_of_new_comment", Number(id)]);
    let record: CommentRecord, ok: boolean;
    try {
      [record, ok] = await MODEL_CASES[name]!();
    } finally {
      commentMailer.notifySellerOfNewComment = deliver;
    }
    expect(sql.log).toEqual(sql.expected);
    expect(deliveries).toEqual(c.deliveries ?? []);
    expect(ok).toBe(c.result!.saved);
    expect(record.errors.fullMessages()).toEqual(c.result!.full_messages);
    const expected = c.result!.attributes;
    expect(record.get("content")).toBe(expected.content);
    expect(record.get("ancestry_depth")).toBe(expected.ancestry_depth);
    expect(record.get("id") == null ? null : Number(record.get("id"))).toBe(expected.id);
  });

  it.each(golden.normalize_content)("normalize_content(%j)", (input, expected) => {
    expect(normalizeContent(input)).toBe(expected);
  });

  it("raises RecordInvalid from create! with Rails' message", async () => {
    sqlReplay([]);
    await expect(Comments.createBang({ content: "x" }, { now })).rejects.toThrow(RecordInvalid);
  });
});

const PORTS: Record<string, typeof contentModerationAdminCommentJobWith> = {
  ContentModerationAdminCommentJob: contentModerationAdminCommentJobWith,
  ReleaseChargebackRatePayoutPausesJob: releaseChargebackRatePayoutPausesJobWith,
  DetectLegalEntityCountryDriftJob: detectLegalEntityCountryDriftJobWith,
};
const rubyRegistry: Record<string, JobDefinition> = Object.fromEntries(
  Object.entries(JOB_REGISTRY).map(([name, definition]) => [name, { ...definition, runtime: "ruby" } as JobDefinition]),
);
const takesLocks = (c: GoldenCase) => Object.keys(c.redis).some((key) => key.startsWith("uniquejobs"));

const url = process.env.JOBS_REDIS_URL;
if (url && /\/0$|^[^/]*\/\/[^/]+$/.test(url)) throw new Error("JOBS_REDIS_URL must name a scratch database other than 0");
let realRedis: Redis | undefined;
beforeAll(() => {
  if (url) realRedis = new Redis(url);
});
afterAll(async () => {
  if (!realRedis) return;
  await realRedis.flushdb();
  realRedis.disconnect();
});

for (const [name, cases] of Object.entries(golden.jobs)) {
  describe(name, () => {
    for (const c of cases) {
      it.skipIf(takesLocks(c) && !url)(c.name, async () => {
        const sql = sqlReplay(c.statements);
        let sidekiqRedis: Redis;
        let snapshot: () => Promise<RedisSnapshot>;
        if (takesLocks(c)) {
          await realRedis!.flushdb();
          sidekiqRedis = realRedis!;
          snapshot = () => snapshotRedis(realRedis!);
        } else {
          const recording = recordingSidekiqRedis();
          sidekiqRedis = recording.redis;
          snapshot = async () => recording.snapshot();
        }
        const runtime = createJobsRuntime({ sidekiqRedis, bullmqRedis: sidekiqRedis, registry: rubyRegistry, now: () => golden.now, newJid: sequentialJids() });
        const handler = PORTS[name]!({ now, watchReplicaLag: sql.watch });
        let error: unknown = null;
        try {
          await asSidekiqJob(() => handler(c.args ?? [], contextFor(runtime)), golden.now);
        } catch (e) {
          error = e;
        }
        expect(sql.log).toEqual(sql.expected);
        expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
        expect(await snapshot()).toEqual(c.redis);
      });
    }
  });
}
