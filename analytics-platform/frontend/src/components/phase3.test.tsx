import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_DRAFT, serializeSignature, type SignatureDraft } from "@/lib/onnxSignature";
import { MentionTextarea } from "./dashboard/MentionTextarea";
import { OnnxSignatureEditor } from "./models/UploadModelDialog";

function EditorHarness({ onDraft }: { onDraft: (d: SignatureDraft) => void }) {
  const [draft, setDraft] = useState<SignatureDraft>(DEFAULT_DRAFT);
  const ser = serializeSignature(draft);
  return (
    <OnnxSignatureEditor
      draft={draft}
      featureErrors={ser.featureErrors}
      onChange={(d) => {
        setDraft(d);
        onDraft(d);
      }}
    />
  );
}

describe("ONNX signature editor", () => {
  it("edits features and serializes them", () => {
    let last: SignatureDraft = DEFAULT_DRAFT;
    render(<EditorHarness onDraft={(d) => (last = d)} />);
    fireEvent.change(screen.getByLabelText("…or paste a CSV header"), { target: { value: "age, plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Use header" }));
    fireEvent.change(screen.getByLabelText("Feature 2 type"), { target: { value: "string" } });
    fireEvent.change(screen.getByLabelText("Feature 2 categories"), { target: { value: "basic, pro" } });
    fireEvent.change(screen.getByLabelText("Feature 1 minimum"), { target: { value: "18" } });
    const sig = serializeSignature(last).signature;
    expect(sig?.features).toEqual([
      { name: "age", type: "number", min: 18 },
      { name: "plan", type: "string", categories: ["basic", "pro"] },
    ]);
    expect(sig?.classes).toEqual([0, 1]);
  });

  it("shows per-row validation errors", () => {
    render(<EditorHarness onDraft={() => undefined} />);
    fireEvent.change(screen.getByLabelText("…or paste a CSV header"), { target: { value: "x, x" } });
    fireEvent.click(screen.getByRole("button", { name: "Use header" }));
    expect(screen.getByText("Duplicate feature name")).toBeInTheDocument();
  });
});

function MentionHarness() {
  const [v, setV] = useState("");
  return (
    <>
      <MentionTextarea label="Comment" value={v} onChange={setV} users={[{ id: "usr_ada", label: "Ada Lovelace", sub: "ada@x.io" }, { id: "usr_bob", label: "Bob" }]} />
      <output data-testid="value">{v}</output>
    </>
  );
}

describe("mention autocomplete", () => {
  it("suggests users after @ and inserts the id", () => {
    render(<MentionHarness />);
    const box = screen.getByRole("combobox", { name: "Comment" }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "hi @ad", selectionStart: 6 } });
    box.setSelectionRange(6, 6);
    fireEvent.click(box);
    const list = screen.getByRole("listbox");
    expect(list).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByTestId("value").textContent).toBe("hi @usr_ada ");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
