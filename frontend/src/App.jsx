import React, { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import "./App.css";

import PotPanel from "./components/PotPanel";
import HoldButton from "./components/HoldButton";
import Leaderboard from "./components/Leaderboard";
import RulesModal from "./components/RulesModal";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";
const CONTRACT_ADDRESS = "0xeA2614aaaC15BBCC525836a5EEF7A17345cEfa74";

const ENTRY_FEE_ETH = Number(import.meta.env.VITE_ENTRY_FEE_ETH || "0.0003");
const RPC_URL = import.meta.env.VITE_BASE_RPC_URL || "";

const TARGET_POT_ETH = 0.1;
const BASE_SEPOLIA_CHAIN_ID_HEX = "0x14a34";

const READ_ABI = [
  "function getCurrentRoundInfo() view returns (uint256 id, uint256 pot, uint256 start, uint256 end, bool finalized)"
];
const WRITE_ABI = ["function joinCurrentRound() external payable"];

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
function parseWalletError(e) {
  const code = e?.code || e?.error?.code;
  const inner =
    e?.error?.message ||
    e?.error?.data?.message ||
    e?.data?.message ||
    (Array.isArray(e?.errors) &&
      (e.errors[0]?.message || e.errors[0]?.shortMessage)) ||
    e?.shortMessage ||
    e?.reason ||
    e?.message ||
    "Unknown error";

  if (code === 4001) return "You rejected the transaction.";
  if (String(inner).toLowerCase().includes("insufficient funds"))
    return "Insufficient funds for gas.";
  return inner;
}

async function ensureBaseSepolia() {
  if (!window.ethereum) return { ok: false, reason: "No wallet found." };
  const chainId = await window.ethereum.request({ method: "eth_chainId" });
  if (chainId === BASE_SEPOLIA_CHAIN_ID_HEX) return { ok: true };
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_SEPOLIA_CHAIN_ID_HEX }]
    });
    return { ok: true };
  } catch {
    return { ok: false, reason: "Please switch MetaMask to Base Sepolia." };
  }
}

