// `any[]` in the constraint position is the idiomatic accept-any-signature
// bound; `unknown[]` would reject concrete functions (param contravariance).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ThrottledFn<T extends (...args: any[]) => void> = ((...args: Parameters<T>) => void) & {
  cancel: () => void;
};

/**
 * Throttle helper:
 * - calls immediately on first invocation
 * - then at most once per limitMs
 * - guarantees a trailing call with the latest arguments
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see ThrottledFn
export function throttle<T extends (...args: any[]) => void>(func: T, limitMs: number): ThrottledFn<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastRan: number | null = null;
  let lastArgs: Parameters<T> | null = null;
  let lastThis: unknown = null;

  const throttled = function (this: unknown, ...args: Parameters<T>) {
    lastArgs = args;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the trailing call must re-apply the caller's `this`
    lastThis = this;

    const now = Date.now();

    if (lastRan === null) {
      func.apply(lastThis, lastArgs);
      lastRan = now;
      lastArgs = null;
      lastThis = null;
      return;
    }

    const elapsed = now - lastRan;
    const remaining = Math.max(limitMs - elapsed, 0);

    if (remaining === 0) {
      func.apply(lastThis, lastArgs);
      lastRan = Date.now();
      lastArgs = null;
      lastThis = null;
      return;
    }

    if (timeoutId) clearTimeout(timeoutId);

    timeoutId = setTimeout(() => {
      timeoutId = null;
      if (!lastArgs) return;

      func.apply(lastThis, lastArgs);
      lastRan = Date.now();
      lastArgs = null;
      lastThis = null;
    }, remaining);
  } as ThrottledFn<T>;

  throttled.cancel = () => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = null;
    lastArgs = null;
    lastThis = null;
  };

  return throttled;
}
