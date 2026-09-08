import { classifyDroppedFile } from "./uploadFileRouting";

describe("classifyDroppedFile", () => {
  it("routes by extension, case-insensitively", () => {
    expect(classifyDroppedFile("trajectories.csv")).toBe("csv");
    expect(classifyDroppedFile("Trajectories.CSV")).toBe("csv");
    expect(classifyDroppedFile("dataset.json")).toBe("json");
    expect(classifyDroppedFile("dataset.json.gz")).toBe("json-gz");
    expect(classifyDroppedFile("dataset.JSON.GZ")).toBe("json-gz");
  });

  it("rejects everything else", () => {
    expect(classifyDroppedFile("archive.zip")).toBe("unsupported");
    expect(classifyDroppedFile("notes.txt")).toBe("unsupported");
    expect(classifyDroppedFile("data.gz")).toBe("unsupported");
    expect(classifyDroppedFile("csv")).toBe("unsupported");
  });
});
