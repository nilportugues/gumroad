// Api::V2::PayoutsController#index and #show (app/controllers/api/v2/payouts_controller.rb). The upcoming payouts of #upcoming (and of
// #index's first page) come from User#upcoming_payouts, and `include_transactions` from Exports::Payouts::Api: both stay in Rails.
import { Prisma } from "@prisma/client";

import { encrypt } from "../../../lib/obfuscate-ids.ts";
import { column, selectRows, table } from "../../models/sql.ts";
import { HandBackToRails } from "../application-controller.ts";

import {
  type ApiV2Input,
  error400,
  errorWithObject,
  fromExternalId,
  registerApiV2,
  successWithObject,
} from "./base.ts";
import { decodePageKey, paginationInfo, USEC_FORMAT } from "./pagination.ts";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const RESULTS_PER_PAGE = 10;
const PAYMENTS = "payments";
// PayoutsHelper::OLDEST_DISPLAYABLE_PAYOUT_PERIOD_END_DATE
const OLDEST_DISPLAYABLE_PAYOUT_DATE = "2013-01-04";
const COMPLETED = "completed";

// BankAccount#account_number_visual is "******" + the last four digits unless the class prefixes it: with its fixed `country` alpha-2
// (IBAN countries) or a literal "BA". CardBankAccount (the card's visual) and EuropeanBankAccount (country read from the encrypted
// account number) are the two that still hand back.
const ACCOUNT_NUMBER_VISUAL_PREFIX: Record<string, string> = {
  AlbaniaBankAccount: "AL",
  AngolaBankAccount: "AO",
  AzerbaijanBankAccount: "AZ",
  BahrainBankAccount: "BH",
  BeninBankAccount: "BJ",
  BosniaAndHerzegovinaBankAccount: "BA",
  BulgariaBankAccount: "BG",
  CostaRicaBankAccount: "CR",
  CoteDIvoireBankAccount: "CI",
  CzechRepublicBankAccount: "CZ",
  DenmarkBankAccount: "DK",
  HungaryBankAccount: "HU",
  IcelandBankAccount: "IS",
  IsraelBankAccount: "IL",
  JordanBankAccount: "JO",
  KazakhstanBankAccount: "KZ",
  MauritiusBankAccount: "MU",
  MonacoBankAccount: "MC",
  MoroccoBankAccount: "MA",
  NigerBankAccount: "NE",
  NigeriaBankAccount: "NG",
  NorthMacedoniaBankAccount: "MK",
  PolandBankAccount: "PL",
  RomaniaBankAccount: "RO",
  SanMarinoBankAccount: "SM",
  SerbiaBankAccount: "RS",
  SwedenBankAccount: "SE",
  SwissBankAccount: "CH",
  TunisiaBankAccount: "TN",
  UaeBankAccount: "AE",
};
const OWN_ACCOUNT_NUMBER_VISUAL = new Set(["CardBankAccount", "EuropeanBankAccount"]);

const accountNumberVisual = (bank: Row) =>
  `${ACCOUNT_NUMBER_VISUAL_PREFIX[bank.type] ?? ""}******${bank.account_number_last_four ?? ""}`;

const iso8601 = (time: Date | null) => (time === null ? null : `${time.toISOString().slice(0, 19)}Z`);

// Date.strptime(value, "%Y-%m-%d"): null for a date that does not exist (ArgumentError). Any other spelling strptime accepts
// (unpadded fields, signed or longer years) is not modelled.
function parseDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) throw new HandBackToRails("a date that is not YYYY-MM-DD");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value ? value : null;
}

// A non-text parameter makes Date.strptime or the page key lookup raise a TypeError in Rails.
const asText = (params: Record<string, unknown>, key: string): string | undefined => {
  const value = params[key];
  if (value !== undefined && value !== null && typeof value !== "string")
    throw new HandBackToRails(`a non-text ${key} parameter`);
  return value ?? undefined;
};

// Payment#as_json
export async function payoutsAsJson(payments: Row[], includeSales: boolean): Promise<Record<string, unknown>[]> {
  const bankIds = [...new Set(payments.map((payment) => payment.bank_account_id).filter((id) => id !== null))];
  const banks = new Map<string, Row>();
  if (bankIds.length > 0) {
    for (const bank of await selectRows<Row>(
      Prisma.sql`SELECT ${table("bank_accounts")}.* FROM ${table("bank_accounts")} WHERE ${column("bank_accounts", "id")} IN (${Prisma.join(bankIds)})`,
    )) {
      banks.set(String(bank.id), bank);
    }
  }
  const sales = new Map<string, Record<string, string[]>>();
  if (includeSales) {
    for (const payment of payments) {
      const balanceIds = (
        await selectRows<Row>(
          Prisma.sql`SELECT ${column("payments_balances", "balance_id")} FROM ${table("payments_balances")} WHERE ${column("payments_balances", "payment_id")} = ${payment.id}`,
        )
      ).map((row) => row.balance_id);
      const salesBy = async (balanceColumn: string) =>
        balanceIds.length === 0
          ? []
          : (
              await selectRows<Row>(
                Prisma.sql`SELECT ${column("purchases", "id")} FROM ${table("purchases")} WHERE ${column("purchases", balanceColumn)} IN (${Prisma.join(balanceIds)}) ORDER BY ${column("purchases", "created_at")} DESC, ${column("purchases", "id")} DESC`,
              )
            ).map((row) => encrypt(row.id));
      sales.set(String(payment.id), {
        sales: await salesBy("purchase_success_balance_id"),
        refunded_sales: await salesBy("purchase_refund_balance_id"),
        disputed_sales: await salesBy("purchase_chargeback_balance_id"),
      });
    }
  }
  return payments.map((payment) => {
    const bank = payment.bank_account_id === null ? undefined : banks.get(String(payment.bank_account_id));
    if (bank && OWN_ACCOUNT_NUMBER_VISUAL.has(bank.type))
      throw new HandBackToRails(`a ${bank.type} payout destination`);
    return {
      id: encrypt(payment.id),
      amount: (Number(payment.amount_cents ?? 0) / 100).toFixed(2),
      currency: payment.currency,
      status: payment.state,
      created_at: iso8601(payment.created_at),
      processed_at: payment.state === COMPLETED ? iso8601(payment.updated_at) : null,
      payment_processor: payment.processor,
      bank_account_visual: bank ? accountNumberVisual(bank) : null,
      paypal_email: payment.payment_address,
      ...sales.get(String(payment.id)),
    };
  });
}

