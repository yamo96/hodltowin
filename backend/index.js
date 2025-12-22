// backend/index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
const { Pool } = require("pg");

// -------- CONFIG --------
const PORT = process.env.PORT || 4000;

const BACKEND_ENTRY_FEE_ETH = Number(process.env.ENTRY_FEE_ETH || "0.0003");
const POT_MULTIPLIER = Number(process.env.POT_MULTIPLIER || "333");

const CONTRACT_ADDRESS_RAW =
  process.env.CONTRACT_ADDRESS || "0x961156B75dcE2C58D25f965c936657D42b064230";

const RPC_URL = process.env.BASE_RPC_URL || "";

if (!RPC_URL) {
  console.error("❌ BASE_RPC_URL is not set in .env");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set in env");
  process.exit(1);
}

// Postgres pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// normalize contract
let CONTRACT_ADDRESS;
try {
  CONTRACT_ADDRESS = ethers.getAddress(CONTRACT_ADDRESS_RAW);
  console.log("Using contract:", CONTRACT_ADDRESS);
} catch (e) {
  console.error("❌ INVALID CONTRACT_ADDRESS:", CONTRACT_ADDRESS_RAW);
  console.error(e);
  process.exit(1);
}

// ABI
const READ_ABI = [
  "function getCurrentRoundInfo() view returns (uint256 id, uint256 pot, uint256 start, uint256 end, bool finalized)"
];
const WRITE_ABI = ["function finalizeRound(address winner) external"];
const readIface = new ethers.Interface(READ_ABI);

const THRESHOLD_ETH = BACKEND_ENTRY_FEE_ETH * POT_MULTIPLIER;
console.log("Using threshold:", THRESHOLD_ETH, "ETH");

// -------- WRITE TARAFI (finalizeRound) --------
const { JsonRpcProvider, Wallet, Contract } = ethers;
const writeProvider = new JsonRpcProvider(RPC_URL);

let signer = null;
let writeContract = null;

if (process.env.BACKEND_WALLET_PRIVATE_KEY) {
  try {
    signer = new Wallet(process.env.BACKEND_WALLET_PRIVATE_KEY, writeProvider);
    writeContract = new Contract(CONTRACT_ADDRESS, WRITE_ABI, signer);
    console.log("Backend signer ready. Address:", signer.address);
  } catch (e) {
    console.error("❌ Failed to init backend signer:", e);
  }
} else {
  console.warn("⚠️ BACKEND_WALLET_PRIVATE_KEY not set. finalizeRound disabled.");
}

// ---- RAW RPC CALL: getCurrentRoundInfo ----
async function getCurrentRoundInfoRaw() {
  const data = readIface.encodeFunctionData("getCurrentRoundInfo", []);

  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: CONTRACT_ADDRESS, data }, "latest"]
  };

  // Node 18+ fetch global (Render genelde OK)
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const json = await res.json();
  if (json.error) throw new Error("RPC error: " + JSON.stringify(json.error));

  const [id, pot, start, end, finalized] = readIface.decodeFunctionResult(
    "getCurrentRoundInfo",
    json.result
  );

  return {
    id: Number(id),
    potEth: Number(ethers.formatEther(pot)),
    start,
    end,
    finalized
  };
}

// round closed meta (DB’ye de alınabilir ama şimdilik RAM ok)
const roundsMeta = {};
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
  console.log(`🔥 Round #${roundId} CLOSED. Winner: ${winnerWallet}, pot: ${finalPotEth} ETH`);
}

// winner hesabı DB’den
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

async function checkThresholdAndMaybeClose(roundId) {
  if (isRoundClosed(roundId)) return;

  try {
    const info = await getCurrentRoundInfoRaw();
    const potEth = info.potEth;

    console.log(`Round #${roundId} pot check → onchainId=${info.id} pot=${potEth} ETH`);

    if (potEth < THRESHOLD_ETH) return;

    const winnerRow = await getWinnerForRound(roundId);
    if (!winnerRow) {
      console.log(`Threshold reached but no scores for round #${roundId}. Skipping close.`);
      return;
    }

    const winner = winnerRow.wallet;
    console.log(`Winner for round #${roundId} => ${winner}`);

    if (writeContract && signer) {
      try {
        const tx = await writeContract.finalizeRound(winner);
        console.log("finalizeRound tx:", tx.hash);
        await tx.wait();
        console.log("finalizeRound mined.");
      } catch (e) {
        console.error("finalizeRound tx failed:", e);
        return;
      }
    } else {
      console.warn("No signer configured, cannot call finalizeRound. Skipping on-chain payout.");
      return;
    }

    closeRound(roundId, winner, potEth.toFixed(4));
  } catch (err) {
    console.error("checkThreshold error:", err.message || err);
  }
}

// -------- EXPRESS APP --------
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", async (req, res) => {
  // roundId’yi onchain’den okuyup verelim (RAM’e bağlı kalmasın)
  try {
    const info = await getCurrentRoundInfoRaw();
    return res.send({ ok: true, roundId: info.id });
  } catch {
    return res.send({ ok: true, roundId: 1 });
  }
});

// ✅ roundId’ye göre leaderboard
app.get("/api/leaderboard", async (req, res) => {
  try {
    const roundId = Number(req.query.roundId || 1);

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
    console.error("leaderboard error:", e);
    res.status(500).json({ error: "internal error" });
  }
});

app.post("/api/submit-score", async (req, res) => {
  try {
    let { roundId, wallet, walletAddress, scoreMs } = req.body;

    const addr = wallet || walletAddress;
    if (!addr || typeof addr !== "string") {
      return res.status(400).json({ error: "wallet address required" });
    }

    const sMs = Number(scoreMs);
    if (!sMs || sMs <= 0) {
      return res.status(400).json({ error: "invalid scoreMs" });
    }

    // roundId yoksa onchain round id al
    let effectiveRoundId = Number(roundId);
    if (!effectiveRoundId) {
      const info = await getCurrentRoundInfoRaw();
      effectiveRoundId = info.id;
    }

    // UPSERT: aynı wallet + round için max score tut
    const upsert = `
      INSERT INTO scores (round_id, wallet, best_score_ms)
      VALUES ($1, LOWER($2), $3)
      ON CONFLICT (round_id, wallet)
      DO UPDATE SET best_score_ms = GREATEST(scores.best_score_ms, EXCLUDED.best_score_ms),
                   updated_at = NOW()
      RETURNING round_id, wallet, best_score_ms;
    `;
    const { rows } = await pool.query(upsert, [effectiveRoundId, addr, sMs]);
    const row = rows[0];

    console.log(`Score submitted: wallet=${row.wallet} roundId=${row.round_id} scoreMs=${sMs}`);

    await checkThresholdAndMaybeClose(effectiveRoundId);

    res.json({
      ok: true,
      roundId: effectiveRoundId,
      bestScoreMs: Number(row.best_score_ms),
      roundClosed: isRoundClosed(effectiveRoundId),
      winner: roundsMeta[effectiveRoundId]?.winner || null
    });
  } catch (err) {
    console.error("submit-score error:", err);
    res.status(500).json({ error: "internal error" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
