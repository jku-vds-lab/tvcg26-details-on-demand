/**
 * Trailing-edge throttle for high-frequency values (zoom transforms).
 *
 * `push` records the latest value and arms a timer if none is pending; when
 * it fires, the latest value is applied — so during sustained pushes the
 * consumer sees ~one update per `waitMs`, always the freshest value, and
 * never a leading-edge call. `flush` applies a pending value immediately
 * (gesture end), `cancel` drops it (unmount).
 */
export interface TrailingThrottle<T> {
  push: (value: T) => void;
  flush: () => void;
  cancel: () => void;
}

export function createTrailingThrottle<T>(
  apply: (value: T) => void,
  waitMs: number
): TrailingThrottle<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let latest: T | undefined;

  const fire = () => {
    timer = null;
    if (!pending) return;
    pending = false;
    apply(latest as T);
  };

  return {
    push(value: T) {
      latest = value;
      pending = true;
      if (timer == null) timer = setTimeout(fire, waitMs);
    },
    flush() {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending) {
        pending = false;
        apply(latest as T);
      }
    },
    cancel() {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = false;
    },
  };
}
