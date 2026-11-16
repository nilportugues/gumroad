// CustomersController#customer_charges
import { customerChargesResponse } from "@/server/controllers/customer-details";

export const GET = (request: Request, { params }: { params: Promise<{ purchase_id: string }> }) =>
  customerChargesResponse(request, params);
export const HEAD = GET;
