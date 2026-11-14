// UrlRedirectsController#subtitle_file_vtt (served in server/controllers/url-redirects/streaming.ts; the gate in server/page-props/url-redirects/delivery.ts)
import { deliveryResponse } from "@/server/page-props/url-redirects/delivery";

export const GET = (request: Request) => deliveryResponse(request, "subtitle_file_vtt");

export const HEAD = GET;
