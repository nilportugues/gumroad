// UrlRedirectsController#read: the access gate only (server/page-props/url-redirects/delivery.ts); a request past it goes to Rails.
import { deliveryResponse } from "@/server/page-props/url-redirects/delivery";

export const GET = (request: Request) => deliveryResponse(request, "read");

export const HEAD = GET;
