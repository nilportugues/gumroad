// ProductReviewsController#show
import { productReviewResponse } from "@/server/controllers/product-reviews";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return productReviewResponse(request, await params);
}

export const HEAD = GET;
