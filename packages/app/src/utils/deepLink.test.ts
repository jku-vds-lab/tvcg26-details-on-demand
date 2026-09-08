import { describe, expect, it } from "@jest/globals";
import { getDatasetClusterPreset, getDatasetVisualPreset } from "../config/datasetVisualPresets";
import {
  initialClusterSettings,
  initialVisualizationSettings,
  SPLIT_THRESHOLD_REFERENCE_AREA_PX,
} from "../store";
import {
  buildDeepLinkUrl,
  captureDeepLinkState,
  decodeDeepLink,
  decodeIdList,
  DEEP_LINK_CLUSTER_KEYS,
  DEFAULT_FLY_MS,
  DEEP_LINK_VIS_KEYS,
  DeepLinkState,
  encodeDeepLink,
  encodeIdList,
} from "./deepLink";

const baseCapture = {
  visualizationSettings: { ...initialVisualizationSettings },
  // A realistic capture happens post-load, i.e. with the dataset presets applied.
  clusterSettings: { ...initialClusterSettings, ...getDatasetClusterPreset({ datasetType: "rubik" }) },
  datasetType: "rubik",
  datasetPath: "data/100x2-origins_splines_stability/manifest.json",
  featureSearchQuery: "",
  selectedNodeIds: [] as number[],
  totalNodeCount: 5000,
};

describe("encodeDeepLink / decodeDeepLink round trip", () => {
  it("round-trips a state using every param type", () => {
    const state: DeepLinkState = {
      v: 1,
      datasetSlug: "rubik100",
      visSettings: {
        futureSlider: 0.55,
        colorEncoding: "line",
        annotationLabelFeature: null,
        useViewboxForClustering: true,
      },
      clusterSettings: { relationInsetBudget: 8, maxActiveClusters: 11 },
      query: "age<0.05 and line=15",
      viewbox: { minX: -3.25, maxX: 5.125, minY: -2.875, maxY: 4.9375 },
      flyMs: 3500,
      demo: true,
      spotlight: true,
    };
    expect(decodeDeepLink(encodeDeepLink(state))).toEqual(state);
  });

  it("round-trips a minimal state", () => {
    const state: DeepLinkState = { v: 1, visSettings: {}, clusterSettings: {} };
    expect(decodeDeepLink(encodeDeepLink(state))).toEqual(state);
  });

  it("round-trips an id-list selection when no query is present", () => {
    const state: DeepLinkState = {
      v: 1,
      datasetSlug: "chess",
      visSettings: { pastSlider: 0.9 },
      clusterSettings: {},
      selectionIds: [3, 23, 25, 220],
    };
    expect(decodeDeepLink(encodeDeepLink(state))).toEqual(state);
  });

  it("prefers query over selection ids when both are set", () => {
    const state: DeepLinkState = {
      v: 1,
      visSettings: {},
      clusterSettings: {},
      query: "line=15",
      selectionIds: [1, 2, 3],
    };
    const decoded = decodeDeepLink(encodeDeepLink(state));
    expect(decoded?.query).toBe("line=15");
    expect(decoded?.selectionIds).toBeUndefined();
  });

  it("accepts a leading #", () => {
    const encoded = encodeDeepLink({ v: 1, datasetSlug: "mnist", visSettings: {}, clusterSettings: {} });
    expect(decodeDeepLink(`#${encoded}`)?.datasetSlug).toBe("mnist");
  });
});

