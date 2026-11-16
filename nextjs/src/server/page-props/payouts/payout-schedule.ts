// User::PayoutSchedule (app/modules/user/payout_schedule.rb) for the weekly, monthly and quarterly
// frequencies, and the date helpers of PayoutsHelper. Dates are Ruby Dates held as UTC midnight; the
// application runs in UTC, so Date.today and Date.current agree.
//
// The ledger reads are injected so the schedule is a pure function of them: payout-schedule.test.ts
// replays goldens recorded from the real module (scripts/golden/payout-schedule.rb).
import DATA from "./payouts-data.generated.json" with { type: "json" };

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const FRIDAY = 5;
const DAY_MS = 86_400_000;

export const PAYOUT_DELAY_DAYS = DATA.constants.payoutDelayDays;
export const PAYOUT_FREQUENCIES = ["daily", "weekly", "monthly", "quarterly"] as const;
export type PayoutFrequency = (typeof PAYOUT_FREQUENCIES)[number];

export const dateOnly = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
export const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * DAY_MS);
export const sameDay = (a: Date, b: Date) => a.getTime() === b.getTime();
// Date#to_s
export const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

// Date#next_month(n): the day is clamped to the end of the target month.
function addMonths(date: Date, months: number): Date {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(date.getUTCDate(), lastDay)));
}
const endOfMonth = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
const endOfQuarter = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), Math.floor(date.getUTCMonth() / 3) * 3 + 3, 0));
const isFriday = (date: Date) => date.getUTCDay() === FRIDAY;
// Date#next_occurring(:friday) / #prev_occurring(:friday): always a different day.
const nextFriday = (date: Date) => addDays(date, ((FRIDAY - date.getUTCDay() + 6) % 7) + 1);
const prevFriday = (date: Date) => addDays(date, -(((date.getUTCDay() - FRIDAY + 6) % 7) + 1));

const lastFridayOfWeek = (date: Date) => (isFriday(date) ? date : nextFriday(date));
const lastFridayOfMonth = (date: Date) => {
  const monthEnd = endOfMonth(date);
  return isFriday(monthEnd) ? monthEnd : prevFriday(monthEnd);
};
const lastFridayOfQuarter = (date: Date) => {
  const quarterEnd = endOfQuarter(date);
  return isFriday(quarterEnd) ? quarterEnd : prevFriday(quarterEnd);
};

export class DailyPayoutNotPorted extends Error {}

// get_initial_payout_date and advance_payout_date. A daily seller's fallback is the weekly cycle,
// but their own date comes from Payouts.is_user_payable, which is not ported.
function initialPayoutDate(frequency: PayoutFrequency, date: Date): Date {
  switch (frequency) {
    case "monthly":
      return lastFridayOfMonth(date);
    case "quarterly":
      return lastFridayOfQuarter(date);
    default:
      return lastFridayOfWeek(date);
  }
}
function advancePayoutDate(frequency: PayoutFrequency, date: Date): Date {
  switch (frequency) {
    case "monthly":
      return lastFridayOfMonth(addMonths(date, 1));
    case "quarterly":
      return lastFridayOfQuarter(addMonths(date, 3));
    default:
      return lastFridayOfWeek(addDays(date, 7));
  }
}

// PayoutRailSchedule: the weekday the seller's own rail is paid on.
export type RailInput = { bankAccountType: string | null; payoutsViaPaypal: boolean };
export function payoutWeekday({ bankAccountType, payoutsViaPaypal }: RailInput): (typeof WEEKDAYS)[number] {
  const rails = DATA.railWeekday;
  if (bankAccountType !== null) {
    const weekday = (rails.bankAccountTypes as Record<string, string>)[bankAccountType];
    return (weekday ?? "friday") as (typeof WEEKDAYS)[number];
  }
  if (rails.paypal === rails.stripeConnect) return rails.paypal as (typeof WEEKDAYS)[number];
  return (payoutsViaPaypal ? rails.paypal : rails.stripeConnect) as (typeof WEEKDAYS)[number];
}

// How many days before the cycle's Friday the rail runs.
export const daysBeforeCycleDate = (weekday: (typeof WEEKDAYS)[number]) =>
  (FRIDAY - WEEKDAYS.indexOf(weekday) + WEEKDAYS.length) % WEEKDAYS.length;

export type Ledger = {
  today: Date;
  frequency: PayoutFrequency;
  minimumPayoutAmountCents: number;
  daysBeforeCycleDate: number;
  unpaidBalanceCents: () => Promise<number>;
  unpaidBalanceCentsUpToDate: (date: Date) => Promise<number>;
  // `payments.where("date(created_at) = ?", Date.today).first.present?`
  paidToday: () => Promise<boolean>;
  // A daily-frequency seller that Payouts.is_user_payable(INSTANT) rejects: the schedule is the weekly one, but
  // PayoutsHelper#current_payout_end_date still reads the period end as the day before the payout date.
  dailyFallback?: boolean;
};

