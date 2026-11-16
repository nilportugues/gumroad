// CustomersController#customer_emails
import { customerEmailsResponse } from "@/server/controllers/customer-details";

export const GET = (request: Request, { params }: { params: Promise<{ purchase_id: string }> }) =>
  customerEmailsResponse(request, params);
export const HEAD = GET;
