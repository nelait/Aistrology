import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { initialFormState, serializeStep, type StepFormState } from "@/lib/pipelineSteps";
import type { PipelineStep, StepOp } from "@/lib/types";
import { StepForm } from "./StepForm";

function Harness({ op, onStep }: { op: StepOp; onStep: (s: PipelineStep) => void }) {
  const [values, setValues] = useState<StepFormState>(() => initialFormState(op));
  return (
    <>
      <StepForm op={op} values={values} onChange={setValues} columns={["price", "qty", "name"]} />
      <button type="button" onClick={() => onStep(serializeStep(op, values))}>
        serialize
      </button>
    </>
  );
}

describe("StepForm", () => {
  it("fills a cast step through the form and serializes it", async () => {
    const user = userEvent.setup();
    let step: PipelineStep | null = null;
    render(<Harness op="cast" onStep={(s) => (step = s)} />);
    await user.selectOptions(screen.getByLabelText("Column *"), "price");
    await user.selectOptions(screen.getByLabelText("To type *"), "date");
    await user.type(screen.getByLabelText("Date format"), "%d/%m/%Y");
    await user.selectOptions(screen.getByLabelText("On failure"), "drop_row");
    await user.click(screen.getByRole("button", { name: "serialize" }));
    expect(step).toEqual({ op: "cast", column: "price", to: "date", format: "%d/%m/%Y", on_error: "drop_row" });
  });

  it("shows conditional fields only when relevant", async () => {
    const user = userEvent.setup();
    let step: PipelineStep | null = null;
    render(<Harness op="fill_missing" onStep={(s) => (step = s)} />);
    expect(screen.queryByLabelText("Constant value *")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Strategy *"), "constant");
    await user.type(screen.getByLabelText("Constant value *"), "42");
    await user.click(screen.getByLabelText("qty"));
    await user.click(screen.getByRole("button", { name: "serialize" }));
    expect(step).toEqual({ op: "fill_missing", columns: ["qty"], strategy: "constant", value: 42 });
  });
});
