// Purchases::DisputeEvidenceController#success (props in server/page-props/dispute-evidence/pages.ts)
import { renderPage } from "@/server/page-props/render-page";

import { InertiaShell } from "../../../../_shell/InertiaShell";
import DisputeEvidenceSuccess from "./DisputeEvidenceSuccess";

export default async function Page({ params }: { params: Promise<{ purchase_id: string }> }) {
  const { purchase_id } = await params;
  const purchase_idDecoded = decodeURIComponent(purchase_id);
  const page = await renderPage("/purchases/:purchase_id/dispute_evidence/success", { purchase_id: purchase_idDecoded });

  return (
    <InertiaShell page={page} layout="public">
      <DisputeEvidenceSuccess />
    </InertiaShell>
  );
}
