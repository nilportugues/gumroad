// Next.js calls register() once per server process. @sentry/node is Node-only, so the edge
// runtime must not import it.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initErrorReporting } = await import("./server/infra/error-reporting");
    initErrorReporting();
  }
}
