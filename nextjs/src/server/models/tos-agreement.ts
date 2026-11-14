// Port of app/models/tos_agreement.rb: the terms-of-service acceptance row a payments settings save records with the request's IP.
import type { TosAgreement } from "@prisma/client";

import { validatesAssociationPresence, type BelongsTo } from "./concerns/rails-validations.ts";
import { defineModel } from "./runtime/define-model.ts";

const USER: BelongsTo = { name: "user", foreignKey: "user_id", targetTable: "users", targetModel: "User" };

// `belongs_to :user, optional: true` adds no validation of its own; `validates :user, presence: true` is the only one.
export const TosAgreements = defineModel<TosAgreement>({
  rubyClass: "TosAgreement",
  prismaModel: "TosAgreement",
  delegate: (tx) => tx.tosAgreement as never,
  validations: [validatesAssociationPresence<TosAgreement>(USER)],
});
