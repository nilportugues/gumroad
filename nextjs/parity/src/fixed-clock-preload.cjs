// Preloaded into the server a replay boots (NODE_OPTIONS=--require): moves its clock by PARITY_CLOCK_OFFSET_MS so
// it reads the instant a fixture was recorded at (the Rails spec froze time there). The clock keeps running.
// Whole milliseconds: the test computes the offset from performance.timeOrigin, which is fractional, and a fractional Date.now() breaks BigInt(Date.now()).
const offset = Math.round(Number(process.env.PARITY_CLOCK_OFFSET_MS ?? 0));

if (offset !== 0) {
  const RealDate = Date;
  // A Proxy keeps every static (Date.UTC, Date.parse) and the prototype the real Date has.
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      if (args.length === 0) return new target(RealDate.now() + offset);
      return Reflect.construct(target, args, newTarget === receiver ? target : newTarget);
    },
    get(target, property, receiver) {
      if (property === "now") return () => RealDate.now() + offset;
      return Reflect.get(target, property, receiver);
    },
  });
}

const receiver = globalThis.Date;
