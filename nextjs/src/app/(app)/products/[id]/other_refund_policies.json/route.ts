// Products::OtherRefundPoliciesController#index
import { otherRefundPoliciesResponse } from "@/server/controllers/product-editor-json";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return otherRefundPoliciesResponse(
    request,
    params.then(({ id }) => ({ product_id: id })),
  );
}

export const HEAD = GET;
