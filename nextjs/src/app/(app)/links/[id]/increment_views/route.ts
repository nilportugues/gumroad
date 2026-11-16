// LinksController#increment_views (GET; the POST is a mutation, controllers/product-editor-json.ts)
import { incrementViewsGetResponse } from "@/server/controllers/product-editor-json";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return incrementViewsGetResponse(request, params);
}

export const HEAD = GET;
