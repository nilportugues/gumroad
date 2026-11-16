// The write side of app/models/user_compliance_info.rb (Immutable): a revision is never edited, `dup_and_save!` marks it deleted
// and inserts a copy. Only what the ported callers need is here; the validations that depend on fields they never set
// (kana, romaji, guardians) are not, so those callers hand back before the first write.
import type { UserComplianceInfo } from "@prisma/client";

import { notifyError } from "../infra/error-reporting.ts";

import { deletable } from "./concerns/deletable.ts";
import { performAsync } from "./concerns/job-runtime.ts";
import { jsonData } from "./concerns/json-data.ts";
import { validatesAssociationPresence } from "./concerns/rails-validations.ts";
import { defineModel, type SaveOptions } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { transaction } from "./runtime/transaction.ts";

export const MINIMUM_DATE_OF_BIRTH_AGE = 13;
const HANDLE_NEW_COMPLIANCE_INFO_DELAY_SECONDS = 5;

export type UserComplianceInfoRecord = ModelRecord<UserComplianceInfo>;

// `birthday > MINIMUM_DATE_OF_BIRTH_AGE.years.ago`
export function birthdayUnderMinimumAge(birthday: Date | null, now: Date): boolean {
  if (birthday === null) return false;
  const limit = new Date(now);
  limit.setUTCFullYear(limit.getUTCFullYear() - MINIMUM_DATE_OF_BIRTH_AGE);
  return birthday.getTime() > limit.getTime();
}

// after_create_commit runs in reverse order of definition: handle_stripe_compliance_info, handle_compliance_info_request and
// detect_legal_entity_country_drift are declared in that order. `skip_stripe_job_on_create` is never set on a path that reaches Node.
export const UserComplianceInfos = defineModel<UserComplianceInfo>({
  rubyClass: "UserComplianceInfo",
  prismaModel: "UserComplianceInfo",
  delegate: (tx) => tx.userComplianceInfo as never,
  validations: [
    validatesAssociationPresence<UserComplianceInfo>({
      name: "user",
      foreignKey: "user_id",
      targetTable: "users",
      targetModel: "User",
    }),
    {
      name: "birthday_is_over_minimum_age",
      run(record) {
        if (birthdayUnderMinimumAge(record.get("birthday"), new Date()))
          record.errors.add("base", `You must be ${MINIMUM_DATE_OF_BIRTH_AGE} years old to use Gumroad.`);
      },
    },
  ],
  beforeCreate: [
    // Reading `json_data` makes Rails default a NULL column to {} before the insert.
    { name: "json_data_default", run: (record) => void jsonData(record) },
  ],
  afterCommit: [
    {
      name: "handle_stripe_compliance_info",
      on: "create",
      async run(record) {
        try {
          await performAsync("HandleNewUserComplianceInfoWorker", [Number(record.get("id"))], {
            delaySeconds: HANDLE_NEW_COMPLIANCE_INFO_DELAY_SECONDS,
          });
        } catch (error) {
          notifyError(error, { user_compliance_info_id: record.get("id") });
        }
      },
    },
    {
      // UserComplianceInfoRequest.handle_new_user_compliance_info only writes when the seller has a requested request; callers
      // check that before the first write and hand back.
      name: "handle_compliance_info_request",
      on: "create",
      run() {},
    },
    {
      name: "detect_legal_entity_country_drift",
      on: "create",
      async run(record) {
        try {
          await performAsync("DetectLegalEntityCountryDriftJob", [Number(record.get("id"))]);
        } catch (error) {
          notifyError(error, { user_compliance_info_id: record.get("id") });
        }
      },
    },
  ],
});

export const UserComplianceInfoDeletable = deletable(UserComplianceInfos);

const DUP_OMITTED = new Set(["id", "created_at", "updated_at"]);

// Immutable.perform_dup_and_save with raise_errors: true. `record` may be the unsaved blank revision `fetch_or_build` returns:
// Rails then inserts it, already deleted, before the copy.
export async function dupAndSaveBang(
  record: UserComplianceInfoRecord,
  block: (copy: UserComplianceInfoRecord) => Promise<void>,
  options: SaveOptions = {},
): Promise<UserComplianceInfoRecord> {
  const copy = UserComplianceInfos.build(
    Object.fromEntries(
      Object.entries(record.attributes).filter(([name]) => !DUP_OMITTED.has(name)),
    ) as Partial<UserComplianceInfo>,
  );
  await transaction(async () => {
    await block(copy);
    if (!(await UserComplianceInfoDeletable.markDeleted(record, { ...options, validate: false }))) {
      throw new Error("the superseded compliance revision could not be marked deleted");
    }
    await UserComplianceInfos.saveBang(copy, options);
  });
  return copy;
}
