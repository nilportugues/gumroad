// InstagramCallbacksController#data_deletion_status
import { processAction } from "@/server/controllers/application-controller";
import { instagramDataDeletionStatus } from "@/server/controllers/social-callbacks";

export const GET = (request: Request, { params }: { params: Promise<{ confirmation_code: string }> }) =>
  params.then(({ confirmation_code }) => processAction(request, {}, async () => instagramDataDeletionStatus(confirmation_code)));
export const HEAD = GET;
