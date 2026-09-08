type DoiInvalidationListener = () => void;

const listeners = new Set<DoiInvalidationListener>();

export function subscribeToDoiStateInvalidation(listener: DoiInvalidationListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyDoiStateInvalidation(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error("DoI invalidation listener failed", error);
    }
  });
}
