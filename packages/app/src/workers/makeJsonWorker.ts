// packages/app/src/workers/makeJsonWorker.ts
// Thin re-export so existing import sites and jest mocks keep their module
// path; the web/widget implementation split lives in workerFactories(.widget).
export { makeJsonWorker } from "./workerFactories";