describe("decodeDeepLink robustness", () => {
  it("returns null for empty or absent payloads", () => {
    expect(decodeDeepLink("")).toBeNull();
    expect(decodeDeepLink("#")).toBeNull();
  });

  it("returns null for unknown versions", () => {
    expect(decodeDeepLink("v=2&ds=mnist")).toBeNull();
    expect(decodeDeepLink("ds=mnist")).toBeNull();
  });

  it("ignores unknown and non-whitelisted params", () => {
    const decoded = decodeDeepLink("v=1&bogus=1&s.tfidfLabels=x&c.contourThickness=99");
    expect(decoded).toEqual({ v: 1, visSettings: {}, clusterSettings: {} });
  });

  it("drops malformed numeric and boolean values", () => {
    const decoded = decodeDeepLink("v=1&s.pastSlider=abc&s.useViewboxForClustering=maybe");
    expect(decoded).toEqual({ v: 1, visSettings: {}, clusterSettings: {} });
  });

  it("drops malformed viewboxes", () => {
    expect(decodeDeepLink("v=1&vb=1,2,3")?.viewbox).toBeUndefined();
    expect(decodeDeepLink("v=1&vb=1,2,3,NaN")?.viewbox).toBeUndefined();
    expect(decodeDeepLink("v=1&vb=5,1,0,2")?.viewbox).toBeUndefined(); // minX >= maxX
  });

  it("resolves fly=1 to the default duration and keeps explicit ms values", () => {
    expect(decodeDeepLink("v=1&fly=1")?.flyMs).toBe(DEFAULT_FLY_MS);
    expect(decodeDeepLink("v=1&fly=3500")?.flyMs).toBe(3500);
  });

  it("drops malformed or non-positive fly values", () => {
    expect(decodeDeepLink("v=1&fly=abc")?.flyMs).toBeUndefined();
    expect(decodeDeepLink("v=1&fly=0")?.flyMs).toBeUndefined();
    expect(decodeDeepLink("v=1&fly=-500")?.flyMs).toBeUndefined();
    expect(decodeDeepLink("v=1&fly=")?.flyMs).toBeUndefined();
    expect(decodeDeepLink("v=1")?.flyMs).toBeUndefined();
  });

  it("accepts any non-falsy demo value and drops explicit negatives", () => {
    expect(decodeDeepLink("v=1&demo=1")?.demo).toBe(true);
    expect(decodeDeepLink("v=1&demo=true")?.demo).toBe(true);
    // Lenient: authors write demo=<ms> like fly=<ms> — treat it as enabled.
    expect(decodeDeepLink("v=1&demo=10000")?.demo).toBe(true);
    expect(decodeDeepLink("v=1&demo=0")?.demo).toBeUndefined();
    expect(decodeDeepLink("v=1&demo=false")?.demo).toBeUndefined();
    expect(decodeDeepLink("v=1&demo=")?.demo).toBeUndefined();
    expect(decodeDeepLink("v=1")?.demo).toBeUndefined();
  });

  it("decodes a custom demo phase order from a comma list", () => {
    const decoded = decodeDeepLink("v=1&demo=fly,sel,params");
    expect(decoded?.demo).toBe(true);
    expect(decoded?.demoOrder).toEqual(["fly", "sel", "params"]);
  });

  it("keeps demo=1 and legacy demo values orderless", () => {
    expect(decodeDeepLink("v=1&demo=1")?.demoOrder).toBeUndefined();
    expect(decodeDeepLink("v=1&demo=true")?.demoOrder).toBeUndefined();
    expect(decodeDeepLink("v=1&demo=10000")?.demoOrder).toBeUndefined();
  });

  it("keeps unlisted phases out of the order (they run silently)", () => {
    // The list is exactly the phases to SHOW; omitted ones still execute,
    // instantly, like the instant link.
    expect(decodeDeepLink("v=1&demo=fly")?.demoOrder).toEqual(["fly"]);
    expect(decodeDeepLink("v=1&demo=params")?.demoOrder).toEqual(["params"]);
    expect(decodeDeepLink("v=1&demo=sel,fly")?.demoOrder).toEqual(["sel", "fly"]);
  });

  it("drops unknown and duplicate tokens", () => {
    expect(decodeDeepLink("v=1&demo=bogus,fly,fly")?.demoOrder).toEqual(["fly"]);
    const allBogus = decodeDeepLink("v=1&demo=warp,9000");
    expect(allBogus?.demo).toBe(true);
    expect(allBogus?.demoOrder).toBeUndefined();
  });

  it("normalizes sel in front of params (glide needs the replayed selection)", () => {
    expect(decodeDeepLink("v=1&demo=fly,params,sel")?.demoOrder).toEqual(["fly", "sel", "params"]);
    expect(decodeDeepLink("v=1&demo=params,sel")?.demoOrder).toEqual(["sel", "params"]);
    // Normalizing can land back on the full default order — then orderless.
    expect(decodeDeepLink("v=1&demo=params,sel,fly")?.demoOrder).toBeUndefined();
  });

  it("round-trips a custom demo order and encodes the default as demo=1", () => {
    const custom: DeepLinkState = {
      v: 1,
      visSettings: {},
      clusterSettings: {},
      demo: true,
      demoOrder: ["fly", "sel", "params"],
    };
    expect(encodeDeepLink(custom)).toContain("demo=fly%2Csel%2Cparams");
    expect(decodeDeepLink(encodeDeepLink(custom))).toEqual(custom);

    const partial: DeepLinkState = {
      v: 1,
      visSettings: {},
      clusterSettings: {},
      demo: true,
      demoOrder: ["sel", "fly"],
    };
    expect(encodeDeepLink(partial)).toContain("demo=sel%2Cfly");
    expect(decodeDeepLink(encodeDeepLink(partial))).toEqual(partial);

    const plain: DeepLinkState = { v: 1, visSettings: {}, clusterSettings: {}, demo: true };
    expect(encodeDeepLink(plain)).toContain("demo=1");
    expect(decodeDeepLink(encodeDeepLink(plain))).toEqual(plain);
  });

  it("decodes spot like demo (lenient, explicit negatives dropped)", () => {
    expect(decodeDeepLink("v=1&spot=1")?.spotlight).toBe(true);
    expect(decodeDeepLink("v=1&spot=glow")?.spotlight).toBe(true);
    expect(decodeDeepLink("v=1&spot=0")?.spotlight).toBeUndefined();
    expect(decodeDeepLink("v=1")?.spotlight).toBeUndefined();
  });

  it("never throws on garbage", () => {
    const garbage = ["%%%", "v=1&s.=", "v=1&vb=", "&&&==", "v=1&sel=..", "v=1&sel=!!"];
    for (const g of garbage) expect(() => decodeDeepLink(g)).not.toThrow();
  });
});

