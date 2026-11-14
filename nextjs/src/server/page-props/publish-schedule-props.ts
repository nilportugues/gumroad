// PublishSchedulePresenter.editor_props: the two keys the product and bundle editors carry. A draft with a schedule row (pending, claimed,
// failed or published) goes to Rails, since the label and failure message of a row are not read here.
import { Prisma } from "@prisma/client";

import { HandBackToRails } from "../controllers/application-controller.ts";
import { isFeatureEnabled, userActor } from "../infra/flipper.ts";
import { column, selectRows, table } from "../models/sql.ts";

const FEATURE_FLAG = "scheduled_product_publishing";

// Called with the other hand-back checks, before anything renders (a throw from inside the props is a 500).
export async function assertNoPublishSchedule(product: { id: bigint | number; draft: boolean | null }): Promise<void> {
  if (!product.draft) return;
  const [row] = await selectRows<{ found: number | bigint }>(
    Prisma.sql`SELECT EXISTS (SELECT 1 FROM ${table("product_publish_schedules")} WHERE ${column("product_publish_schedules", "product_id")} = ${product.id}) AS found`,
  );
  if (Number(row?.found ?? 0) > 0) throw new HandBackToRails("a draft with a publish schedule");
}

export async function publishScheduleEditorProps(
  product: { draft: boolean | null; first_published_at?: Date | null },
  sellerId: bigint | number,
): Promise<{ publish_schedule: null; can_create_publish_schedule: boolean }> {
  return {
    publish_schedule: null,
    can_create_publish_schedule:
      Boolean(product.draft) &&
      product.first_published_at == null &&
      (await isFeatureEnabled(FEATURE_FLAG, userActor(sellerId))),
  };
}
