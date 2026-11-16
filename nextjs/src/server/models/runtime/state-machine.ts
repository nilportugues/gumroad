// StateMachines::InvalidTransition (state_machines 0.6), raised by an event's bang method when the record's state has no
// transition for it. Nothing has been sent to the database by then, not even a BEGIN.
export class InvalidTransition extends Error {
  readonly rubyClass = "StateMachines::InvalidTransition";
  constructor(attribute: string, event: string, from: string | null) {
    super(
      `Cannot transition ${attribute} via :${event} from :${from ?? ""} (Reason(s): ${attribute.charAt(0).toUpperCase()}${attribute.slice(1)} cannot transition via "${event.replaceAll("_", " ")}")`,
    );
    this.name = "InvalidTransition";
  }
}
