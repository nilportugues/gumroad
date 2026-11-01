// Ports of the community chat recap run jobs:
//   app/sidekiq/force_finish_long_running_community_chat_recap_runs_job.rb
//   app/sidekiq/trigger_community_chat_recap_run_job.rb
import { Prisma, type CommunityChatRecap, type CommunityChatRecapRun } from "@prisma/client";

import { performAsync } from "../../server/models/concerns/job-runtime.ts";
import { addDays, ago, beginningOfDay, endOfDay, parseIsoDate, toCalendarDate, type CalendarDate } from "../../server/models/concerns/ruby-time.ts";
import {
  COMMUNITY_CHAT_RECAP_RUNS,
  COMMUNITY_CHAT_RECAPS,
  CommunityChatRecapRuns,
  CommunityChatRecaps,
  createRecapFor,
  loadRecapOf,
  RECAP_FREQUENCIES,
  RECAP_STATUSES,
  recapStatusScope,
  runningScope,
  useClock,
} from "../../server/models/community-chat-recap-run.ts";
import { castRow, column, findInBatches, selectRows, table } from "../../server/models/sql.ts";
import { transaction } from "../../server/models/runtime/transaction.ts";
import { modelJob } from "./support/job-deps.ts";

const MAX_RUNNING_TIME_IN_HOURS = 6;
const COMMUNITY_CHAT_MESSAGES = "community_chat_messages";

export const forceFinishLongRunningCommunityChatRecapRunsJobWith = modelJob({ min: 0 }, async (_args, deps) => {
  const cutoff = ago({ hours: MAX_RUNNING_TIME_IN_HOURS }, deps.now());
  const where = Prisma.sql`${runningScope()} AND (created_at < ${cutoff})`;
  await findInBatches(COMMUNITY_CHAT_RECAP_RUNS, where, 1_000, async (rows) => {
    for (const row of rows) {
      const run = CommunityChatRecapRuns.load(castRow<CommunityChatRecapRun>("CommunityChatRecapRun", row));
      useClock(run, deps.now);
      const pending = Prisma.sql`${column(COMMUNITY_CHAT_RECAPS, "community_chat_recap_run_id")} = ${run.get("id")} AND ${recapStatusScope(RECAP_STATUSES.pending)}`;
      await findInBatches(COMMUNITY_CHAT_RECAPS, pending, 1_000, async (recapRows) => {
        for (const recapRow of recapRows) {
          const recap = loadRecapOf(run, castRow<CommunityChatRecap>("CommunityChatRecap", recapRow));
          await CommunityChatRecaps.updateBang(
            recap,
            { status: RECAP_STATUSES.failed, error_message: `Recap run cancelled because it took longer than ${MAX_RUNNING_TIME_IN_HOURS} hours to complete` },
            { now: deps.now },
          );
        }
      });
      await CommunityChatRecapRuns.updateBang(run, { finished_at: deps.now() }, { now: deps.now });
    }
  });
});

// `from_date.present?`
const isPresent = (value: unknown) => value != null && value !== false && !(typeof value === "string" && value.trim() === "");

export const triggerCommunityChatRecapRunJobWith = modelJob({ min: 1, max: 2 }, async (args, deps) => {
  const [recapFrequency, fromDateArg = null] = args;
  if (!Object.values(RECAP_FREQUENCIES).includes(recapFrequency as never)) throw new Error("Recap frequency must be daily or weekly");
  const daily = recapFrequency === RECAP_FREQUENCIES.daily;

  const yesterday = addDays(toCalendarDate(deps.now()), -1);
  let fromDay: CalendarDate;
  if (isPresent(fromDateArg)) {
    if (typeof fromDateArg !== "string") throw new TypeError("no implicit conversion into String");
    fromDay = parseIsoDate(fromDateArg);
  } else {
    fromDay = daily ? yesterday : addDays(yesterday, -6);
  }
  const fromDate = beginningOfDay(fromDay);
  const toDate = endOfDay(daily ? fromDay : addDays(fromDay, 6));

  await transaction(async () => {
    const R = COMMUNITY_CHAT_RECAP_RUNS;
    const existing = await selectRows(
      Prisma.sql`SELECT ${Prisma.raw(`\`${R}\`.*`)} FROM ${table(R)} WHERE ${column(R, "recap_frequency")} = ${recapFrequency} AND ${column(R, "from_date")} = ${fromDate} AND ${column(R, "to_date")} = ${toDate} LIMIT 1`,
    );
    if (existing.length > 0) return;

    const M = COMMUNITY_CHAT_MESSAGES;
    const messages = await selectRows<{ community_id: unknown }>(
      Prisma.sql`SELECT ${column(M, "community_id")} FROM ${table(M)} WHERE ${column(M, "deleted_at")} IS NULL AND ${column(M, "created_at")} BETWEEN ${fromDate} AND ${toDate}`,
    );
    const communityIds = [...new Map(messages.map((m) => [String(m.community_id), m.community_id])).values()];

    const run = CommunityChatRecapRuns.build({
      recap_frequency: recapFrequency as string,
      from_date: fromDate,
      to_date: toDate,
      recaps_count: communityIds.length,
      ...(communityIds.length === 0 ? { finished_at: deps.now() } : {}),
    } as Partial<CommunityChatRecapRun>);
    useClock(run, deps.now);
    await CommunityChatRecapRuns.saveBang(run, { now: deps.now });

    for (const communityId of communityIds) {
      const recap = await createRecapFor(run, { community_id: communityId } as Partial<CommunityChatRecap>, { now: deps.now });
      await performAsync("GenerateCommunityChatRecapJob", [Number(recap.get("id"))]);
    }
  });
});

export const forceFinishLongRunningCommunityChatRecapRunsJob = forceFinishLongRunningCommunityChatRecapRunsJobWith();
export const triggerCommunityChatRecapRunJob = triggerCommunityChatRecapRunJobWith();
