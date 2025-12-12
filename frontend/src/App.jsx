import React, { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";

// ------------------ CONFIG ------------------

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";

// ⚠️ senin kontrat
const CONTRACT_ADDRESS = "0xeA2614aaaC15BBCC525836a5EEF7A17345cEfa74";

const ENTRY_FEE_ETH = Number(import.meta.env.VITE_ENTRY_FEE_ETH || "0.0003");
const RPC_URL = import.meta.env.VITE_BASE_RPC_URL || "";

// Base Sepolia chainId = 84532 (0x14a34)
const BASE_SEPOLIA_CHAIN_ID_HEX = "0x14a34";

// On-chain read için ABI (pot & round)
const READ_ABI = [
  "function getCurrentRoundInfo() view returns (uint256 id, uint256 pot, uint256 start, uint256 end, bool finalized)"
];

// joinCurrentRound için minimal ABI
const WRITE_ABI = ["function joinCurrentRound() external payable"];

// ------------------ HELPERS ------------------

function formatMs(ms) {
  if (!ms || ms <= 0) return "00:00.00";
  const totalSec = Math.floor(ms / 1000);
  const centis = Math.floor((ms % 1000) / 10);
  const s = String(totalSec).padStart(2, "0");
  const c = String(centis).padStart(2, "0");
  return `${s}:${c}`;
}

function shorten(addr) {
  if (!addr) return "";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function entryKey(addr, roundId) {
  return `hodl:hasEntry:${(addr || "").toLowerCase()}:${roundId}`;
}

function pendingTxKey(addr, roundId) {
  return `hodl:entryTx:${(addr || "").toLowerCase()}:${roundId}`;
}

// tx hash yokken bile sebebi gösterelim:
function parseWalletError(e) {
  const code = e?.code || e?.error?.code;
  const msg =
    e?.shortMessage ||
    e?.reason ||
    e?.message ||
    e?.error?.message ||
    "Unknown error";

  if (code === 4001) return "You rejected the transaction.";
  if (String(msg).toLowerCase().includes("insufficient funds"))
    return "Insufficient funds for gas.";
  if (String(msg).toLowerCase().includes("user rejected"))
    return "You rejected the transaction.";
  if (String(msg).toLowerCase().includes("gas") && String(msg).toLowerCase().includes("estimate"))
    return "Gas estimation failed (wrong network / contract reverted).";
  if (String(msg).toLowerCase().includes("wrong network"))
    return "Wrong network selected.";
  return msg;
}

async function ensureBaseSepolia() {
  if (!window.ethereum) return { ok: false, reason: "No wallet" };
  const chainId = await window.ethereum.request({ method: "eth_chainId" });
  if (chainId === BASE_SEPOLIA_CHAIN_ID_HEX) return { ok: true };

  // otomatik switch dene
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_SEPOLIA_CHAIN_ID_HEX }]
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "Please switch MetaMask to Base Sepolia." };
  }
}

// ------------------ APP ------------------

