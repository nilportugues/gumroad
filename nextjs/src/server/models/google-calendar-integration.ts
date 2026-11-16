// app/models/google_calendar_integration.rb (an STI subclass of Integration with JsonData) for the one write a job makes: the
// refreshed access token. Its lookup is `link.get_integration(type)`: the first live product integration of that type.
import { Prisma, type Integration } from "@prisma/client";

import { jsonDataForAttr, mergeJsonDataWithCurrentRow, setJsonDataForAttr } from "./concerns/json-data.ts";
import { defineModel } from "./runtime/define-model.ts";
import type { ModelRecord } from "./runtime/record.ts";
import { castRow, column, selectRows, table } from "./sql.ts";

export const GOOGLE_CALENDAR_INTEGRATION_TYPE = "GoogleCalendarIntegration";
const INTEGRATIONS = "integrations";
const PRODUCT_INTEGRATIONS = "product_integrations";

export type GoogleCalendarIntegrationRecord = ModelRecord<Integration>;

export const GoogleCalendarIntegrations = defineModel<Integration>({
  rubyClass: GOOGLE_CALENDAR_INTEGRATION_TYPE,
  prismaModel: "Integration",
  delegate: (tx) => tx.integration as never,
  beforeSave: [mergeJsonDataWithCurrentRow<Integration>(INTEGRATIONS, { type: GOOGLE_CALENDAR_INTEGRATION_TYPE })],
});

// `product.get_integration("GoogleCalendarIntegration")`: `active_integrations.where(type:).first`.
export async function findProductGoogleCalendarIntegration(
  productId: bigint,
): Promise<GoogleCalendarIntegrationRecord | null> {
  const [row] = await selectRows(
    Prisma.sql`SELECT ${Prisma.raw("`integrations`.*")} FROM ${table(INTEGRATIONS)} INNER JOIN ${table(PRODUCT_INTEGRATIONS)} ON ${column(INTEGRATIONS, "id")} = ${column(PRODUCT_INTEGRATIONS, "integration_id")} WHERE ${column(PRODUCT_INTEGRATIONS, "product_id")} = ${productId} AND ${column(PRODUCT_INTEGRATIONS, "deleted_at")} IS NULL AND ${column(INTEGRATIONS, "type")} = ${GOOGLE_CALENDAR_INTEGRATION_TYPE} ORDER BY ${column(INTEGRATIONS, "id")} ASC LIMIT 1`,
  );
  return row ? GoogleCalendarIntegrations.load(castRow<Integration>("Integration", row)) : null;
}

// attr_json_data_accessor :access_token, :refresh_token, :calendar_id
export const integrationDetail = (integration: GoogleCalendarIntegrationRecord, name: string) =>
  jsonDataForAttr(integration, name);
export const setIntegrationDetail = (
  integration: GoogleCalendarIntegrationRecord,
  name: string,
  value: string | null,
) => setJsonDataForAttr(integration, name, value);
