// backend/index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
const { Pool } = require("pg");

// ---------------- CONFIG ----------------

const PORT = Number(process.env.PORT || 4000);

const ENTRY_FEE_ETH = Number(process.env.ENTRY_FEE_ETH || "0.0003");
const POT_MULTIPLIER = Number(process.env.POT_MULTIPLIER || "333");
const THRESHOLD_ETH = ENTRY_FEE_ETH * POT_MULTIPLIER;

const CONTRACT_ADDRESS_RAW =
  process.env.CONTRACT_ADDRESS || "0x0000000000000000000000000000000000000000";

const RPC_URL = process.env.BASE_RPC_URL || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

// Render + Neon gibi servislerde çoğunlukla SSL gerekir
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

if (!RPC_URL) {
  console.error("❌ BASE_RPC_URL is not set");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set");
  process.exit(1);
}

// contract address validate/normalize
let CONTRACT_ADDRESS;
try {
  CONTRACT_ADDRESS = ethers.getAddress(CONTRACT_ADDRESS_RAW);
} catch (e) {
  console.error("❌ INVALID CONTRACT_ADDRESS:", CONTRACT_ADDRESS_RAW);
  process.exit(1);
}

console.log("✅ RPC_URL:", RPC_URL);
console.log("✅ CONTRACT_ADDRESS:", CONTRACT_ADDRESS);
console.log("✅ THRESHOLD:", THRESHOLD_ETH, "ETH");

// ---------------- ABIs ----------------

const READ_ABI = [
  "function getCurrentRoundInfo() view returns (uint256 id, uint256 pot, uint256 start, uint256 end, bool finalized)"
];

const WRITE_ABI = ["function finalizeRound(address winner) external"];

const readIface = new ethers.Interface(READ_ABI);

// ---------------- ONCHAIN READ (raw eth_call) ----------------

async function getCurrentRoundInfoRaw() {
  const data = readIface.encodeFunctionData("getCurrentRoundInfo", []);
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: CONTRACT_ADDRESS, data }, "latest"]
  };

  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const json = await res.json();
  if (json.error) throw new Error("RPC error: " + JSON.stringify(json.error));

  const [id, potWei, start, end, finalized] = readIface.decodeFunctionResult(
    "getCurrentRoundInfo",
    json.result
  );

  return {
    id: Number(id),
    potEth: Number(ethers.formatEther(potWei)),
    start,
    end,
    finalized: Boolean(finalized)
  };
}

// ---------------- WRITE (finalizeRound) ----------------

const { JsonRpcProvider, Wallet, Contract } = ethers;
const writeProvider = new JsonRpcProvider(RPC_URL);

let signer = null;
let writeContract = null;

if (process.env.BACKEND_WALLET_PRIVATE_KEY) {
  try {
    signer = new Wallet(process.env.BACKEND_WALLET_PRIVATE_KEY, writeProvider);
    writeContract = new Contract(CONTRACT_ADDRESS, WRITE_ABI, signer);
    console.log("✅ Backend signer ready:", signer.address);
  } catch (e) {
    console.error("❌ Failed to init backend signer:", e?.message || e);
  }
} else {
  console.warn("⚠️ BACKEND_WALLET_PRIVATE_KEY not set. Auto payout disabled.");
}

// ---------------- DB HELPERS ----------------

