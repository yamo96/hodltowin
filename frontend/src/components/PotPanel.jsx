import React from "react";

export default function PotPanel({ potEth, targetEth, leftEth, progress, entryFeeEth, roundId }) {
  const pct = Math.round(progress * 100);
  const leftTxt = leftEth <= 0 ? "0.0000" : leftEth.toFixed(4);

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-end" }}>
        <div>
          <div style={{ fontSize: 11, color: "rgba(148,163,184,0.9)", letterSpacing: "0.18em", textTransform: "uppercase" }}>
            Current Pot
          </div>
          <div style={{ fontSize: 26, fontWeight: 900, letterSpacing: "0.06em" }}>
            <span style={{ color: "#22c55e" }}>{potEth.toFixed(4)}</span>{" "}
            <span style={{ color: "rgba(229,231,235,0.9)", fontWeight: 700 }}>ETH</span>
          </div>
        </div>

        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 11, color: "rgba(148,163,184,0.9)", letterSpacing: "0.18em", textTransform: "uppercase" }}>
            Entry
          </div>
          <div style={{ fontSize: 13, fontWeight: 800, color: "rgba(229,231,235,0.95)" }}>
            {entryFeeEth} ETH
          </div>
          <div style={{ fontSize: 11, color: "rgba(148,163,184,0.75)" }}>
            Round #{roundId}
          </div>
        </div>
      </div>

      <div style={{ border: "1px solid rgba(148,163,184,0.18)", borderRadius: 14, padding: "10px 12px", background: "rgba(2,6,23,0.35)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
          <div style={{ color: "rgba(148,163,184,0.95)" }}>
            Next payout at <b style={{ color: "#e5e7eb" }}>{targetEth.toFixed(4)} ETH</b>
          </div>
          <div style={{ color: "rgba(148,163,184,0.95)" }}>
            Left: <b style={{ color: "#22c55e" }}>{leftTxt} ETH</b>
          </div>
        </div>

        <div style={{ marginTop: 10 }}>
          <div style={{ height: 12, borderRadius: 999, background: "rgba(148,163,184,0.14)", overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${pct}%`,
                borderRadius: 999,
                background: "linear-gradient(90deg, #16a34a, #22c55e)",
                boxShadow: pct >= 80 ? "0 0 18px rgba(34,197,94,0.45)" : "none",
                transition: "width 250ms ease"
              }}
            />
          </div>
          <div style={{ marginTop: 6, fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(148,163,184,0.8)" }}>
            Progress: {pct}%
          </div>
        </div>
      </div>
    </div>
  );
}
