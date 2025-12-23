import React from "react";

export default function Leaderboard({
  leaderboard,
  yourIndex,
  formatMs,
  shorten,
  loading = false
}) {
  const top3 = leaderboard.slice(0, 3);
  const rest = leaderboard.slice(3);

  return (
    <div>
      {/* HEADER BÖLÜMÜ */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center", // Baseline yerine center daha düzgün durur
          gap: 10,
          marginBottom: 12
        }}
      >
        {/* SOL: BAŞLIK + UPDATING (Buraya koyduk ki ekranı itmesin) */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 800,
              letterSpacing: "0.12em",
              textTransform: "uppercase"
            }}
          >
            Leaderboard
          </div>

          {/* LOADING BURADA - Ortadaki boşluğa doğru açılır, kenara vurmaz */}
          {loading && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 10,
                color: "#22c55e",
                fontWeight: 600,
                background: "rgba(34,197,94,0.1)",
                padding: "2px 8px",
                borderRadius: 99,
                animation: "fadeIn 0.2s ease-out"
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "#22c55e",
                  boxShadow: "0 0 8px #22c55e"
                }}
              />
              Updating
            </div>
          )}
        </div>

        {/* SAĞ: SADECE RANK (Sabit genişlik, titreme yapmaz) */}
        <div
          style={{
            fontSize: 11,
            color: "rgba(148,163,184,0.9)",
            whiteSpace: "nowrap"
          }}
        >
          {yourIndex >= 0 ? `Your rank: #${yourIndex + 1}` : "Play to get ranked"}
        </div>
      </div>

      {/* PODIUM (İlk 3) */}
      <div style={{ display: "grid", gap: 10 }}>
        {top3.length === 0 ? (
          <div style={{ color: "rgba(148,163,184,0.8)", fontSize: 12 }}>
            No scores yet. Be the first to HODL.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
            {top3.map((row, i) => {
              const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉";
              const border =
                i === 0 ? "rgba(250,204,21,0.35)" : "rgba(148,163,184,0.22)";
              const bg =
                i === 0
                  ? "radial-gradient(circle at top, rgba(250,204,21,0.18), rgba(2,6,23,0.25) 60%)"
                  : "rgba(2,6,23,0.25)";

              return (
                <div
                  key={`${row.wallet}-${i}`}
                  style={{
                    border: `1px solid ${border}`,
                    background: bg,
                    borderRadius: 16,
                    padding: "10px 12px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    opacity: loading ? 0.7 : 1, // Loading olunca hafif soluklaşsın
                    transition: "opacity 0.2s"
                  }}
                >
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <div style={{ fontSize: 18 }}>{medal}</div>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 800 }}>
                        {shorten(row.wallet)}
                      </div>
                      <div style={{ fontSize: 11, color: "rgba(148,163,184,0.85)" }}>
                        Best HODL
                      </div>
                    </div>
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 900,
                      color: i === 0 ? "#facc15" : "#22c55e"
                    }}
                  >
                    {formatMs(row.bestScoreMs)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* REST (Diğerleri) */}
      {rest.length > 0 && (
        <div
          style={{
            marginTop: 12,
            borderTop: "1px solid rgba(148,163,184,0.14)",
            paddingTop: 10,
            opacity: loading ? 0.7 : 1,
            transition: "opacity 0.2s"
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", paddingBottom: 8, color: "rgba(148,163,184,0.85)" }}>
                  #
                </th>
                <th style={{ textAlign: "left", paddingBottom: 8, color: "rgba(148,163,184,0.85)" }}>
                  Player
                </th>
                <th style={{ textAlign: "right", paddingBottom: 8, color: "rgba(148,163,184,0.85)" }}>
                  Best
                </th>
              </tr>
            </thead>
            <tbody>
              {rest.map((row, idx) => {
                const absoluteRank = idx + 4;
                const isYou = yourIndex + 1 === absoluteRank;

                return (
                  <tr
                    key={`${row.wallet}-${absoluteRank}`}
                    style={{
                      borderTop: "1px solid rgba(148,163,184,0.10)",
                      background: isYou ? "rgba(34,197,94,0.08)" : "transparent"
                    }}
                  >
                    <td style={{ padding: "8px 0", width: 36 }}>{absoluteRank}</td>
                    <td style={{ padding: "8px 0" }}>
                      {shorten(row.wallet)}{" "}
                      {isYou ? <b style={{ color: "#22c55e" }}> (YOU)</b> : null}
                    </td>
                    <td style={{ padding: "8px 0", textAlign: "right", color: "#e5e7eb" }}>
                      {formatMs(row.bestScoreMs)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}