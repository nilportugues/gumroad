// Port of ActiveModel::Errors and ActiveModel::Error (activemodel 8.1), with the default
// messages from activemodel/activerecord locale/en.yml. config/locales has no
// activerecord.attributes or errors.models overrides, so these are the messages users see.

const MESSAGES = {
  inclusion: "is not included in the list",
  exclusion: "is reserved",
  invalid: "is invalid",
  accepted: "must be accepted",
  empty: "can't be empty",
  blank: "can't be blank",
  present: "must be blank",
  not_a_number: "is not a number",
  not_an_integer: "must be an integer",
  greater_than: "must be greater than %{count}",
  greater_than_or_equal_to: "must be greater than or equal to %{count}",
  equal_to: "must be equal to %{count}",
  less_than: "must be less than %{count}",
  less_than_or_equal_to: "must be less than or equal to %{count}",
  other_than: "must be other than %{count}",
  required: "must exist",
  taken: "has already been taken",
} as const;

const PLURAL_MESSAGES = {
  too_long: ["is too long (maximum is 1 character)", "is too long (maximum is %{count} characters)"],
  too_short: ["is too short (minimum is 1 character)", "is too short (minimum is %{count} characters)"],
  wrong_length: ["is the wrong length (should be 1 character)", "is the wrong length (should be %{count} characters)"],
} as const;

export type ErrorType = keyof typeof MESSAGES | keyof typeof PLURAL_MESSAGES;

export type ErrorDetail = { attribute: string; type: ErrorType | null; message: string; options: Record<string, unknown> };

function interpolate(template: string, options: Record<string, unknown>): string {
  return template.replace(/%\{(\w+)\}/gu, (_, key: string) => String(options[key] ?? ""));
}

export function messageFor(type: ErrorType, options: Record<string, unknown> = {}): string {
  if (type in PLURAL_MESSAGES) {
    const [one, other] = PLURAL_MESSAGES[type as keyof typeof PLURAL_MESSAGES];
    return interpolate(options.count === 1 ? one : other, options);
  }
  return interpolate(MESSAGES[type as keyof typeof MESSAGES], options);
}

// ActiveSupport's String#humanize as used by human_attribute_name: drops a trailing `_id`,
// turns underscores into spaces and capitalises the first letter only.
export function humanAttributeName(attribute: string): string {
  const last = attribute.split(".").at(-1)!;
  const words = last.replace(/_id$/u, "").replaceAll("_", " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export class Errors {
  readonly details: ErrorDetail[] = [];
  // A model's `self.human_attribute_name` override (RichContent: description is "Content").
  readonly humanNames: Record<string, string> = {};

  // `errors.add(:attr, :blank)` or `errors.add(:attr, "custom message")`.
  add(attribute: string, typeOrMessage: ErrorType | string = "invalid", options: Record<string, unknown> = {}): void {
    const known = typeOrMessage in MESSAGES || typeOrMessage in PLURAL_MESSAGES;
    const explicit = typeof options.message === "string" ? options.message : null;
    const message = explicit ?? (known ? messageFor(typeOrMessage as ErrorType, options) : typeOrMessage);
    this.details.push({ attribute, type: known ? (typeOrMessage as ErrorType) : null, message, options });
  }

  get size(): number {
    return this.details.length;
  }

  isEmpty(): boolean {
    return this.details.length === 0;
  }

  on(attribute: string): string[] {
    return this.details.filter((d) => d.attribute === attribute).map((d) => d.message);
  }

  added(attribute: string, type: ErrorType): boolean {
    return this.details.some((d) => d.attribute === attribute && d.type === type);
  }

  fullMessages(): string[] {
    return this.details.map((d) => (d.attribute === "base" ? d.message : `${this.humanNames[d.attribute] ?? humanAttributeName(d.attribute)} ${d.message}`));
  }

  clear(): void {
    this.details.length = 0;
  }
}

// ActiveRecord::RecordInvalid, raised by save!/create!.
export class RecordInvalid extends Error {
  // A plain field, not a parameter property: the worker runs under Node's type stripping.
  readonly errors: Errors;

  constructor(errors: Errors) {
    super(`Validation failed: ${errors.fullMessages().join(", ")}`);
    this.errors = errors;
    this.name = "RecordInvalid";
  }
}

// ActiveRecord::RecordNotSaved, raised by save! when a before_* callback aborts.
export class RecordNotSaved extends Error {
  constructor(message = "Failed to save the record") {
    super(message);
    this.name = "RecordNotSaved";
  }
}

// ActiveRecord::RecordNotDestroyed, raised by destroy! when a before_destroy callback aborts.
export class RecordNotDestroyed extends Error {
  constructor(message = "Failed to destroy the record") {
    super(message);
    this.name = "RecordNotDestroyed";
  }
}

// ActiveRecord::RecordNotFound.
export class RecordNotFound extends Error {
  readonly rubyClass = "ActiveRecord::RecordNotFound";

  constructor(message: string) {
    super(message);
    this.name = "RecordNotFound";
  }
}

// `throw :abort` inside a before_* callback.
export class AbortChain extends Error {
  constructor() {
    super("callback chain aborted");
    this.name = "AbortChain";
  }
}

export function abort(): never {
  throw new AbortChain();
}