const payoutDateForCycle = (ledger: Ledger, cycle: Date) => addDays(cycle, -ledger.daysBeforeCycleDate);
const cycleForPayoutDate = (ledger: Ledger, payoutDate: Date) => addDays(payoutDate, ledger.daysBeforeCycleDate);

function assertNotDaily(ledger: Ledger) {
  if (ledger.frequency === "daily")
    throw new DailyPayoutNotPorted("User::PayoutSchedule for a daily payout frequency (Payouts.is_user_payable)");
}

// payout_period_end_date_for_payout_date, for a frequency other than daily.
export function payoutPeriodEndDateForPayoutDate(ledger: Ledger, payoutDate: Date): Date {
  assertNotDaily(ledger);
  return addDays(cycleForPayoutDate(ledger, payoutDate), -PAYOUT_DELAY_DAYS);
}

// payout_amount_for_payout_date, for a frequency other than daily.
const payoutAmountForPayoutDate = (ledger: Ledger, payoutDate: Date) =>
  ledger.unpaidBalanceCentsUpToDate(payoutPeriodEndDateForPayoutDate(ledger, payoutDate));

export async function nextPayoutCycleDate(ledger: Ledger): Promise<Date | null> {
  if ((await ledger.unpaidBalanceCents()) < ledger.minimumPayoutAmountCents) return null;
  assertNotDaily(ledger);

  const { today, frequency } = ledger;
  let cycle = initialPayoutDate(frequency, today);
  while (cycle.getTime() < today.getTime()) cycle = advancePayoutDate(frequency, cycle);

  if ((await payoutAmountForPayoutDate(ledger, payoutDateForCycle(ledger, cycle))) < ledger.minimumPayoutAmountCents)
    cycle = advancePayoutDate(frequency, cycle);

  if (sameDay(cycle, today) && (await ledger.paidToday())) cycle = advancePayoutDate(frequency, cycle);
  return cycle;
}

export async function nextPayoutDate(ledger: Ledger): Promise<Date | null> {
  const cycle = await nextPayoutCycleDate(ledger);
  if (cycle === null) return null;

  let upcoming = payoutDateForCycle(ledger, cycle);
  const alreadyPaidToday = sameDay(upcoming, ledger.today) && (await ledger.paidToday());
  if (upcoming.getTime() < ledger.today.getTime() || alreadyPaidToday)
    upcoming = payoutDateForCycle(ledger, advancePayoutDate(ledger.frequency, cycle));
  return upcoming;
}

// PayoutsHelper#current_payout_end_date
export async function currentPayoutEndDate(ledger: Ledger): Promise<Date> {
  const next = await nextPayoutDate(ledger);
  if (next === null) throw new TypeError("undefined method '-' for nil");
  if (ledger.dailyFallback) return addDays(next, -1);
  assertNotDaily(ledger);
  return payoutPeriodEndDateForPayoutDate(ledger, next);
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// Integer#ordinalize
export function ordinalize(day: number): string {
  const teens = day % 100;
  if (teens >= 11 && teens <= 13) return `${day}th`;
  return `${day}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ?? "th"}`;
}

// PayoutsHelper#formatted_payout_date: strftime("%B #{day.ordinalize}, %Y")
export function formattedPayoutDate(date: Date | null): string {
  if (date === null) return "";
  return `${MONTHS[date.getUTCMonth()]} ${ordinalize(date.getUTCDate())}, ${date.getUTCFullYear()}`;
}

// PayoutsHelper#displayable_payout_period_range
export function displayablePayoutPeriodRange(
  previousPeriodEnd: Date | null,
  payoutPeriodEndDate: Date,
  today: Date,
): string {
  if (previousPeriodEnd !== null) {
    const next = addDays(previousPeriodEnd, 1);
    const activityStart = next.getTime() < today.getTime() ? next : today;
    if (payoutPeriodEndDate.getTime() > today.getTime()) return `Activity since ${formattedPayoutDate(activityStart)}`;
    if (sameDay(payoutPeriodEndDate, activityStart)) return `Activity on ${formattedPayoutDate(payoutPeriodEndDate)}`;
    return `Activity from ${formattedPayoutDate(activityStart)} to ${formattedPayoutDate(payoutPeriodEndDate)}`;
  }
  return payoutPeriodEndDate.getTime() > today.getTime()
    ? "Activity up to now"
    : `Activity up to ${formattedPayoutDate(payoutPeriodEndDate)}`;
}
