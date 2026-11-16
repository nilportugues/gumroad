// CustomersController#missed_posts
import { missedPostsResponse } from "@/server/controllers/customer-details";

export const GET = (request: Request, { params }: { params: Promise<{ purchase_id: string }> }) =>
  missedPostsResponse(request, params);
export const HEAD = GET;
