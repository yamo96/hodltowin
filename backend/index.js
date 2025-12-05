// backend/index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");

// -------- CONFIG --------

const PORT = process.env.PORT || 4000;

const BACKEND_ENTRY_FEE_ETH = Number(process.env.ENTRY_FEE_ETH || "0.0003");
const POT_MULTIPLIER = Number(process.env.POT_MULTIPLIER || "333");

// Kontrat adresi (env'den ya da fallback)
const CONTRACT_ADDRESS_RAW =
  process.env.CONTRACT_ADDRESS || "0x961156B75dcE2C58D25f965c936657D42b064230";

const RPC_URL = process.env.BASE_RPC_URL || ""; // Base Sepolia RPC URL'i

if (!RPC_URL) {
  console.error("❌ BASE_RPC_URL is not set in .env");
  process.exit(1);
}

// Adresi normalize et / validate
let CONTRACT_ADDRESS;
try {
  CONTRACT_ADDRESS = ethers.getAddress(CONTRACT_ADDRESS_RAW);
  console.log("Using contract:", CONTRACT_ADDRESS);
} catch (e) {
  console.error("❌ INVALID CONTRACT_ADDRESS:", CONTRACT_ADDRESS_RAW);
  console.error(e);
  process.exit(1);
}

// Read ABI (getCurrentRoundInfo)
const READ_ABI = [
  "function getCurrentRoundInfo() view returns (uint256 id, uint256 pot, uint256 start, uint256 end, bool finalized)"
];

// Write ABI (finalizeRound)
const WRITE_ABI = ["function finalizeRound(address winner) external"];

// Sadece encode/decode icin Interface
const readIface = new ethers.Interface(READ_ABI);

// Threshold: entryFee * multiplier (0.0003 * 333 ≈ 0.1)
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
  console.warn(
    "⚠️ BACKEND_WALLET_PRIVATE_KEY not set. finalizeRound (auto payout) disabled."
  );
}

// -------- IN-MEMORY STORE (MVP) --------

let currentRoundId = 1;

// { roundId, wallet, scoreMs, createdAt }
const scores = [];

// { [roundId]: { closed: boolean, winner: string|null, finalPotEth: string|null, closedAt: number } }
const roundsMeta = {};

function isRoundClosed(roundId) {
  return roundsMeta[roundId]?.closed === true;
}

function closeRound(roundId, winnerWallet, finalPotEth) {
  roundsMeta[roundId] = {
    closed: true,
    winner: winnerWallet,
    finalPotEth: finalPotEth,
    closedAt: Date.now()
  };
  console.log(
    `🔥 Round #${roundId} CLOSED. Winner: ${winnerWallet}, pot: ${finalPotEth} ETH`
  );

  // Yeni round'u backend tarafinda ilerlet
  currentRoundId = roundId + 1;
  console.log(`🌀 New round started (backend view): #${currentRoundId}`);
}

// ---- RAW RPC CALL: getCurrentRoundInfo ----

async function getCurrentRoundInfoRaw() {
  const data = readIface.encodeFunctionData("getCurrentRoundInfo", []);

  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [
      {
        to: CONTRACT_ADDRESS,
        data
      },
      "latest"
    ]
  };

  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const json = await res.json();
  if (json.error) {
    throw new Error("RPC error: " + JSON.stringify(json.error));
  }

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

// Threshold kontrolü + gerekirse finalizeRound
async function checkThresholdAndMaybeClose(roundId) {
  if (isRoundClosed(roundId)) return;

  try {
    const info = await getCurrentRoundInfoRaw();
    const potEth = info.potEth;

    console.log(
      `Round #${roundId} pot check → onchainId=${info.id} pot=${potEth} ETH`
    );

    if (potEth >= THRESHOLD_ETH) {
      const roundScores = scores.filter((s) => s.roundId === roundId);

      if (roundScores.length === 0) {
        console.log(
          `Threshold reached but no scores for round #${roundId}. Skipping close.`
        );
        return;
      }

      // En yuksek scoreMs kazansin
      roundScores.sort((a, b) => b.scoreMs - a.scoreMs);
      const winner = roundScores[0].wallet;

      console.log(`Winner for round #${roundId} => ${winner}`);

      // On-chain payout: finalizeRound(winner) cagir
      if (writeContract && signer) {
        try {
          const tx = await writeContract.finalizeRound(winner);
          console.log("finalizeRound tx:", tx.hash);
          await tx.wait();
          console.log("finalizeRound mined.");
        } catch (e) {
          console.error("finalizeRound tx failed:", e);
          return; // payout basarisizsa round'u kapatma
        }
      } else {
        console.warn(
          "No signer configured, cannot call finalizeRound. Skipping on-chain payout."
        );
        return;
      }

      // On-chain tx basariliysa backend meta'yi guncelle
      closeRound(roundId, winner, potEth.toFixed(4));
    }
  } catch (err) {
    console.error("checkThreshold error:", err.message || err);
  }
}

// -------- EXPRESS APP --------

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send({ ok: true, roundId: currentRoundId });
});

// Global leaderboard: her cüzdanin en iyi skoru
app.get("/api/leaderboard", (req, res) => {
  console.log("GET /api/leaderboard, total scores:", scores.length);

  const byWallet = {};
  for (const s of scores) {
    if (!byWallet[s.wallet] || s.scoreMs > byWallet[s.wallet].bestScoreMs) {
      byWallet[s.wallet] = { wallet: s.wallet, bestScoreMs: s.scoreMs };
    }
  }

  const leaderboard = Object.values(byWallet).sort(
    (a, b) => b.bestScoreMs - a.bestScoreMs
  );

  console.log("Leaderboard size:", leaderboard.length);
  res.json(leaderboard);
});

app.post("/api/submit-score", async (req, res) => {
  try {
    let { roundId, wallet, walletAddress, scoreMs } = req.body;

    const addr = wallet || walletAddress;
    if (!addr || typeof addr !== "string") {
      return res.status(400).json({ error: "wallet address required" });
    }

    const rId = Number(roundId) || currentRoundId;
    const sMs = Number(scoreMs);
    if (!sMs || sMs <= 0) {
      return res.status(400).json({ error: "invalid scoreMs" });
    }

    const effectiveRoundId = isRoundClosed(rId) ? currentRoundId : rId;

    scores.push({
      roundId: effectiveRoundId,
      wallet: addr,
      scoreMs: sMs,
      createdAt: Date.now()
    });

    console.log(
      `Score submitted: wallet=${addr} roundId=${effectiveRoundId} scoreMs=${sMs}`
    );

    // Threshold kontrolü ve gerekirse auto payout
    await checkThresholdAndMaybeClose(effectiveRoundId);

    const userBest = scores
      .filter((s) => s.roundId === effectiveRoundId && s.wallet === addr)
      .reduce((max, s) => (s.scoreMs > max ? s.scoreMs : max), 0);

    res.json({
      ok: true,
      roundId: effectiveRoundId,
      bestScoreMs: userBest,
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
