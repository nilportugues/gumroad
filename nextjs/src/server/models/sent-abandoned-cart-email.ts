// Port of app/models/sent_abandoned_cart_email.rb, complete.
import type { SentAbandonedCartEmail } from "@prisma/client";

import { belongsToRequired } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";

export const SENT_ABANDONED_CART_EMAILS = "sent_abandoned_cart_emails";

export const SentAbandonedCartEmails = defineModel<SentAbandonedCartEmail>({
  rubyClass: "SentAbandonedCartEmail",
  prismaModel: "SentAbandonedCartEmail",
  delegate: (tx) => tx.sentAbandonedCartEmail as never,
  validations: [
    belongsToRequired<SentAbandonedCartEmail>({ name: "cart", foreignKey: "cart_id", targetTable: "carts", targetModel: "Cart" }),
    belongsToRequired<SentAbandonedCartEmail>({ name: "installment", foreignKey: "installment_id", targetTable: "installments", targetModel: "Installment" }),
  ],
});