export async function index({ owner, params, request }: Pick<ApiV2Input, "owner" | "params" | "request">) {
  const before = asText(params, "before");
  const after = asText(params, "after");
  const pageKey = asText(params, "page_key");
  const conditions: Prisma.Sql[] = [
    Prisma.sql`${column(PAYMENTS, "user_id")} = ${owner.id}`,
    Prisma.sql`${column(PAYMENTS, "created_at")} >= ${OLDEST_DISPLAYABLE_PAYOUT_DATE}`,
  ];
  let endDate: string | null = null;
  let startDate: string | null = null;
  if (before !== undefined) {
    endDate = parseDate(before);
    if (endDate === null)
      return error400("Invalid date format provided in field 'before'. Dates must be in the format YYYY-MM-DD.");
  }
  if (after !== undefined) {
    startDate = parseDate(after);
    if (startDate === null)
      return error400("Invalid date format provided in field 'after'. Dates must be in the format YYYY-MM-DD.");
  }
  let pageCondition: Prisma.Sql | null = null;
  if (pageKey !== undefined && pageKey !== "") {
    const decoded = decodePageKey(pageKey);
    if (decoded === null) return error400("Invalid page_key.");
    pageCondition = Prisma.sql`(${column(PAYMENTS, "created_at")} < ${decoded.at}) OR (${column(PAYMENTS, "created_at")} = ${decoded.at} AND ${column(PAYMENTS, "id")} < ${decoded.id})`;
  } else if (params.include_upcoming !== "false") {
    throw new HandBackToRails("the upcoming payouts of the first page");
  }
  if (startDate) conditions.push(Prisma.sql`${column(PAYMENTS, "created_at")} >= ${startDate}`);
  if (endDate) conditions.push(Prisma.sql`${column(PAYMENTS, "created_at")} < ${endDate}`);
  if (pageCondition) conditions.push(pageCondition);
  const rows = await selectRows<Row>(
    Prisma.sql`SELECT ${table(PAYMENTS)}.*, DATE_FORMAT(${column(PAYMENTS, "created_at")}, ${USEC_FORMAT}) AS created_usec FROM ${table(PAYMENTS)} WHERE ${Prisma.join(
      conditions.map((condition) => Prisma.sql`(${condition})`),
      " AND ",
    )} ORDER BY ${column(PAYMENTS, "created_at")} DESC, ${column(PAYMENTS, "id")} DESC LIMIT ${RESULTS_PER_PAGE + 1}`,
  );
  const page = rows.slice(0, RESULTS_PER_PAGE);
  const next =
    rows.length > RESULTS_PER_PAGE ? paginationInfo(request, page.at(-1) as { created_usec: string; id: bigint }) : {};
  return successWithObject("payouts", await payoutsAsJson(page, false), next);
}

export async function show({
  owner,
  params,
  routeParams,
  token,
}: Pick<ApiV2Input, "owner" | "params" | "routeParams" | "token">) {
  const id = fromExternalId(routeParams.id);
  const [payment] =
    id === null
      ? []
      : await selectRows<Row>(
          Prisma.sql`SELECT ${table(PAYMENTS)}.* FROM ${table(PAYMENTS)} WHERE ${column(PAYMENTS, "user_id")} = ${owner.id} AND ${column(PAYMENTS, "id")} = ${id} LIMIT 1`,
        );
  if (payment === undefined) return errorWithObject("payout");
  if (params.include_transactions === "true") throw new HandBackToRails("a payout with its transactions");
  const scopes = (token.scopes ?? "").split(/\s+/u).filter(Boolean);
  const includeSales =
    (scopes.includes("view_sales") || scopes.includes("account")) && params.include_sales !== "false";
  return successWithObject("payout", (await payoutsAsJson([payment], includeSales))[0]);
}

// Registered ahead of /v2/payouts/:id so that "upcoming" is not read as a payout id.
function upcoming(): never {
  throw new HandBackToRails("User#upcoming_payouts");
}

registerApiV2(
  { method: "GET", pattern: "/v2/payouts", scopes: ["view_payouts"], run: index },
  { method: "GET", pattern: "/v2/payouts/upcoming", scopes: ["view_payouts"], run: upcoming },
  { method: "GET", pattern: "/v2/payouts/:id", scopes: ["view_payouts"], run: show },
);
