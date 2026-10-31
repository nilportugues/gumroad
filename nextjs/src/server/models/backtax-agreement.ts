// Port of app/models/backtax_agreement.rb, complete except the has_one :credit and
// has_many :backtax_collections readers.
import { Prisma, type BacktaxAgreement } from "@prisma/client";

import { defineFlags } from "../../lib/flags.ts";
import { belongsToRequired } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";
import { validatesInclusionOf, validatesPresenceOf } from "./runtime/validators.ts";

export const BACKTAX_AGREEMENTS = "backtax_agreements";

export const BACKTAX_JURISDICTIONS = { AUSTRALIA: "AUSTRALIA" } as const;
export const ALL_BACKTAX_JURISDICTIONS: readonly string[] = [BACKTAX_JURISDICTIONS.AUSTRALIA];

// Bit positions are persisted data: never renumber.
export const BacktaxAgreementFlags = defineFlags(BACKTAX_AGREEMENTS, { 1: "collected" }, { queryMode: "bit_operator" });

export const BacktaxAgreements = defineModel<BacktaxAgreement>({
  rubyClass: "BacktaxAgreement",
  prismaModel: "BacktaxAgreement",
  delegate: (tx) => tx.backtaxAgreement as never,
  // belongs_to :user is declared before the validates lines.
  validations: [
    belongsToRequired<BacktaxAgreement>({ name: "user", foreignKey: "user_id", targetTable: "users", targetModel: "User" }),
    validatesInclusionOf<BacktaxAgreement>(["jurisdiction"], { in: ALL_BACKTAX_JURISDICTIONS }),
    validatesPresenceOf<BacktaxAgreement>(["signature"]),
  ],
});

// flag_shih_tzu's `not_collected` scope: `where(condition)` wraps the condition in parentheses.
export const notCollectedScope = () => Prisma.sql`(${BacktaxAgreementFlags.condition("collected", false)})`;