// scores table yoksa oluştur (MVP kolaylığı)
async function ensureTables() {
  // wallet + round unique, best_score_ms tutuluyor
  const sql = `
    CREATE TABLE IF NOT EXISTS scores (
      round_id BIGINT NOT NULL,
      wallet TEXT NOT NULL,
      best_score_ms BIGINT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (round_id, wallet)
    );
  `;
  await pool.query(sql);
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

async function getLeaderboard(roundId, limit = 100) {
  const q = `
    SELECT wallet, best_score_ms AS "bestScoreMs"
    FROM scores
    WHERE round_id = $1
    ORDER BY best_score_ms DESC
    LIMIT $2;
  `;
  const { rows } = await pool.query(q, [roundId, limit]);
  return rows;
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

async function getLatestRoundIdFromDB() {
  const r = await pool.query("SELECT MAX(round_id) AS max FROM scores");
  return Number(r.rows?.[0]?.max || 0);
}

// ---------------- ROUND META (RAM - MVP) ----------------

const roundsMeta = {}; // { [roundId]: { closed, winner, finalPotEth, closedAt } }

function isRoundClosed(roundId) {
  return roundsMeta[roundId]?.closed === true;
}

function closeRound(roundId, winnerWallet, finalPotEth) {
  roundsMeta[roundId] = {
    closed: true,
    winner: winnerWallet,
    finalPotEth,
    closedAt: Date.now()
  };
  console.log(
    `🔥 Round #${roundId} CLOSED. Winner=${winnerWallet}, pot=${finalPotEth} ETH`
  );
}

// ---------------- THRESHOLD CHECK ----------------

async function checkThresholdAndMaybeClose(roundId) {
  if (isRoundClosed(roundId)) return;

  try {
    const info = await getCurrentRoundInfoRaw();
    const potEth = info.potEth;

    // Eğer frontend roundId gönderirken sapıtırsa, onchain round farklı olabilir.
    // Bu MVP’de roundId’yi "score’un gittiği round" olarak kullanıyoruz.
    console.log(
      `Pot check → requestedRound=${roundId} onchainRound=${info.id} pot=${potEth} ETH`
    );

    if (potEth < THRESHOLD_ETH) return;

    const winnerRow = await getWinnerForRound(roundId);
    if (!winnerRow) {
      console.log(`Threshold reached but no scores in DB for round #${roundId}`);
      return;
    }

    const winner = winnerRow.wallet;
    console.log(`Winner candidate for round #${roundId}:`, winner);

    if (!writeContract || !signer) {
      console.warn("⚠️ No signer configured. Cannot finalizeRound on-chain.");
      return;
    }

    // On-chain payout
    try {
      const tx = await writeContract.finalizeRound(winner);
      console.log("finalizeRound tx:", tx.hash);
      await tx.wait();
      console.log("finalizeRound mined ✅");
    } catch (e) {
      console.error("finalizeRound failed:", e?.shortMessage || e?.message || e);
      return; // payout başarısızsa round kapatma
    }

    closeRound(roundId, winner, potEth.toFixed(4));
  } catch (e) {
    console.error("checkThreshold error:", e?.message || e);
  }
}

// ---------------- EXPRESS APP ----------------

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

app.get("/", async (req, res) => {
  try {
    const info = await getCurrentRoundInfoRaw();
    res.json({
      ok: true,
      onchainRoundId: info.id,
      potEth: info.potEth,
      thresholdEth: THRESHOLD_ETH
    });
  } catch (e) {
    res.json({ ok: true, warning: "RPC read failed" });
  }
});

// Leaderboard: roundId verilmezse DB’deki en son roundId (yoksa 1)
app.get("/api/leaderboard", async (req, res) => {
  try {
    let roundId = Number(req.query.roundId);

    if (!roundId) {
      const latest = await getLatestRoundIdFromDB();
      roundId = latest || 1;
    }

    const rows = await getLeaderboard(roundId, 100);
    res.json(rows);
  } catch (e) {
    console.error("leaderboard error:", e?.message || e);
    res.status(500).json({ error: "internal error" });
  }
});

// Submit score (DB upsert)
app.post("/api/submit-score", async (req, res) => {
  try {
    let { roundId, wallet, walletAddress, scoreMs } = req.body;

    const addr = wallet || walletAddress;
    if (!addr || typeof addr !== "string") {
      return res.status(400).json({ error: "wallet address required" });
    }

    const sMs = Number(scoreMs);
    if (!Number.isFinite(sMs) || sMs <= 0) {
      return res.status(400).json({ error: "invalid scoreMs" });
    }

    // roundId yoksa onchain roundId kullan
    let effectiveRoundId = Number(roundId);
    if (!effectiveRoundId) {
      const info = await getCurrentRoundInfoRaw();
      effectiveRoundId = info.id;
    }

    // upsert best score
    const row = await upsertScore({
      roundId: effectiveRoundId,
      wallet: addr,
      scoreMs: sMs
    });

    console.log(
      `Score submitted: wallet=${row.wallet} round=${row.round_id} scoreMs=${sMs}`
    );

    // pot threshold check
    await checkThresholdAndMaybeClose(effectiveRoundId);

    res.json({
      ok: true,
      roundId: effectiveRoundId,
      bestScoreMs: Number(row.best_score_ms),
      roundClosed: isRoundClosed(effectiveRoundId),
      winner: roundsMeta[effectiveRoundId]?.winner || null
    });
  } catch (e) {
    console.error("submit-score error:", e?.message || e);
    res.status(500).json({ error: "internal error" });
  }
});

// Basit health check (Render için)
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1;");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// ---------------- START ----------------

(async () => {
  try {
    await ensureTables();
    console.log("✅ DB tables ready");
  } catch (e) {
    console.error("❌ DB init failed:", e?.message || e);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Backend listening on port ${PORT}`);
  });
})();
