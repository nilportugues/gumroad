import * as Sentry from "@sentry/node";

import { getConfig } from "./config";
import { railsEnv } from "./rails-env";

// Rails reports to Sentry only (config/initializers/sentry.rb, app/services/error_notifier.rb).

const ENABLED_ENVIRONMENTS = new Set(["production", "staging"]);
const TRACES_SAMPLE_RATE = 0.001;

// Installed Gumhead apps still post prompts and the seller's bearer token to the retired
// /v2/gumhead routes; with sendDefaultPii on, Sentry would keep both.
export function isRetiredGumheadRequest(event: Sentry.Event): boolean {
  return (event.request?.url ?? "").includes("/v2/gumhead/");
}

// A failed SupportContactMailer job carries the message and up to 6 MB of screenshots in its
// arguments; keep only their sizes.
export function redactSupportContactJob(event: Sentry.Event): void {
  if (!event.tags || !Object.hasOwn(event.tags, "job_id")) return;
  const args = event.extra?.arguments;
  if (!Array.isArray(args) || args[0] !== "SupportContactMailer" || !event.extra) return;

  event.extra.arguments = args.map((argument: unknown) => {
    if (!isRecord(argument) || !Array.isArray(argument.args)) return argument;
    return {
      ...argument,
      args: argument.args.map((kwargs: unknown) => {
        if (!isRecord(kwargs)) return kwargs;
        const message = kwargs.message === undefined || kwargs.message === null ? "" : String(kwargs.message);
        return { ...kwargs, message: [...message].length, attachments: rubyArraySize(kwargs.attachments) };
      }),
    };
  });
}

// Array(value).size: nil is empty, a Hash becomes its pairs, anything else is wrapped.
function rubyArraySize(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (Array.isArray(value)) return value.length;
  if (isRecord(value)) return Object.keys(value).length;
  return 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sentryOptions(): Sentry.NodeOptions {
  const environment = railsEnv();
  return {
    dsn: getConfig("SENTRY_DSN"),
    environment,
    enabled: ENABLED_ENVIRONMENTS.has(environment),
    sendDefaultPii: true,
    tracesSampleRate: TRACES_SAMPLE_RATE,
    // The Ruby-side excluded_exceptions name Rails classes; their Next.js equivalents (404s, bad
    // CSRF, bad requests) are handled responses here, not thrown errors.
    beforeSend(event) {
      if (isRetiredGumheadRequest(event)) return null;
      redactSupportContactJob(event);
      return event;
    },
    beforeSendTransaction(event) {
      return isRetiredGumheadRequest(event) ? null : event;
    },
  };
}

let initialized = false;

export function initErrorReporting(): void {
  if (initialized) return;
  initialized = true;
  Sentry.init(sentryOptions());
}

export type ErrorReport = {
  set severity(level: Sentry.SeverityLevel);
  addMetadata(tab: string, data: Record<string, unknown>): void;
};

/** ErrorNotifier.notify(exception_or_message, exclude_request_context:, **context) { |report| } */
export function notifyError(
  errorOrMessage: unknown,
  context: Record<string, unknown> = {},
  options: { excludeRequestContext?: boolean; configure?: (report: ErrorReport) => void } = {},
): void {
  Sentry.withScope((scope) => {
    // Request data can live in the scope's request, breadcrumbs and span; drop all of it.
    if (options.excludeRequestContext) scope.clear();
    if (Object.keys(context).length > 0) scope.setContext("extra", context);
    options.configure?.({
      set severity(level: Sentry.SeverityLevel) {
        scope.setLevel(level);
      },
      addMetadata(tab, data) {
        scope.setContext(tab, data);
      },
    });
    if (errorOrMessage instanceof Error) {
      Sentry.captureException(errorOrMessage);
    } else {
      Sentry.captureMessage(String(errorOrMessage));
    }
  });
}
