// Products::BuildsController#index
import { buildsResponse } from "@/server/controllers/product-editor-mutations";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return buildsResponse(request, { product_id: id });
}

export const HEAD = GET;
