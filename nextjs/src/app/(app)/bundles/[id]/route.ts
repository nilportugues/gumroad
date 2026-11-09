// BundlesController#show
import { bundleShowResponse } from "@/server/controllers/product-editor-mutations";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return bundleShowResponse(request, await params);
}

export const HEAD = GET;
