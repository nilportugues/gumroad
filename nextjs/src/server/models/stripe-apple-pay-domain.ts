// Port of app/models/stripe_apple_pay_domain.rb, complete.
import { Prisma, type StripeApplePayDomain } from "@prisma/client";

import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { validatesPresenceOf } from "./runtime/validators.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

const TABLE = "stripe_apple_pay_domains";

export type StripeApplePayDomainRecord = ModelRecord<StripeApplePayDomain>;

export const StripeApplePayDomains = defineModel<StripeApplePayDomain>({
  rubyClass: "StripeApplePayDomain",
  prismaModel: "StripeApplePayDomain",
  delegate: (tx) => tx.stripeApplePayDomain as never,
  validations: [
    {
      // `validates_presence_of :user` reads the association (`belongs_to :user, optional: true`):
      // no query for a nil key, otherwise the user row on every validation.
      name: "validates_presence_of user",
      async run(record, { tx }) {
        const userId = record.get("user_id");
        const rows =
          userId == null
            ? []
            : await tx.$queryRaw<unknown[]>(Prisma.sql`SELECT ${Prisma.raw("`users`.*")} FROM ${table("users")} WHERE ${column("users", "id")} = ${userId} LIMIT 1`);
        if (rows.length === 0) record.errors.add("user", "blank");
      },
    },
    validatesPresenceOf<StripeApplePayDomain>(["domain", "stripe_id"]),
  ],
});

// `StripeApplePayDomain.lock.find_by(domain:)`; call it inside a transaction.
export async function lockByDomain(domain: string): Promise<StripeApplePayDomainRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`stripe_apple_pay_domains`.*")} FROM ${table(TABLE)} WHERE ${column(TABLE, "domain")} = ${domain} LIMIT 1 FOR UPDATE`,
  );
  return row ? StripeApplePayDomains.load(castRow<StripeApplePayDomain>("StripeApplePayDomain", row)) : null;
}
