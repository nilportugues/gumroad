// Port of app/models/community_chat_recap_run.rb and app/models/community_chat_recap.rb. Not ported: the `between` scope.
import { Prisma, type CommunityChatRecap, type CommunityChatRecapRun } from "@prisma/client";

import { readBelongsTo } from "./concerns/belongs-to-record.ts";
import { performAsync } from "./concerns/job-runtime.ts";
import {
  belongsToRequired,
  setAssociation,
  validatesAssociationPresence,
  validatesUniqueness,
} from "./concerns/rails-validations.ts";
import { addDays, dateToS, toCalendarDate, wday } from "./concerns/ruby-time.ts";
import { defineModel, type SaveOptions } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { validatesInclusionOf, validatesNumericalityOf, validatesPresenceOf } from "./runtime/validators.ts";
import { column, selectRows, table } from "./sql.ts";

export const COMMUNITY_CHAT_RECAP_RUNS = "community_chat_recap_runs";
export const COMMUNITY_CHAT_RECAPS = "community_chat_recaps";

export const RECAP_FREQUENCIES = { daily: "daily", weekly: "weekly" } as const;
export const RECAP_STATUSES = { pending: "pending", finished: "finished", failed: "failed" } as const;

const SATURDAY = 6;

export const isRecapRunFinished = (run: ModelRecord<CommunityChatRecapRun>) => run.get("finished_at") != null;

export const CommunityChatRecapRuns = defineModel<CommunityChatRecapRun>({
  rubyClass: "CommunityChatRecapRun",
  prismaModel: "CommunityChatRecapRun",
  delegate: (tx) => tx.communityChatRecapRun as never,
  validations: [
    validatesPresenceOf<CommunityChatRecapRun>(["recap_frequency", "from_date", "to_date"]),
    validatesUniqueness<CommunityChatRecapRun>("CommunityChatRecapRun", COMMUNITY_CHAT_RECAP_RUNS, "recap_frequency", {
      scope: ["from_date", "to_date"],
    }),
    // `enum ..., validate: true`
    validatesInclusionOf<CommunityChatRecapRun>(["recap_frequency"], { in: Object.values(RECAP_FREQUENCIES) }),
  ],
  // after_save_commit callbacks, in declaration order; the runtime runs them in reverse.
  afterCommit: [
    {
      name: "trigger_weekly_recap_run",
      on: ["create", "update"],
      run: async (record) => {
        if (record.get("recap_frequency") !== RECAP_FREQUENCIES.daily) return;
        if (!isRecapRunFinished(record)) return;
        const fromDate = toCalendarDate(record.get("from_date"));
        if (wday(fromDate) !== SATURDAY) return;
        await performAsync("TriggerCommunityChatRecapRunJob", ["weekly", dateToS(addDays(fromDate, -6))]);
      },
    },
    {
      name: "send_recap_notifications",
      on: ["create", "update"],
      run: async (record) => {
        if (!isRecapRunFinished(record)) return;
        if (record.get("notified_at") != null) return;
        await performAsync("SendCommunityChatRecapNotificationsJob", [record.get("id")]);
        const now = clockOf(record);
        await CommunityChatRecapRuns.updateBang(record, { notified_at: now() }, { now });
      },
    },
  ],
});

// Time.current for the callbacks: the runtime does not hand them the clock the save was given.
const CLOCK = "clock";
const clockOf = (record: ModelRecord<CommunityChatRecapRun>) =>
  (record.ivars[CLOCK] as (() => Date) | undefined) ?? (() => new Date());

export function useClock(record: ModelRecord<CommunityChatRecapRun>, now: () => Date): void {
  record.ivars[CLOCK] = now;
}

export const runningScope = () => Prisma.sql`${column(COMMUNITY_CHAT_RECAP_RUNS, "finished_at")} IS NULL`;
export const finishedScope = () => Prisma.sql`${column(COMMUNITY_CHAT_RECAP_RUNS, "finished_at")} IS NOT NULL`;

