// Products::VariantsController#index (`/links/:link_id/variants`)
import { variantsResponse } from "@/server/controllers/product-editor-json";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return variantsResponse(
    request,
    params.then(({ id }) => ({ link_id: id })),
  );
}

export const HEAD = GET;
