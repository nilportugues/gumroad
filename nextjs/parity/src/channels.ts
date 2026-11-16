import { json, type Json, timeToken } from "./canonical";
import type { CapturedJob, CapturedMail } from "./fixture";

// Side-effect channels the replayer reads after each request. WS-05 (jobs) and WS-06 (mail)
// provide real implementations; the in-memory ones below suit tests that stub enqueue/send.

export type RawJob = {
  class: string;
  args: unknown[];
  queue?: string;
  // A Date, or Sidekiq's float epoch seconds.
  at?: Date | number;
  activeJob?: boolean;
};

export type RawMail = {
  mailer?: string;
  from?: string[];
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject?: string;
  text?: string;
  html?: string;
};

export interface JobsChannel {
  reset(): void | Promise<void>;
  drain(): RawJob[] | Promise<RawJob[]>;
}

export interface MailChannel {
  reset(): void | Promise<void>;
  drain(): RawMail[] | Promise<RawMail[]>;
}

export function memoryJobs(): JobsChannel & { push(job: RawJob): void } {
  let jobs: RawJob[] = [];
  return {
    push: (job) => jobs.push(job),
    reset: () => {
      jobs = [];
    },
    drain: () => {
      const drained = jobs;
      jobs = [];
      return drained;
    },
  };
}

export function memoryMails(): MailChannel & { push(mail: RawMail): void } {
  let mails: RawMail[] = [];
  return {
    push: (mail) => mails.push(mail),
    reset: () => {
      mails = [];
    },
    drain: () => {
      const drained = mails;
      mails = [];
      return drained;
    },
  };
}

export function canonicalJob(job: RawJob, now: Date): CapturedJob {
  const out: CapturedJob = { class: job.class, args: json(job.args, now), queue: job.queue ?? "default" };
  if (job.activeJob) out.activeJob = true;
  if (job.at !== undefined) out.at = timeToken(job.at instanceof Date ? job.at : new Date(job.at * 1000), now);
  return out;
}

export function canonicalMail(mail: RawMail, now: Date): CapturedMail {
  return json(
    Object.fromEntries(Object.entries(mail).filter(([, value]) => value !== undefined)),
    now,
  ) as Json as CapturedMail;
}
