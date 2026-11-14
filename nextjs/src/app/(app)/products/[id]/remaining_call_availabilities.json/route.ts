// Products::RemainingCallAvailabilitiesController#index
import { remainingCallAvailabilitiesResponse } from "@/server/controllers/remaining-call-availabilities";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return remainingCallAvailabilitiesResponse(
    request,
    params.then(({ id }) => ({ product_id: id })),
  );
}

export const HEAD = GET;
