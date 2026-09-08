// packages/app/src/workers/worker.d.ts
// Allow importing *.worker.ts as modules
declare module "*?worker" {
  const W: new () => Worker;
  export default W;
}

declare module "*.worker.ts" {
  const W: new (url?: string, options?: WorkerOptions) => Worker;
  export default W;
}