describe("id-list codec", () => {
  it("round-trips", () => {
    const ids = [3, 23, 25, 220, 4096];
    expect(decodeIdList(encodeIdList(ids))).toEqual(ids);
  });

  it("normalizes unsorted input with duplicates", () => {
    expect(decodeIdList(encodeIdList([5, 1, 5, 3]))).toEqual([1, 3, 5]);
  });

  it("rejects malformed tokens", () => {
    expect(decodeIdList("1.z!.2")).toBeNull();
    expect(decodeIdList("")).toBeNull();
    expect(decodeIdList("1..2")).toBeNull();
  });

  it("stays compact for large contiguous selections", () => {
    const ids = Array.from({ length: 10000 }, (_, i) => i + 30000);
    const encoded = encodeIdList(ids);
    expect(encoded.length).toBeLessThan(40000);
    expect(decodeIdList(encoded)).toEqual(ids);
  });
});

describe("legacy splitThresholdPx param (pre-viewport-relative links)", () => {
  it("converts the absolute px² value to the fraction via the calibration reference", () => {
    const decoded = decodeDeepLink("v=1&c.splitThresholdPx=34500");
    expect(decoded?.clusterSettings.splitThresholdFraction).toBe(
      34500 / SPLIT_THRESHOLD_REFERENCE_AREA_PX
    );
    // The historical default converts to exactly the new default (3%).
    expect(decoded?.clusterSettings.splitThresholdFraction).toBe(
      initialClusterSettings.splitThresholdFraction
    );
    const decoded2 = decodeDeepLink("v=1&c.splitThresholdPx=57500");
    expect(decoded2?.clusterSettings.splitThresholdFraction).toBe(0.05);
  });

  it("drops malformed legacy values", () => {
    expect(
      decodeDeepLink("v=1&c.splitThresholdPx=abc")?.clusterSettings.splitThresholdFraction
    ).toBeUndefined();
    expect(
      decodeDeepLink("v=1&c.splitThresholdPx=")?.clusterSettings.splitThresholdFraction
    ).toBeUndefined();
  });

  it("lets an explicit splitThresholdFraction param win regardless of order", () => {
    expect(
      decodeDeepLink("v=1&c.splitThresholdFraction=0.01&c.splitThresholdPx=72000")
        ?.clusterSettings.splitThresholdFraction
    ).toBe(0.01);
    expect(
      decodeDeepLink("v=1&c.splitThresholdPx=72000&c.splitThresholdFraction=0.01")
        ?.clusterSettings.splitThresholdFraction
    ).toBe(0.01);
  });

  it("round-trips the new fraction key", () => {
    const state: DeepLinkState = {
      v: 1,
      visSettings: {},
      clusterSettings: { splitThresholdFraction: 0.05 },
    };
    const encoded = encodeDeepLink(state);
    expect(encoded).toContain("c.splitThresholdFraction=0.05");
    expect(decodeDeepLink(encoded)).toEqual(state);
  });
});

