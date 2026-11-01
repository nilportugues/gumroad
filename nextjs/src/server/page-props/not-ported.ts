export class NotPortedError extends Error {
  constructor(what: string) {
    super(`${what} is not ported to Next.js yet`);
  }
}
