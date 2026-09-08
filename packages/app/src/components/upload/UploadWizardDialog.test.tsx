import { fireEvent, render, screen, within } from "@testing-library/react";
import UploadWizardDialog, { UploadWizardSubmit } from "./UploadWizardDialog";

const HEADERS = ["x", "y", "line", "step", "action", "reward"];

const renderDialog = (overrides: Partial<React.ComponentProps<typeof UploadWizardDialog>> = {}) => {
  const onSubmit = jest.fn();
  const onCancel = jest.fn();
  render(
    <UploadWizardDialog
      open
      fileName="test.csv"
      headers={HEADERS}
      rowCount={240}
      onCancel={onCancel}
      onSubmit={onSubmit}
      {...overrides}
    />
  );
  return { onSubmit, onCancel };
};

/** Open the MUI select labelled `label` and pick `option`. */
const pickOption = (label: string, option: string) => {
  fireEvent.mouseDown(screen.getByRole("combobox", { name: new RegExp(`^${label}`) }));
  const listbox = within(screen.getByRole("listbox"));
  fireEvent.click(listbox.getByText(option));
};

describe("UploadWizardDialog", () => {
  it("seeds column roles from header inference and submits the mapping", () => {
    const { onSubmit } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Load" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const result = onSubmit.mock.calls[0][0] as UploadWizardSubmit;
    expect(result.mapping).toEqual({
      x: "x",
      y: "y",
      trajectory: "line",
      order: "step",
      action: "action",
    });
    expect(result.datasetType).toBe("default");
  });

  it("lets the user remap roles and choose an inset type", () => {
    const { onSubmit } = renderDialog();

    pickOption("Trajectory id column", "None");
    pickOption("Inset type", "chess");
    fireEvent.click(screen.getByRole("button", { name: "Load" }));

    const result = onSubmit.mock.calls[0][0] as UploadWizardSubmit;
    expect(result.mapping.trajectory).toBeUndefined();
    expect(result.datasetType).toBe("chess");
  });

  it("seeds and submits the class label column (#305)", () => {
    const { onSubmit } = renderDialog({ headers: ["x", "y", "variety", "petal"] });

    // Seeded from inference…
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect((onSubmit.mock.calls[0][0] as UploadWizardSubmit).mapping.label).toBe("variety");

    // …and remappable like every other role.
    pickOption("Class label column", "petal");
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect((onSubmit.mock.calls[1][0] as UploadWizardSubmit).mapping.label).toBe("petal");
  });

  it("omits the label role when set to None", () => {
    const { onSubmit } = renderDialog({ headers: ["x", "y", "variety"] });
    pickOption("Class label column", "None");
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect((onSubmit.mock.calls[0][0] as UploadWizardSubmit).mapping.label).toBeUndefined();
  });

  it("disables Load until x and y are mapped to distinct columns", () => {
    renderDialog({ headers: ["foo", "bar"] });
    const load = screen.getByRole("button", { name: "Load" }) as HTMLButtonElement;
    expect(load.disabled).toBe(true);

    pickOption("X column", "foo");
    expect(load.disabled).toBe(true);
    pickOption("Y column", "foo");
    expect(load.disabled).toBe(true); // x === y
    pickOption("Y column", "bar");
    expect(load.disabled).toBe(false);
  });

  it("calls onCancel from the Cancel button", () => {
    const { onCancel, onSubmit } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
