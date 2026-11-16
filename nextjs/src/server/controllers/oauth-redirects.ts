// The GET actions of Oauth::ApplicationsController (#index, #new, #show) and Oauth::AuthorizedApplicationsController#index, which only redirect.
import * as Routes from "@/lib/navigation/routes";

import { railsSegment } from "./mutation.ts";
import { processAction } from "./application-controller.ts";

const redirectTo = (location: () => string) => (request: Request) => processAction(request, {}, async () => ({ status: 302, location: location() }));

export const applicationsIndex = redirectTo(() => Routes.settings_advanced_path());
export const authorizedApplicationsIndex = redirectTo(() => Routes.settings_authorized_applications_path());

export const applicationShow = (request: Request, { params }: { params: Promise<{ id: string }> }) =>
  params.then(({ id }) => processAction(request, {}, async () => ({ status: 302, location: `/oauth/applications/${railsSegment(id)}/edit` })));
