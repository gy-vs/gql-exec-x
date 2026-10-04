/**
 * Returns a high-resolution timestamp in milliseconds.
 *
 * Uses the runtime's built-in monotonic `performance.now()` when available
 * (browsers, modern Node.js, Deno, Bun, ...) and falls back to `Date.now()`.
 * The absolute value is arbitrary; differences between two readings are
 * elapsed milliseconds and may include a fractional component.
 */
export function now(): number {
  const perf = (globalThis as { performance?: { readonly now: () => number } })
    .performance;
  if (perf != null && typeof perf.now === 'function') {
    return perf.now();
  }
  return Date.now();
}
