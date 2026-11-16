// CustomersController#product_purchases
import { productPurchasesResponse } from "@/server/controllers/customer-details";

export const GET = (request: Request, { params }: { params: Promise<{ purchase_id: string }> }) =>
  productPurchasesResponse(request, params);
export const HEAD = GET;
