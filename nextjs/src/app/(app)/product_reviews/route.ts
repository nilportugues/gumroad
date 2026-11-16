// ProductReviewsController#index
import { productReviewsIndexResponse } from "@/server/controllers/product-reviews";

export async function GET(request: Request) {
  return productReviewsIndexResponse(request);
}

export const HEAD = GET;
