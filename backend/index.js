// backend/index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
const { Pool } = require("pg");
const { v4: uuidv4 } = require('uuid');

// ---------------- CONFIG ----------------

const PORT = Number(process.env.PORT || 4000);
const ENTRY_FEE_ETH = Number(process.env.ENTRY_FEE_ETH || "0.0003");
const POT_MULTIPLIER = Number(process.env.POT_MULTIPLIER || "333");
const THRESHOLD_ETH = ENTRY_FEE_ETH * POT_MULTIPLIER;

const CONTRACT_ADDRESS_RAW = process.env.CONTRACT_ADDRESS || "0x0000000000000000000000000000000000000000";
const RPC_URL = process.env.BASE_RPC_URL || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

if (!RPC_URL || !DATABASE_URL) {
  console.error("❌ Missing Config: BASE_RPC_URL or DATABASE_URL");
  process.exit(1);
}

let CONTRACT_ADDRESS;
try {
  CONTRACT_ADDRESS = ethers.getAddress(CONTRACT_ADDRESS_RAW);
} catch (e) {
  console.error("❌ Invalid Contract Address:", CONTRACT_ADDRESS_RAW);
  process.exit(1);
}

console.log("✅ System Started");
console.log("📍 Contract:", CONTRACT_ADDRESS);
console.log("💰 Target Pot:", THRESHOLD_ETH, "ETH");

// ---------------- ABIs ----------------

const CONTRACT_ABI = [
  "function getCurrentRoundInfo() view returns (uint256 id, uint256 pot, uint256 start, uint256 end, bool finalized)",
  "function finalizeRound(address winner) external",
  "event Joined(address indexed player, uint256 indexed roundId, uint256 amount)"
];

// ---------------- BLOCKCHAIN SETUP ----------------

const provider = new ethers.JsonRpcProvider(RPC_URL);
const readContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);

let signer = null;
let writeContract = null;

if (process.env.BACKEND_WALLET_PRIVATE_KEY) {
  try {
    signer = new ethers.Wallet(process.env.BACKEND_WALLET_PRIVATE_KEY, provider);
    writeContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
    console.log("✅ Backend Wallet Ready:", signer.address);
  } catch (e) {
    console.error("❌ Wallet Error:", e.message);
  }
} else {
  console.warn("⚠️ WARNING: No Private Key. Auto-payout disabled.");
}

// ---------------- HELPERS ----------------

async function hasUserPaid(roundId, walletAddress) {
    try {
        const filter = readContract.filters.Joined(walletAddress, roundId);
        const events = await readContract.queryFilter(filter);
        return events.length > 0;
    } catch (e) {
        console.error("Payment check error:", e);
        return false;
    }
}

async function upsertScore({ roundId, wallet, scoreMs }) {
  const q = `
    INSERT INTO scores (round_id, wallet, best_score_ms)
    VALUES ($1, LOWER($2), $3)
    ON CONFLICT (round_id, wallet)
    DO UPDATE SET
      best_score_ms = GREATEST(scores.best_score_ms, EXCLUDED.best_score_ms),
      updated_at = NOW()
    RETURNING round_id, wallet, best_score_ms;
  `;
  const { rows } = await pool.query(q, [roundId, wallet, scoreMs]);
  return rows[0];
}

async function getWinnerForRound(roundId) {
  const q = `
    SELECT wallet, best_score_ms
    FROM scores
    WHERE round_id = $1
    ORDER BY best_score_ms DESC
    LIMIT 1;
  `;
  const { rows } = await pool.query(q, [roundId]);
  return rows[0] || null;
}

const roundsMeta = {}; 

async function checkThresholdAndMaybeClose(roundId) {
  if (roundsMeta[roundId]?.closed) return;

  try {
    const info = await readContract.getCurrentRoundInfo();
    const potEth = Number(ethers.formatEther(info.pot));
    
    if (potEth < THRESHOLD_ETH) return;

    const winnerRow = await getWinnerForRound(roundId);
    if (!winnerRow) return;

    const winner = winnerRow.wallet;
    
    if (!writeContract) return;

    console.log("⏳ Finalizing round...");
    const tx = await writeContract.finalizeRound(winner);
    console.log("✅ Tx Hash:", tx.hash);
    
    await tx.wait();
    roundsMeta[roundId] = { closed: true, winner, potEth };

  } catch (e) {
    console.error("❌ CheckThreshold Error:", e.message);
  }
}

