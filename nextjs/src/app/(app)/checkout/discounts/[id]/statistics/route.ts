// Checkout::DiscountsController#statistics
import { discountStatisticsResponse } from "@/server/controllers/checkout-discounts";

export const GET = async (request: Request, { params }: { params: Promise<{ id: string }> }) => discountStatisticsResponse(request, (await params).id);
export const HEAD = GET;