describe("whitelist integrity", () => {
  it("every whitelisted key exists in the initial settings objects", () => {
    for (const key of DEEP_LINK_VIS_KEYS) {
      expect(key in initialVisualizationSettings).toBe(true);
    }
    for (const key of DEEP_LINK_CLUSTER_KEYS) {
      expect(key in initialClusterSettings).toBe(true);
    }
  });
});

describe("captureDeepLinkState", () => {
  it("encodes zero settings params for a pristine post-preset state", () => {
    const preset = getDatasetVisualPreset({
      datasetType: baseCapture.datasetType,
      datasetPath: baseCapture.datasetPath,
    });
    const state = captureDeepLinkState({
      ...baseCapture,
      visualizationSettings: { ...initialVisualizationSettings, ...preset },
    });
    expect(state).not.toBeNull();
    expect(state!.datasetSlug).toBe("rubik100");
    expect(state!.visSettings).toEqual({});
    expect(state!.clusterSettings).toEqual({});
    // Capture must never emit `fly`/`demo`/`spot` — hand-authored params.
    expect(state!.flyMs).toBeUndefined();
    expect(state!.demo).toBeUndefined();
    expect(state!.demoOrder).toBeUndefined();
    expect(state!.spotlight).toBeUndefined();
    expect(encodeDeepLink(state!)).toBe("v=1&ds=rubik100");
  });

  it("encodes exactly the overridden setting", () => {
    const preset = getDatasetVisualPreset({
      datasetType: baseCapture.datasetType,
      datasetPath: baseCapture.datasetPath,
    });
    const state = captureDeepLinkState({
      ...baseCapture,
      visualizationSettings: { ...initialVisualizationSettings, ...preset, futureSlider: 0.55 },
    });
    expect(state!.visSettings).toEqual({ futureSlider: 0.55 });
  });

  it("returns null for non-catalog datasets", () => {
    expect(captureDeepLinkState({ ...baseCapture, datasetPath: "data/custom-upload.json" })).toBeNull();
  });

  it("prefers the query string over selected ids", () => {
    const state = captureDeepLinkState({
      ...baseCapture,
      featureSearchQuery: "age<0.05",
      selectedNodeIds: [1, 2, 3],
    });
    expect(state!.query).toBe("age<0.05");
    expect(state!.selectionIds).toBeUndefined();
  });

  it("treats a full-dataset selection as no selection", () => {
    const state = captureDeepLinkState({
      ...baseCapture,
      selectedNodeIds: Array.from({ length: 5000 }, (_, i) => i),
    });
    expect(state!.selectionIds).toBeUndefined();
  });

  it("keeps a partial id selection", () => {
    const state = captureDeepLinkState({ ...baseCapture, selectedNodeIds: [7, 5, 7, 9] });
    expect(state!.selectionIds).toEqual([7, 5, 7, 9]);
  });
});

describe("buildDeepLinkUrl", () => {
  it("appends the encoded state as a hash fragment", () => {
    const url = buildDeepLinkUrl(
      { v: 1, datasetSlug: "cctv", visSettings: {}, clusterSettings: {} },
      { origin: "https://example.org", pathname: "/rl_trajectories/", search: "" }
    );
    expect(url).toBe("https://example.org/rl_trajectories/#v=1&ds=cctv");
  });
});
