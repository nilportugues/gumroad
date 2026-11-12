// HelpCenter::ContactsController#create (POST /help/contact, app/controllers/help_center/contacts_controller.rb): the Help Center
// form. A honeypot hit answers success and drops the message; a valid submission enqueues SupportContactMailer.contact_form.
//
// Handed to Rails whole, before anything is enqueued: a multipart body (the screenshots; the body parser hands those back), and a
// field that is not text or an address with characters outside printable ASCII, where Ruby's and JavaScript's whitespace and
// character classes differ.
import { railsLoggedInUser } from "../auth/resolve.ts";
import { deliverLater, keywordArgs } from "../mail/active-job.ts";
import { mailRoute } from "../mail/delivery.ts";
import { currentJobsRuntime } from "../models/concerns/job-runtime.ts";

import { HandBackToRails, type ActionResult } from "./application-controller.ts";
import { emailFormatValid } from "./internal-admin/email-format.ts";
import { json } from "./json-actions.ts";
import { registerMutations, type MutationInput } from "./mutation.ts";

const CATEGORIES = ["account", "payouts", "purchases & refunds", "technical issue", "other"];
const MIN_MESSAGE_LENGTH = 10;
const MAX_MESSAGE_LENGTH = 10_000;
const MAILER = "SupportContactMailer";
const METHOD = "contact_form";
const DELIVERY_JOB = "SupportContactMailDeliveryJob";
const PRINTABLE_ASCII = /^[ -~]*$/u;

// Ruby's String#strip
const rubyStrip = (value: string) => value.replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/gu, "");

// `params[:website].present?`
function present(value: unknown): boolean {
  if (typeof value === "string") return !/^\p{White_Space}*$/u.test(value);
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
  return value !== null && value !== undefined && value !== false;
}

// `params[name].to_s` for a parameter that is text or missing.
function text(input: MutationInput, name: string): string {
  const value = input.params[name];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new HandBackToRails(`${name} that is not text`);
  return value;
}

function validationError(email: string, category: string, message: string): string | null {
  if (!emailFormatValid(email)) return "Please enter a valid email address.";
  if (!CATEGORIES.includes(category)) return "Please select a category.";
  const length = [...message].length;
  if (length < MIN_MESSAGE_LENGTH)
    return `Please tell us a bit more so we can help (at least ${MIN_MESSAGE_LENGTH} characters).`;
  if (length > MAX_MESSAGE_LENGTH)
    return "Your message is too long. Please shorten it or email support@gumroad.com directly.";
  return null;
}

async function create(input: MutationInput): Promise<ActionResult> {
  // Honeypot: the invisible "website" field humans never fill in.
  if (present(input.params.website)) return json({ success: true });

  const email = rubyStrip(text(input, "email"));
  const category = text(input, "category");
  const message = rubyStrip(text(input, "message"));
  const referrer = text(input, "referrer_path");
  if (!PRINTABLE_ASCII.test(email)) throw new HandBackToRails("an email with characters outside printable ASCII");

  const error = validationError(email, category, message);
  if (error !== null) return json({ success: false, error }, 422);

  const user = railsLoggedInUser(input.context);
  await deliverLater(
    currentJobsRuntime(),
    {
      mailer: MAILER,
      method: METHOD,
      args: [
        keywordArgs({
          email,
          category,
          message,
          user_id: user === null ? null : Number(user.id),
          // Only a same-app path, never an arbitrary URL.
          referrer_path: referrer.startsWith("/") && !referrer.startsWith("//") ? referrer : null,
          attachments: [],
        }),
      ],
      jobClass: DELIVERY_JOB,
    },
    mailRoute(MAILER, METHOD),
  );
  return json({ success: true });
}

registerMutations({ method: "POST", pattern: "/help/contact", formats: ["any"], run: create });
