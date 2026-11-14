// Replays remove-deleted-files-from-s3-job.golden.json (scripts/golden/remove-deleted-files-from-s3-job.rb): RemoveDeletedFilesFromS3Job run
// by the real app as a Sidekiq job with S3 answered by WebMock. Node sends the statements Rails sent, asks S3 to delete the keys the
// DeleteObjects requests carried and to list the prefixes Rails listed, reports the files Rails reported, and fails the same way.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { HandBackToRuby } from "../../server/jobs/hand-back.ts";
import { createJobsRuntime } from "../../server/jobs/runtime.ts";
import { parseRubyJson, type JsonValue } from "../../server/jobs/sidekiq/ruby-json.ts";

import {
  asSidekiqJob,
  contextFor,
  recordingSidekiqRedis,
  rubyRuntimeRegistry,
  sequentialJids,
} from "./__fixtures__/golden.ts";
import { sqlReplay, type Statement } from "./__fixtures__/sql-replay.ts";
import { removeDeletedFilesFromS3JobWith } from "./remove-deleted-files-from-s3-job.ts";

type Notified = {
  class: string;
  message: string;
  tab: { name: string; fields: { model: string; id: number; url: string | null } };
};
type Case = {
  name: string;
  args: JsonValue[];
  error: { class: string; message: string } | null;
  statements: Statement[];
  http: { method: string; url: string; body: string | null }[];
  http_responses: { status?: number; body?: string }[];
  notified: Notified[];
};
const golden = parseRubyJson(
  readFileSync(new URL("./__fixtures__/remove-deleted-files-from-s3-job.golden.json", import.meta.url), "utf8"),
) as unknown as { now: number; base_url: string; bucket: string; cases: Case[] };

const XML_ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const unescapeXml = (text: string) => text.replace(/&(?:amp|lt|gt|quot|apos);/gu, (entity) => XML_ENTITIES[entity]!);
const keysIn = (xml: string) => [...xml.matchAll(/<Key>(.*?)<\/Key>/gsu)].map((match) => unescapeXml(match[1]!));

type Event = { list: string } | { delete: string[] };

// What S3 was asked, one event per call the job makes: a listing (its continuation pages folded into it) or a DeleteObjects.
function expectedEvents(c: Case): Event[] {
  const events: Event[] = [];
  for (const request of c.http) {
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (!url.searchParams.has("continuation-token")) events.push({ list: url.searchParams.get("prefix")! });
    } else events.push({ delete: keysIn(request.body ?? "") });
  }
  return events;
}

// An S3 answering from the recorded responses in order; a listing reads pages while the answer says it is truncated.
function fakeS3(c: Case) {
  const events: Event[] = [];
  let index = 0;
  const next = () => c.http_responses[index++] ?? { status: 200, body: "{}" };
  return {
    events,
    s3: {
      deleteObjects(_bucket: string, keys: string[]): Promise<void> {
        events.push({ delete: keys });
        const response = next();
        if ((response.status ?? 200) >= 400)
          return Promise.reject(new Error(/<Message>(.*?)<\/Message>/su.exec(response.body ?? "")?.[1] ?? "failed"));
        return Promise.resolve();
      },
      listKeys(_bucket: string, prefix: string): Promise<string[]> {
        events.push({ list: prefix });
        const keys: string[] = [];
        for (;;) {
          const body = next().body ?? "";
          keys.push(...keysIn(body));
          if (!body.includes("<IsTruncated>true</IsTruncated>")) return Promise.resolve(keys);
        }
      },
    },
  };
}

function runtime() {
  const recording = recordingSidekiqRedis();
  return createJobsRuntime({
    sidekiqRedis: recording.redis,
    bullmqRedis: recording.redis,
    registry: rubyRuntimeRegistry(),
    now: () => golden.now,
    newJid: sequentialJids(),
  });
}

describe("RemoveDeletedFilesFromS3Job", () => {
  for (const c of golden.cases) {
    it(c.name, async () => {
      const sql = sqlReplay(c.statements);
      const s3 = fakeS3(c);
      const reported: Notified[] = [];
      const failures = c.notified.map((notified) => notified.message);
      const handler = removeDeletedFilesFromS3JobWith({
        now: () => new Date(Math.round(golden.now * 1000)),
        baseUrl: golden.base_url,
        bucket: golden.bucket,
        s3: s3.s3,
        notify: (error, file) =>
          reported.push({
            class: "",
            message: (error as Error).message,
            tab: { name: "file", fields: file as Notified["tab"]["fields"] },
          }),
      });
      let error: unknown = null;
      try {
        await asSidekiqJob(() => handler(c.args, contextFor(runtime())), golden.now);
      } catch (e) {
        error = e;
      }

      expect(error === null ? null : (error as Error).message).toEqual(c.error?.message ?? null);
      expect(sql.log).toEqual(sql.expected);
      expect(s3.events).toEqual(expectedEvents(c));
      expect(reported.map((r) => [r.message, r.tab])).toEqual(c.notified.map((n) => [n.message, n.tab]));
      expect(reported.map((r) => r.message)).toEqual(failures);
    });
  }

  for (const args of [[1.5], ["3"], [null], [1e9], [[1]]] as JsonValue[][]) {
    it(`hands ${JSON.stringify(args)} back before any statement`, async () => {
      const sql = sqlReplay([]);
      const handler = removeDeletedFilesFromS3JobWith({ now: () => new Date(0) });
      await expect(asSidekiqJob(() => handler(args, contextFor(runtime())), golden.now)).rejects.toBeInstanceOf(
        HandBackToRuby,
      );
      expect(sql.log).toEqual([]);
    });
  }

  it("fails with Ruby's wrong number of arguments for two arguments", async () => {
    const handler = removeDeletedFilesFromS3JobWith({ now: () => new Date(0) });
    await expect(asSidekiqJob(() => handler([1, 2], contextFor(runtime())), golden.now)).rejects.toThrow(
      "wrong number of arguments",
    );
  });
});