const App = () => {
  const [account, setAccount] = useState(null);

  const [roundId, setRoundId] = useState(1);
  const [potEth, setPotEth] = useState("0.0000");
  const [leaderboard, setLeaderboard] = useState([]);

  const [status, setStatus] = useState("");
  const [bestScoreMs, setBestScoreMs] = useState(null);

  const [holding, setHolding] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  const [hasEntry, setHasEntry] = useState(false);
  const [isPaying, setIsPaying] = useState(false);

  const [pendingScore, setPendingScore] = useState(null);

  const holdStartRef = useRef(null);
  const intervalRef = useRef(null);

  // ------------- WALLET -------------

  const connectWallet = async () => {
    try {
      if (!window.ethereum) {
        alert("Please install MetaMask.");
        return;
      }

      // network kontrol (tx fail yüzdesini düşürür)
      const net = await ensureBaseSepolia();
      if (!net.ok) {
        setStatus(net.reason);
        return;
      }

      const accounts = await window.ethereum.request({
        method: "eth_requestAccounts"
      });
      if (accounts && accounts.length > 0) {
        setAccount(accounts[0]);
      }
    } catch (e) {
      console.error("connectWallet error", e);
      setStatus(parseWalletError(e));
    }
  };

  // accounts changed
  useEffect(() => {
    if (!window.ethereum) return;

    const onAccounts = (accs) => setAccount(accs?.[0] || null);
    window.ethereum.on?.("accountsChanged", onAccounts);

    return () => {
      window.ethereum.removeListener?.("accountsChanged", onAccounts);
    };
  }, []);

  // ------------- POT (ON-CHAIN READ) -------------

  const fetchPot = async () => {
    try {
      if (!RPC_URL || !CONTRACT_ADDRESS) return;
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const contract = new ethers.Contract(CONTRACT_ADDRESS, READ_ABI, provider);
      const [id, pot] = await contract.getCurrentRoundInfo();
      setRoundId(Number(id));
      setPotEth(ethers.formatEther(pot));
    } catch (e) {
      console.error("fetchPot error", e);
    }
  };

  // ------------- LEADERBOARD (BACKEND) -------------

  const fetchLeaderboard = async (rId) => {
    try {
      const useRound = Number(rId || roundId);
      const res = await fetch(`${BACKEND_URL}/api/leaderboard?roundId=${useRound}`);
      if (!res.ok) return;
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.leaderboard || [];
      setLeaderboard(list);
    } catch (e) {
      console.error("leaderboard error", e);
    }
  };

  useEffect(() => {
    fetchPot();
    fetchLeaderboard();

    const potInt = setInterval(fetchPot, 15000);
    const lbInt = setInterval(() => fetchLeaderboard(), 15000);

    return () => {
      clearInterval(potInt);
      clearInterval(lbInt);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // localStorage hasEntry restore
  useEffect(() => {
    if (!account) {
      setHasEntry(false);
      return;
    }
    setHasEntry(localStorage.getItem(entryKey(account, roundId)) === "1");
  }, [account, roundId]);

  // ------------- ENTRY TX -------------

  const sendEntryTx = async () => {
    try {
      if (!window.ethereum) {
        alert("Please install MetaMask.");
        return false;
      }

      // yanlış network = tx fail’in en büyük sebebi
      const net = await ensureBaseSepolia();
      if (!net.ok) {
        setStatus(net.reason);
        return false;
      }

      setIsPaying(true);
      setStatus("Sending entry transaction...");

      const browserProvider = new ethers.BrowserProvider(window.ethereum);
      const signer = await browserProvider.getSigner();
      const from = await signer.getAddress();
      if (!from) return false;

      const contract = new ethers.Contract(CONTRACT_ADDRESS, WRITE_ABI, signer);

      const tx = await contract.joinCurrentRound({
        value: ethers.parseEther(String(ENTRY_FEE_ETH))
      });

      localStorage.setItem(pendingTxKey(from, roundId), tx.hash);

      setStatus("Waiting for confirmation...");
      await tx.wait(); // mined bekle

      setHasEntry(true);
      localStorage.setItem(entryKey(from, roundId), "1");

      setStatus("Entry confirmed. Now HODL.");
      fetchPot();
      return true;
    } catch (e) {
      console.error("sendEntryTx error", e);
      setStatus(`Payment failed: ${parseWalletError(e)}`);
      return false;
    } finally {
      setIsPaying(false);
    }
  };

  // ------------- SUBMIT SCORE -------------

  const submitScore = async (scoreMs) => {
    if (!account) return false;

    setStatus("Submitting score...");

    try {
      const res = await fetch(`${BACKEND_URL}/api/submit-score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roundId,
          wallet: account,
          walletAddress: account,
          scoreMs
        })
      });

      const data = await res.json().catch(() => ({}));
      console.log("submit-score response:", data);

      if (!res.ok) {
        setStatus("Backend error while submitting score. You can retry.");
        setPendingScore(scoreMs);
        return false;
      }

      // submit başarılı → entry hakkını temizle
      localStorage.removeItem(entryKey(account, roundId));
      localStorage.removeItem(pendingTxKey(account, roundId));
      setHasEntry(false);

      if (!bestScoreMs || scoreMs > bestScoreMs) setBestScoreMs(scoreMs);

      setPendingScore(null);
      setStatus("Score submitted.");
      fetchLeaderboard(roundId);
      return true;
    } catch (e) {
      console.error("submit-score error", e);
      setStatus("Submit failed (backend sleeping?). You can retry.");
      setPendingScore(scoreMs);
      return false;
    }
  };

  const retrySubmit = async () => {
    if (pendingScore == null) return;
    await submitScore(pendingScore);
  };

  // ------------- HODL LOGIC -------------

  const startHolding = async (e) => {
    if (e && e.preventDefault) e.preventDefault();

    if (!account) {
      await connectWallet();
      return;
    }

    if (pendingScore != null) return;

    if (!hasEntry) {
      if (isPaying) return;
      const ok = await sendEntryTx();
      if (!ok) return;
      return; // ikinci basışta hodl
    }

    if (holding) return;

    setHolding(true);
    holdStartRef.current = Date.now();
    setElapsedMs(0);
    setStatus("HOLDING...");

    intervalRef.current = setInterval(() => {
      setElapsedMs(Date.now() - holdStartRef.current);
    }, 20);
  };

  const stopHolding = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!holding) return;

    setHolding(false);
    clearInterval(intervalRef.current);

    const finalMs = Date.now() - holdStartRef.current;
    setElapsedMs(0);

    await submitScore(finalMs);
  };

  // ------------- UI -------------

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#020617",
        color: "#f9fafb",
        fontFamily:
          '-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif',
        padding: 32,
        boxSizing: "border-box"
      }}
    >
      <div
        style={{
          maxWidth: 960,
          margin: "0 auto",
          background: "#020617",
          borderRadius: 24,
          border: "1px solid rgba(148,163,184,0.4)",
          padding: "24px 24px 20px",
          boxShadow: "0 22px 60px rgba(0,0,0,0.7)",
          display: "grid",
          gridTemplateColumns: "minmax(0,2fr) minmax(0,1.4fr)",
          gap: 24
        }}
      >
        {/* LEFT SIDE */}
        <div>
          <header
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 20
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 26,
                  fontWeight: 800,
                  letterSpacing: "0.16em"
                }}
              >
                <span>HODL </span>
                <span style={{ color: "#f97316" }}>OR DIE</span>
              </div>
              <div style={{ fontSize: 13, color: "#9ca3af" }}>
                Pay, then hold the button. Longest degen wins the pot.
              </div>
            </div>

            <div style={{ textAlign: "right" }}>
              <button
                onClick={connectWallet}
                style={{
                  padding: "6px 14px",
                  borderRadius: 999,
                  border: "1px solid rgba(148,163,184,0.8)",
                  background: "transparent",
                  color: "#e5e7eb",
                  fontSize: 12,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  cursor: "pointer"
                }}
              >
                {account ? shorten(account) : "CONNECT"}
              </button>
              <div
                style={{
                  marginTop: 6,
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.16em",
                  color: "#6b7280"
                }}
              >
                Base Sepolia enforced
              </div>
            </div>
          </header>

          <div
            style={{
              background:
                "radial-gradient(circle at top,#111827,#020617 60%,#000 100%)",
              borderRadius: 20,
              border: "1px solid rgba(148,163,184,0.4)",
              padding: "18px 20px 20px"
            }}
          >
            {/* Pot + Entry */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12
              }}
            >
              <div>
                <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 4 }}>
                  Current Pot
                </div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "#f97316" }}>
                  {Number(potEth || "0").toFixed(4)} ETH
                </div>
              </div>
              <div style={{ textAlign: "right", fontSize: 12 }}>
                <div style={{ color: "#9ca3af", marginBottom: 4 }}>
                  Entry per attempt
                </div>
                <div style={{ fontWeight: 600 }}>{ENTRY_FEE_ETH} ETH</div>
                <div style={{ color: "#6b7280", fontSize: 11 }}>
                  Round #{roundId}
                </div>
              </div>
            </div>

            {/* Timer */}
            <div
              style={{
                textAlign: "center",
                fontSize: 40,
                fontVariantNumeric: "tabular-nums",
                marginBottom: 4
              }}
            >
              {formatMs(elapsedMs)}
            </div>
            <div
              style={{
                textAlign: "center",
                fontSize: 11,
                color: "#9ca3af",
                letterSpacing: "0.2em"
              }}
            >
              CURRENT ATTEMPT
            </div>

            {/* HODL BUTTON */}
            <button
              onMouseDown={startHolding}
              onMouseUp={stopHolding}
              onMouseLeave={stopHolding}
              onTouchStart={startHolding}
              onTouchEnd={stopHolding}
              disabled={isPaying || pendingScore != null}
              style={{
                marginTop: 18,
                width: "100%",
                height: 160,
                borderRadius: 999,
                border: "none",
                cursor: isPaying
                  ? "wait"
                  : pendingScore != null
                  ? "not-allowed"
                  : "pointer",
                fontSize: 22,
                fontWeight: 800,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                background: holding
                  ? "radial-gradient(circle at bottom,#b91c1c,#450a0a)"
                  : "radial-gradient(circle at top,#ef4444,#7f1d1d)",
                color: "#f9fafb",
                boxShadow: holding
                  ? "0 6px 24px rgba(127,29,29,0.7)"
                  : "0 12px 40px rgba(239,68,68,0.6)",
                transform: holding ? "translateY(4px)" : "translateY(0)",
                opacity: isPaying ? 0.6 : 1,
                transition:
                  "transform 0.08s ease-out, box-shadow 0.08s ease-out, background 0.15s ease-out, opacity 0.1s"
              }}
            >
              {pendingScore != null
                ? "SUBMIT PENDING"
                : hasEntry
                ? holding
                  ? "DON'T LET GO"
                  : "HODL"
                : isPaying
                ? "PAYING..."
                : "PAY & HODL"}
            </button>

            {pendingScore != null && (
              <button
                onClick={retrySubmit}
                style={{
                  marginTop: 10,
                  width: "100%",
                  padding: "10px 14px",
                  borderRadius: 12,
                  border: "1px solid rgba(148,163,184,0.4)",
                  background: "rgba(2,6,23,0.6)",
                  color: "#e5e7eb",
                  fontSize: 12,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  cursor: "pointer"
                }}
              >
                Retry submit
              </button>
            )}

            <div
              style={{
                marginTop: 14,
                display: "flex",
                justifyContent: "space-between",
                fontSize: 11,
                color: "#6b7280"
              }}
            >
              <span>Tx failures will show exact reason in Status.</span>
              {bestScoreMs != null && <span>Your best: {formatMs(bestScoreMs)}</span>}
            </div>

            {status && (
              <div style={{ marginTop: 10, fontSize: 11, color: "#9ca3af" }}>
                Status: {status}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT: LEADERBOARD */}
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
            Leaderboard
          </div>
          <div
            style={{
              background:
                "radial-gradient(circle at top,#020617,#020617 60%,#000 100%)",
              borderRadius: 20,
              border: "1px solid rgba(148,163,184,0.4)",
              padding: 14,
              maxHeight: 360,
              overflow: "auto",
              fontSize: 12
            }}
          >
            {leaderboard.length === 0 ? (
              <div style={{ color: "#6b7280" }}>
                No scores yet. Be the first degen to HODL.
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", paddingBottom: 6, borderBottom: "1px solid rgba(75,85,99,0.9)" }}>
                      #
                    </th>
                    <th style={{ textAlign: "left", paddingBottom: 6, borderBottom: "1px solid rgba(75,85,99,0.9)" }}>
                      Player
                    </th>
                    <th style={{ textAlign: "left", paddingBottom: 6, borderBottom: "1px solid rgba(75,85,99,0.9)" }}>
                      Best HODL
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((row, idx) => (
                    <tr key={`${row.wallet}-${idx}`}>
                      <td style={{ padding: "4px 0" }}>{idx + 1}</td>
                      <td style={{ padding: "4px 0" }}>{shorten(row.wallet)}</td>
                      <td style={{ padding: "4px 0" }}>{formatMs(row.bestScoreMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div style={{ marginTop: 8, fontSize: 10, color: "#6b7280" }}>
            Scores are tracked off-chain for MVP. Payout can be triggered by backend when pot reaches threshold.
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
