import React from "react";

export default function HoldButton({
  holding,
  hasEntry,
  isPaying,
  pendingScore,
  onPointerDown,
  onPointerUp,
  onPointerLeave
}) {
  const disabled = isPaying || pendingScore != null;

  let label = "PAY";
  if (pendingScore != null) label = "SUBMIT PENDING";
  else if (isPaying) label = "PAYING...";
  else if (!hasEntry) label = "PAY";
  else if (hasEntry && !holding) label = "HODL";
  else if (holding) label = "DON'T LET GO";

  const sub =
    pendingScore != null
      ? "Retry submit to save your score"
      : !hasEntry
      ? "Entry required to play"
      : holding
      ? "Hold. Hold. Hold."
      : "Press and hold";

  return (
    <div style={{ marginTop: 14 }}>
      <button
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        disabled={disabled}
        style={{
          width: "100%",
          height: 150,
          borderRadius: 999,
          border: "none",
          cursor: disabled ? "not-allowed" : "pointer",
          fontSize: 22,
          fontWeight: 900,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          background:
            pendingScore != null
              ? "radial-gradient(circle at top,#0b1224,#050b18)"
              : holding
              ? "radial-gradient(circle at bottom,#14532d,#052e16)"
              : hasEntry
              ? "radial-gradient(circle at top,#22c55e,#14532d)"
              : "radial-gradient(circle at top,#16a34a,#052e16)",
          color: "#f9fafb",
          boxShadow:
            holding
              ? "0 10px 40px rgba(34,197,94,0.35)"
              : "0 14px 46px rgba(34,197,94,0.25)",
          transform: holding ? "translateY(4px)" : "translateY(0)",
          opacity: disabled ? 0.65 : 1,
          transition: "transform 0.08s ease-out, box-shadow 0.12s ease-out, opacity 0.12s"
        }}
      >
        {label}
        {!hasEntry && !isPaying && pendingScore == null ? ` (${(Number.isFinite(label) ? "" : "")}${""}${""}` : ""}
      </button>

      <div
        style={{
          marginTop: 10,
          textAlign: "center",
          color: "rgba(148,163,184,0.9)",
          fontSize: 12
        }}
      >
        {sub}
      </div>
    </div>
  );
}