export default function App() {
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
  const [pendingSessionId, setPendingSessionId] = useState(null);
  
  const [rulesOpen, setRulesOpen] = useState(false);

  const holdStartRef = useRef(null);
  const intervalRef = useRef(null);
  const sessionIdRef = useRef(null);
  const roundIdRef = useRef(1);

  // loading guard
  const [lbLoading, setLbLoading] = useState(false);
  const lbReqIdRef = useRef(0);

  useEffect(() => { roundIdRef.current = roundId; }, [roundId]);

  // ---------- wallet connect ----------
  const connectWallet = async () => {
    try {
      if (!window.ethereum) return alert("Please install MetaMask.");
      const net = await ensureBaseSepolia();
      if (!net.ok) return setStatus(net.reason);
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      setAccount(accounts?.[0] || null);
      setStatus("");
    } catch (e) {
      setStatus(parseWalletError(e));
    }
  };

  useEffect(() => {
    if (!window.ethereum) return;
    const onAccounts = (accs) => setAccount(accs?.[0] || null);
    window.ethereum.on?.("accountsChanged", onAccounts);
    return () => window.ethereum.removeListener?.("accountsChanged", onAccounts);
  }, []);

  // ---------- reads ----------
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

  const fetchLeaderboard = async (rId) => {
    const useRound = Number(rId || roundIdRef.current || 1);
    const reqId = ++lbReqIdRef.current;
    try {
      setLbLoading(true);
      const res = await fetch(`${BACKEND_URL}/api/leaderboard?roundId=${useRound}`, { cache: "no-store" });
      if (!res.ok) throw new Error("lb fetch failed");
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.leaderboard || [];
      if (reqId !== lbReqIdRef.current) return;
      setLeaderboard(list);
    } catch (e) {
      console.error("leaderboard error", e);
    } finally {
      if (reqId === lbReqIdRef.current) setLbLoading(false);
    }
  };

  useEffect(() => {
    fetchPot();
    fetchLeaderboard(1);
    const potInt = setInterval(fetchPot, 12000);
    const lbInt = setInterval(() => fetchLeaderboard(roundIdRef.current), 12000);
    return () => { clearInterval(potInt); clearInterval(lbInt); };
  }, []);

  useEffect(() => { fetchLeaderboard(roundId); }, [roundId]);

  useEffect(() => {
    if (!account) return setHasEntry(false);
    setHasEntry(localStorage.getItem(entryKey(account, roundId)) === "1");
  }, [account, roundId]);

  // ---------- entry tx ----------
  const sendEntryTx = async () => {
    try {
      if (!window.ethereum) { alert("Please install MetaMask."); return false; }
      if (isPaying) return false;

      const net = await ensureBaseSepolia();
      if (!net.ok) { setStatus(net.reason); return false; }

      setIsPaying(true);
      setStatus("Sending entry transaction...");

      const browserProvider = new ethers.BrowserProvider(window.ethereum);
      const signer = await browserProvider.getSigner();
      const from = await signer.getAddress();
      
      const contract = new ethers.Contract(CONTRACT_ADDRESS, WRITE_ABI, signer);
      const tx = await contract.joinCurrentRound({ value: ethers.parseEther(String(ENTRY_FEE_ETH)) });

      localStorage.setItem(pendingTxKey(from, roundId), tx.hash);
      setStatus("Waiting for confirmation...");
      await tx.wait();

      setHasEntry(true);
      localStorage.setItem(entryKey(from, roundId), "1");
      setStatus("Entry confirmed. Now HODL.");
      fetchPot();
      return true;
    } catch (e) {
      setStatus(`Payment failed: ${parseWalletError(e)}`);
      return false;
    } finally {
      setIsPaying(false);
    }
  };

  // ---------- submit score ----------
  const submitScore = async (scoreMs, sessionId) => {
    if (!account) return false;
    if (!sessionId) {
        setStatus("Error: Anti-cheat check failed (No Session).");
        return false;
    }

    setStatus("Submitting score...");
    try {
      const res = await fetch(`${BACKEND_URL}/api/submit-score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roundId, wallet: account, walletAddress: account, scoreMs, sessionId })
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const errMsg = data.error || "Backend error";
        setStatus(`Submit failed: ${errMsg}`);
        setPendingScore(scoreMs);
        setPendingSessionId(sessionId);
        return false;
      }

      localStorage.removeItem(entryKey(account, roundId));
      localStorage.removeItem(pendingTxKey(account, roundId));
      setHasEntry(false);

      if (!bestScoreMs || scoreMs > bestScoreMs) setBestScoreMs(scoreMs);

      setPendingScore(null);
      setPendingSessionId(null);
      sessionIdRef.current = null;
      setStatus("Score submitted successfully!");
      fetchLeaderboard(roundId);
      return true;
    } catch (e) {
      console.error("submit error", e);
      setStatus("Network error during submit.");
      setPendingScore(scoreMs);
      setPendingSessionId(sessionId);
      return false;
    }
  };

  const retrySubmit = async () => {
    if (pendingScore == null || pendingSessionId == null) return;
    await submitScore(pendingScore, pendingSessionId);
  };

  // ---------- hold logic (FIXED LOOP ISSUE) ----------
  const startHolding = async (e) => {
    e?.preventDefault?.();
    if (isPaying) return;
    if (!account) return connectWallet();
    if (pendingScore != null) return;

    // 1. Check local entry state
    if (!hasEntry) {
      const ok = await sendEntryTx();
      if (!ok) return;
      return; 
    }

    if (holding) return;

    setStatus("Syncing with server...");
    
    try {
        const res = await fetch(`${BACKEND_URL}/api/start-game`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ roundId, wallet: account })
        });
        
        const data = await res.json();
        
        // 🔥 CRITICAL FIX: Backend "Payment required" derse, local state'i temizle!
        if (!res.ok) {
            const err = data.error || "Unknown";
            setStatus(`Start failed: ${err}`);

            if (err.includes("Entry fee required") || res.status === 403) {
                // Backend: "Para yok" -> Frontend: "Tamam, HODL'ı PAY butonuna çeviriyorum"
                console.log("Payment out of sync, resetting local state.");
                setHasEntry(false);
                localStorage.removeItem(entryKey(account, roundId));
            }
            return;
        }

        sessionIdRef.current = data.sessionId;
        
        setHolding(true);
        holdStartRef.current = Date.now();
        setElapsedMs(0);
        setStatus("HOLDING... Don't let go!");

        intervalRef.current = setInterval(() => {
          setElapsedMs(Date.now() - holdStartRef.current);
        }, 20);

    } catch (err) {
        setStatus("Network error. Could not start.");
    }
  };

  const stopHolding = async (e) => {
    e?.preventDefault?.();
    if (!holding) return;

    setHolding(false);
    clearInterval(intervalRef.current);

    const finalMs = Date.now() - holdStartRef.current;
    setElapsedMs(0);
    const sid = sessionIdRef.current;
    await submitScore(finalMs, sid);
  };

  useEffect(() => {
    if (!holding) return;
    const handleVisibility = () => { if (document.hidden) stopHolding(); };
    const handleBlur = () => stopHolding();
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("blur", handleBlur);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("blur", handleBlur);
    };
  }, [holding]);

  const potNum = Number(potEth || "0");
  const leftToTarget = Math.max(0, TARGET_POT_ETH - potNum);
  const progress = Math.max(0, Math.min(1, potNum / TARGET_POT_ETH));
  const yourIndex = account ? leaderboard.findIndex((r) => (r.wallet || "").toLowerCase() === account.toLowerCase()) : -1;

  return (
    <div className="page">
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            <div className="brandTitle">HODL <span className="brandWin">TO WIN</span></div>
            <div className="brandSub">Pay. Hold. Win the pot.</div>
          </div>
          <div className="topActions">
            <button className="ghostBtn" onClick={() => setRulesOpen(true)}>RULES</button>
            <button className="pillBtn" onClick={connectWallet}>{account ? shorten(account) : "CONNECT"}</button>
            <div className="liveLine"><span className="liveDot" /> LIVE</div>
          </div>
        </header>

        <main className="grid">
          <section className="card">
            <PotPanel potEth={potNum} targetEth={TARGET_POT_ETH} leftEth={leftToTarget} progress={progress} entryFeeEth={ENTRY_FEE_ETH} roundId={roundId} />
            <div className="timerWrap">
              <div className={`timer ${holding ? "timerHolding" : ""}`}>{formatMs(elapsedMs)}</div>
              <div className="timerLabel">CURRENT ATTEMPT</div>
              <div className="timerSub">No release = no score.</div>
            </div>
            <HoldButton holding={holding} hasEntry={hasEntry} isPaying={isPaying} pendingScore={pendingScore} onPointerDown={startHolding} onPointerUp={stopHolding} onPointerLeave={stopHolding} />
            {pendingScore != null && <button className="secondaryBtn" onClick={retrySubmit}>Retry submit</button>}
            {bestScoreMs != null && <div className="hintRow"><span className="hintMuted">Your best</span><span className="hintStrong">{formatMs(bestScoreMs)}</span></div>}
            {status && <div className="status">Status: {status}</div>}
          </section>
          <section className="card">
            <Leaderboard leaderboard={leaderboard} yourIndex={yourIndex} formatMs={formatMs} shorten={shorten} loading={lbLoading} />
          </section>
        </main>
        <footer className="footerNote">Scores: Secure & Server-Verified. Pot: On-chain.</footer>
      </div>
      <RulesModal open={rulesOpen} onClose={() => setRulesOpen(false)} entryFeeEth={ENTRY_FEE_ETH} targetEth={TARGET_POT_ETH} />
    </div>
  );
}