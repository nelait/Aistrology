// A small badge that tells the reader whether a prediction is GENERAL (derived
// from the fixed natal chart, true throughout life) or TIME-SENSITIVE (depends
// on the current dasha / transits and changes over time).

export type Scope = "general" | "timing";

export function ScopeBadge({ scope }: { scope: Scope }) {
  if (scope === "general") {
    return (
      <span
        className="scope-badge general"
        title="General reading — based on your fixed natal chart, so it applies throughout life."
      >
        ● General · natal
      </span>
    );
  }
  return (
    <span
      className="scope-badge timing"
      title="Time-sensitive — based on the period active now (dasha / transits); it changes over time."
    >
      ◑ Current period
    </span>
  );
}
