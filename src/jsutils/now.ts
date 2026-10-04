declare const performance: { now: () => number } | undefined;

/**
 * Returns the current timestamp in milliseconds, using the runtime's built-in
 * high-resolution time source when available (providing fractional
 * milliseconds) and falling back to `Date.now()` otherwise.
 *
 * Only differences between two returned values are meaningful.
 */
/* c8 ignore next 3 */
export const now: () => number =
  typeof performance !== 'undefined'
    ? () => performance.now()
    : () => Date.now();
