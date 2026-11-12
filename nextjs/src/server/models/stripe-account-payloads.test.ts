// Replays stripe-account-payloads.golden.json (scripts/golden/stripe-account-payloads.rb): the hashes StripeMerchantAccountManager
// built from the same rows, compared as JSON text so the key order Stripe's form encoding sends is part of the answer.
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  accountHash,
  bankAccountHash,
  companyHash,
  personHash,
  type ComplianceRow,
  type StripeParams,
} from "./stripe-account-payloads.ts";
import { decryptedTaxId } from "./user-compliance-info.ts";
import { NotPortedError } from "./user.ts";

type StoredRow = Record<string, string | boolean | null>;
type Outcome<T> = { result: T } | { error: string };
type InfoInput = { external_id: string; row: StoredRow };
type Golden = {
  account: {
    name: string;
    input: {
      user: { external_id: string; email: string; business_profile_url: string };
      tos: { created_at_epoch: number; ip: string; external_id: string } | null;
      info: InfoInput | null;
    };
    account_hash: Outcome<StripeParams>;
  }[];
  person: { name: string; input: { email: string; info: InfoInput }; person_hash: Outcome<StripeParams> }[];
  company: { name: string; input: { info: InfoInput }; company_hash: Outcome<StripeParams> }[];
  bank: {
    name: string;
    input: {
      bank_account: Record<string, string | null>;
      info: InfoInput;
      stripe_account: { metadata?: Record<string, string> | null };
    };
    bank_account_hash: Outcome<StripeParams>;
  }[];
};

const golden = JSON.parse(
  readFileSync(new URL("./__fixtures__/stripe-account-payloads.golden.json", import.meta.url), "utf8"),
) as Golden;
const envTest = readFileSync(new URL("../../../../.env.test", import.meta.url), "utf8");
const saved = { key: process.env.STRONGBOX_GENERAL, password: process.env.STRONGBOX_GENERAL_PASSWORD };

beforeAll(() => {
  // The key of the test environment, committed in .env.test.
  process.env.STRONGBOX_GENERAL = /^STRONGBOX_GENERAL="(.+)"$/mu.exec(envTest)![1]!.replaceAll("\\n", "\n");
  process.env.STRONGBOX_GENERAL_PASSWORD = /^STRONGBOX_GENERAL_PASSWORD="?([^"\n]+)"?$/mu.exec(envTest)![1];
});

afterAll(() => {
  for (const [name, value] of [
    ["STRONGBOX_GENERAL", saved.key],
    ["STRONGBOX_GENERAL_PASSWORD", saved.password],
  ] as const) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});

const row = (stored: StoredRow): ComplianceRow => ({
  ...(stored as unknown as ComplianceRow),
  birthday: typeof stored.birthday === "string" ? new Date(`${stored.birthday}T00:00:00Z`) : null,
});
const taxId = (stored: StoredRow, column: string): string => {
  const value = stored[column];
  return decryptedTaxId(typeof value === "string" ? Buffer.from(value, "base64") : null);
};

function check<T>(expected: Outcome<T>, run: () => unknown): void {
  if ("error" in expected) {
    const [name, ...message] = expected.error.split(": ");
    let thrown: unknown;
    try {
      run();
    } catch (error) {
      thrown = error;
    }
    expect(thrown, "Ruby raised").toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(message.join(": ").replace(/^undefined method /u, "undefined method "));
    expect(name).toBe("NoMethodError");
    return;
  }
  expect(JSON.stringify(run())).toBe(JSON.stringify(expected.result));
}

describe("account_hash", () => {
  it.each(golden.account)("builds $name as Ruby does", ({ input, account_hash }) => {
    check(account_hash, () =>
      accountHash({
        userExternalId: input.user.external_id,
        businessProfileUrl: input.user.business_profile_url,
        tosAgreement: input.tos && {
          createdAtEpoch: input.tos.created_at_epoch,
          ip: input.tos.ip,
          externalId: input.tos.external_id,
        },
        info: input.info && {
          row: row(input.info.row),
          externalId: input.info.external_id,
          email: input.user.email,
          individualTaxId: taxId(input.info.row, "individual_tax_id"),
          businessTaxId: taxId(input.info.row, "business_tax_id"),
        },
      }),
    );
  });
});

describe("person_hash", () => {
  it.each(golden.person)("builds $name as Ruby does", ({ input, person_hash }) => {
    check(person_hash, () => personHash(row(input.info.row), input.email, taxId(input.info.row, "individual_tax_id")));
  });
});

describe("company_hash", () => {
  it.each(golden.company)("builds $name as Ruby does", ({ input, company_hash }) => {
    check(company_hash, () => companyHash(row(input.info.row), taxId(input.info.row, "business_tax_id")));
  });
});

describe("bank_account_hash", () => {
  it.each(golden.bank)("builds $name as Ruby does", ({ input, bank_account_hash }) => {
    const bank = input.bank_account;
    check(bank_account_hash, () =>
      bankAccountHash({
        bank: bank as never,
        externalId: bank.external_id!,
        accountNumber: decryptedTaxId(Buffer.from(bank.account_number!, "base64")),
        legalEntity: row(input.info.row),
        stripeMetadata: input.stripe_account.metadata,
      }),
    );
  });

  it("refuses a bank account class whose Stripe accessors are not ported before building anything", () => {
    const [first] = golden.bank;
    expect(() =>
      bankAccountHash({
        bank: { ...(first!.input.bank_account as never as object), type: "JapanBankAccount" } as never,
        externalId: "x",
        accountNumber: "1",
        legalEntity: row(first!.input.info.row),
      }),
    ).toThrow(NotPortedError);
  });

  it("refuses metadata that already names a bank account", () => {
    const [first] = golden.bank;
    expect(() =>
      bankAccountHash({
        bank: first!.input.bank_account as never,
        externalId: "x",
        accountNumber: "1",
        legalEntity: row(first!.input.info.row),
        stripeMetadata: { bank_account_id: "old" },
      }),
    ).toThrow(NotPortedError);
  });
});
