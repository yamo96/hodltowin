import React from "react";

export default function RulesModal({ open, onClose, entryFeeEth, targetEth }) {
  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "grid",
        placeItems: "center",
        padding: 16,
        zIndex: 50
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(520px, 100%)",
          borderRadius: 18,
          border: "1px solid rgba(148,163,184,0.25)",
          background: "radial-gradient(circle at top,#071024,#050b18 60%,#000 120%)",
          padding: 16,
          color: "#e5e7eb"
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 900, letterSpacing: "0.14em", textTransform: "uppercase" }}>
            Rules
          </div>
          <button
            onClick={onClose}
            style={{
              border: "1px solid rgba(148,163,184,0.25)",
              background: "transparent",
              color: "#e5e7eb",
              borderRadius: 12,
              padding: "6px 10px",
              cursor: "pointer"
            }}
          >
            Close
          </button>
        </div>

        <ul style={{ marginTop: 12, marginBottom: 0, color: "rgba(229,231,235,0.92)", lineHeight: 1.6 }}>
          <li>Entry per attempt: <b style={{ color: "#22c55e" }}>{entryFeeEth} ETH</b></li>
          <li>Pay first, then hold the button.</li>
          <li>Longest HODL time ranks higher.</li>
          <li>Payout triggers when pot reaches <b style={{ color: "#22c55e" }}>{targetEth.toFixed(4)} ETH</b>.</li>
          <li>No refunds. On-chain entry. MVP uses off-chain scoring.</li>
        </ul>
      </div>
    </div>
  );
}
