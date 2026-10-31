// Job classes whose body now runs on the Node worker. Adding a class here moves every enqueue
// from Node to BullMQ, and — once the Rails bridge middleware is installed — every enqueue from
// Ruby too. Run `npm run jobs:generate` after editing; the worker refuses to start if a class in
// this list has no handler in src/worker/jobs.
export const PORTED_JOBS: readonly string[] = ["LogResendEventJob"];