const recapRun = {
  name: "community_chat_recap_run",
  foreignKey: "community_chat_recap_run_id",
  targetTable: COMMUNITY_CHAT_RECAP_RUNS,
  targetModel: "CommunityChatRecapRun",
} as const;
const seller = { name: "seller", foreignKey: "seller_id", targetTable: "users", targetModel: "User" } as const;

export const CommunityChatRecaps = defineModel<CommunityChatRecap>({
  rubyClass: "CommunityChatRecap",
  prismaModel: "CommunityChatRecap",
  delegate: (tx) => tx.communityChatRecap as never,
  validations: [
    belongsToRequired<CommunityChatRecap>(recapRun),
    validatesPresenceOf<CommunityChatRecap>(["summarized_message_count"]),
    validatesNumericalityOf<CommunityChatRecap>(["summarized_message_count"], { greater_than_or_equal_to: 0 }),
    validatesPresenceOf<CommunityChatRecap>(["input_token_count"]),
    validatesNumericalityOf<CommunityChatRecap>(["input_token_count"], { greater_than_or_equal_to: 0 }),
    validatesPresenceOf<CommunityChatRecap>(["output_token_count"]),
    validatesNumericalityOf<CommunityChatRecap>(["output_token_count"], { greater_than_or_equal_to: 0 }),
    {
      ...validatesAssociationPresence<CommunityChatRecap>(seller),
      if: (record) => record.get("status") === RECAP_STATUSES.finished,
    },
    validatesInclusionOf<CommunityChatRecap>(["status"], { in: Object.values(RECAP_STATUSES) }),
  ],
});

export const recapStatusScope = (status: string) => Prisma.sql`${column(COMMUNITY_CHAT_RECAPS, "status")} = ${status}`;

// `recap_run.community_chat_recaps.create!(attributes)`: the inverse is set, so the recap's
// belongs_to validation does not reload the run.
export function createRecapFor(
  run: ModelRecord<CommunityChatRecapRun>,
  attributes: Partial<CommunityChatRecap>,
  options?: SaveOptions,
) {
  const recap = CommunityChatRecaps.build({ ...attributes, community_chat_recap_run_id: run.get("id") });
  setAssociation(recap, recapRun.name, run.get("id"), run.attributes);
  return CommunityChatRecaps.saveBang(recap, options);
}

// A recap loaded through `run.community_chat_recaps`, with its inverse set.
export function loadRecapOf(
  run: ModelRecord<CommunityChatRecapRun>,
  row: CommunityChatRecap,
): ModelRecord<CommunityChatRecap> {
  const recap = CommunityChatRecaps.load(row);
  setAssociation(recap, recapRun.name, run.get("id"), run.attributes);
  return recap;
}

// `recap.community_chat_recap_run.check_if_finished!`: the run finishes once none of its recaps is pending and every recap it counts has
// finished or failed. The run is the one the recap's belongs_to validation already loaded, so there is no second read of it.
export async function checkRunOfRecapFinishedBang(
  recap: ModelRecord<CommunityChatRecap>,
  now: () => Date,
): Promise<void> {
  const run = await readBelongsTo(recap, recapRun, CommunityChatRecapRuns);
  if (!run) throw new TypeError("undefined method 'check_if_finished!' for nil");
  if (isRecapRunFinished(run)) return;

  const rows = await selectRows<{ status: string }>(
    Prisma.sql`SELECT ${column(COMMUNITY_CHAT_RECAPS, "status")} FROM ${table(COMMUNITY_CHAT_RECAPS)} WHERE ${column(COMMUNITY_CHAT_RECAPS, "community_chat_recap_run_id")} = ${run.get("id")}`,
  );
  const statuses = rows.map((row) => row.status);
  if (statuses.includes(RECAP_STATUSES.pending)) return;
  const settled = statuses.filter(
    (status) => status === RECAP_STATUSES.finished || status === RECAP_STATUSES.failed,
  ).length;
  if (Number(run.get("recaps_count")) - settled > 0) return;

  useClock(run, now);
  await CommunityChatRecapRuns.updateBang(run, { finished_at: now() }, { now });
}
