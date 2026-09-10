import { m as f } from "./index-CfOxEoWC.js";
function m(o, s) {
  const e = s == null ? void 0 : s.signal;
  return new Promise((c, t) => {
    if (e != null && e.aborted) {
      t(new DOMException("Field distance aborted", "AbortError"));
      return;
    }
    const n = f(), d = (r) => {
      e == null || e.removeEventListener("abort", a), n.terminate(), r();
    }, a = () => d(() => t(new DOMException("Field distance aborted", "AbortError")));
    e == null || e.addEventListener("abort", a), n.onmessage = (r) => {
      const i = r.data;
      i.ok ? d(() => c(i.recordDist)) : d(() => t(new Error(i.error || "Field distance worker failed")));
    }, n.onerror = (r) => d(() => t(r)), n.postMessage(o, [o.x.buffer, o.y.buffer, o.seedIdx.buffer]);
  });
}
export {
  m as computeRecordDistancesInWorker
};
