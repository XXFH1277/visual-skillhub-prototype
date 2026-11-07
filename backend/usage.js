import { AsyncLocalStorage } from "node:async_hooks";

// Who a model call was for: set around a suite step, a proofread or a generation, and
// read wherever the call is made, so token counts land on the right product and step.
export const usageContext = new AsyncLocalStorage();
let sink = () => {};
export function setUsageSink(fn) {
  sink = typeof fn === "function" ? fn : () => {};
}
export function recordUsage(entry) {
  try {
    sink({ ...(usageContext.getStore() || {}), ...entry });
  } catch {
    // Accounting never breaks a generation.
  }
}
export const withUsage = (ctx, fn) => usageContext.run({ ...(usageContext.getStore() || {}), ...ctx }, fn);