// ---------------- EXPRESS APP ----------------

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

// 1. START GAME (Timer & Payment Check)
app.post("/api/start-game", async (req, res) => {
    try {
        const { wallet, roundId } = req.body;
        
        if (!wallet || !roundId) return res.status(400).json({ error: "Missing data" });

        // SECURITY 1: Payment Check
        const isPaid = await hasUserPaid(roundId, wallet);
        if (!isPaid) {
            console.log(`⛔ Unpaid attempt: ${wallet}`);
            // "Entry fee required" mesajı Frontend'de yakalanacak!
            return res.status(403).json({ error: "Entry fee required" });
        }

        // SECURITY 2: Create Session
        const sessionId = uuidv4();
        const serverStartTime = Date.now();

        await pool.query(
            `INSERT INTO active_sessions (wallet_address, session_id, start_time, round_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (wallet_address) 
             DO UPDATE SET session_id = $2, start_time = $3, round_id = $4`,
            [wallet, sessionId, serverStartTime, roundId]
        );

        console.log(`⏱️ START: ${wallet}`);
        res.json({ ok: true, sessionId });

    } catch (e) {
        console.error("Start Game Error:", e);
        res.status(500).json({ error: "Server error" });
    }
});

// 2. SUBMIT SCORE
app.post("/api/submit-score", async (req, res) => {
    try {
        const { roundId, wallet, scoreMs, sessionId } = req.body;

        if (!wallet || !sessionId) return res.status(400).json({ error: "Missing parameters" });

        const sessionRes = await pool.query(
            `SELECT * FROM active_sessions WHERE wallet_address = $1`, 
            [wallet]
        );

        if (sessionRes.rows.length === 0) {
            return res.status(400).json({ error: "Session not found. Refresh page." });
        }

        const session = sessionRes.rows[0];

        if (session.session_id !== sessionId) {
            return res.status(403).json({ error: "Invalid session ID." });
        }

        // ANTI-CHEAT: Time Check
        const serverEndTime = Date.now();
        const startTime = Number(session.start_time);
        const maxPossibleScore = serverEndTime - startTime;
        const BUFFER_MS = 4000; // Increased buffer slightly

        if (Number(scoreMs) > (maxPossibleScore + BUFFER_MS)) {
            console.log(`🚨 CHEAT DETECTED: ${wallet}`);
            await pool.query(`DELETE FROM active_sessions WHERE wallet_address = $1`, [wallet]);
            return res.status(403).json({ error: "Time verification failed." });
        }

        const row = await upsertScore({
            roundId,
            wallet,
            scoreMs: Number(scoreMs)
        });

        await pool.query(`DELETE FROM active_sessions WHERE wallet_address = $1`, [wallet]);
        await checkThresholdAndMaybeClose(roundId);

        res.json({ 
            ok: true, 
            bestScoreMs: Number(row.best_score_ms),
            winner: roundsMeta[roundId]?.winner || null
        });

    } catch (e) {
        console.error("Submit Score Error:", e);
        res.status(500).json({ error: "Server error" });
    }
});

app.get("/api/leaderboard", async (req, res) => {
  try {
    let roundId = Number(req.query.roundId);
    if (!roundId) {
       try {
         const info = await readContract.getCurrentRoundInfo();
         roundId = Number(info.id);
       } catch { roundId = 1; }
    }

    const q = `
        SELECT wallet, best_score_ms AS "bestScoreMs"
        FROM scores
        WHERE round_id = $1
        ORDER BY best_score_ms DESC
        LIMIT 100;
    `;
    const { rows } = await pool.query(q, [roundId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Fetch failed" });
  }
});

app.get("/", async (req, res) => {
    try {
        const info = await readContract.getCurrentRoundInfo();
        res.json({
            ok: true,
            onchainRoundId: Number(info.id),
            potEth: ethers.formatEther(info.pot),
            finalized: info.finalized
        });
    } catch (e) {
        res.json({ ok: true, status: "Backend Running", error: e.message });
    }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});