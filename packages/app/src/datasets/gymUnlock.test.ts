import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { installGymCheatcode, isGymUnlocked, setGymUnlocked } from "./gymUnlock";

const KONAMI_KEYS = [
  "ArrowUp",
  "ArrowUp",
  "ArrowDown",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowLeft",
  "ArrowRight",
  "b",
  "a",
];

function press(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key }));
}

describe("gym cheatcode unlock", () => {
  let cleanup: () => void;

  beforeEach(() => {
    setGymUnlocked(false);
    jest.spyOn(console, "info").mockImplementation(() => {});
    cleanup = installGymCheatcode();
  });

  afterEach(() => {
    cleanup();
    setGymUnlocked(false);
    jest.restoreAllMocks();
  });

  it("toggles the unlock on the full Konami sequence", () => {
    KONAMI_KEYS.forEach(press);
    expect(isGymUnlocked()).toBe(true);
    KONAMI_KEYS.forEach(press);
    expect(isGymUnlocked()).toBe(false);
  });

  it("recovers after a wrong key mid-sequence", () => {
    press("ArrowUp");
    press("x"); // breaks the sequence
    KONAMI_KEYS.forEach(press);
    expect(isGymUnlocked()).toBe(true);
  });

  it("stays locked on a partial sequence", () => {
    KONAMI_KEYS.slice(0, 9).forEach(press);
    expect(isGymUnlocked()).toBe(false);
  });

  it("ignores keys typed into inputs", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      KONAMI_KEYS.forEach((key) =>
        input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
      );
      expect(isGymUnlocked()).toBe(false);
    } finally {
      input.remove();
    }
  });

  it("persists the unlock in localStorage", () => {
    KONAMI_KEYS.forEach(press);
    expect(window.localStorage.getItem("gymDatasetsUnlocked")).toBe("1");
  });
});
