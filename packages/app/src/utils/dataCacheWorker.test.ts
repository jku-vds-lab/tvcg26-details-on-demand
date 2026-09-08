// Data-cache service worker registration gate. Pinned: deployed hosts
// register, localhost dev/preview never does unless the sw=1 deep-link flag
// opts in, and a missing serviceWorker API disables everything.

import { describe, expect, it } from "@jest/globals";
import { shouldRegisterDataCacheWorker } from "./dataCacheWorker";

describe("shouldRegisterDataCacheWorker", () => {
  it("registers on deployed hosts", () => {
    expect(
      shouldRegisterDataCacheWorker("jku-vds-lab.github.io", "#v=1&ds=chess", true)
    ).toBe(true);
  });

  it("never registers on localhost dev/preview by default", () => {
    expect(shouldRegisterDataCacheWorker("localhost", "#v=1&ds=chess", true)).toBe(false);
    expect(shouldRegisterDataCacheWorker("127.0.0.1", "", true)).toBe(false);
  });

  it("sw=1 in the deep link opts localhost in (verification runs)", () => {
    expect(shouldRegisterDataCacheWorker("localhost", "#v=1&ds=chess&sw=1", true)).toBe(true);
    expect(shouldRegisterDataCacheWorker("localhost", "#sw=1", true)).toBe(true);
    // A value that merely contains sw=1 as a substring of another key stays off.
    expect(shouldRegisterDataCacheWorker("localhost", "#answ=1", true)).toBe(false);
  });

  it("a missing serviceWorker API disables registration everywhere", () => {
    expect(shouldRegisterDataCacheWorker("jku-vds-lab.github.io", "", false)).toBe(false);
  });
});
