// ProductDuplicatesController#show (the POST is a mutation, controllers/product-editor-mutations.ts)
import { productDuplicateShowResponse } from "@/server/controllers/product-editor-mutations";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return productDuplicateShowResponse(request, await params);
}

export const HEAD = GET;
