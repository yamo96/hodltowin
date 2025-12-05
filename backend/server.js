const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { ethers } = require("ethers");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

// In-memory score storage: { roundId: { wallet: { bestScoreMs, bestScoreAt } } }
const scores = {};
let currentRoundId = 1;

// Contract setup (optional for finalize)
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const BASE_RPC_URL = process.env.BASE_RPC_URL;
const BACKEND_WALLET_PRIVATE_KEY = process.env.BACKEND_WALLET_PRIVATE_KEY;

let contract = null;

if (CONTRACT_ADDRESS && BASE_RPC_URL && BACKEND_WALLET_PRIVATE_KEY) {
  const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
  const wallet = new ethers.Wallet(BACKEND_WALLET_PRIVATE_KEY, provider);
  const abi = [
    "function currentRoundId() view returns (uint256)",
    "function finalizeCurrentRound(address[] calldata _winners) external",
    "function getCurrentRoundInfo() view returns (uint256 id, uint256 pot, uint256 start, uint256 end, bool finalized)"
  ];
  contract = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);
}

// Utility: ensure round container
function ensureRound(roundId) {
  if (!scores[roundId]) {
    scores[roundId] = {};
  }
}

// Simple endpoint to get current roundId (if contract set, read from it)
app.get("/api/current-round", async (req, res) => {
  try {
    if (contract) {
      const id = await contract.currentRoundId();
      currentRoundId = Number(id);
    }
    res.json({ roundId: currentRoundId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed_to_get_round" });
  }
});

// Submit score: { walletAddress, scoreMs }
app.post("/api/submit-score", async (req, res) => {
  try {
    const { walletAddress, scoreMs, roundId } = req.body;
    if (!walletAddress || typeof scoreMs !== "number") {
      return res.status(400).json({ error: "invalid_payload" });
    }
    const rId = roundId || currentRoundId;
    ensureRound(rId);

    const now = Date.now();
    const roundScores = scores[rId];
    const existing = roundScores[walletAddress?.toLowerCase()] || null;

    if (!existing || scoreMs > existing.bestScoreMs) {
      roundScores[walletAddress.toLowerCase()] = {
        bestScoreMs: scoreMs,
        bestScoreAt: now
      };
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "submit_failed" });
  }
});

// Leaderboard for a round
app.get("/api/leaderboard", (req, res) => {
  try {
    const rId = Number(req.query.roundId) || currentRoundId;
    ensureRound(rId);
    const roundScores = scores[rId];

    const list = Object.entries(roundScores).map(([wallet, data]) => ({
      wallet,
      bestScoreMs: data.bestScoreMs,
      bestScoreAt: data.bestScoreAt
    }));

    list.sort((a, b) => {
      // Descending by score, then ascending by time
      if (b.bestScoreMs !== a.bestScoreMs) {
        return b.bestScoreMs - a.bestScoreMs;
      }
      return a.bestScoreAt - b.bestScoreAt;
    });

    res.json({ roundId: rId, leaderboard: list.slice(0, 100) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "leaderboard_failed" });
  }
});

// Admin finalize endpoint (should be called at weekly reset)
app.post("/api/admin/finalize-round", async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const rId = Number(req.body.roundId) || currentRoundId;
    ensureRound(rId);
    const roundScores = scores[rId];

    const list = Object.entries(roundScores).map(([wallet, data]) => ({
      wallet,
      bestScoreMs: data.bestScoreMs,
      bestScoreAt: data.bestScoreAt
    }));

    if (!list.length) {
      return res.status(400).json({ error: "no_scores" });
    }

    // En iyi skoru bul
    list.sort((a, b) => {
      if (b.bestScoreMs !== a.bestScoreMs) {
        return b.bestScoreMs - a.bestScoreMs;
      }
      return a.bestScoreAt - b.bestScoreAt;
    });

    const bestScore = list[0].bestScoreMs;
    const winners = list.filter(item => item.bestScoreMs === bestScore).map(item => item.wallet);

    let txHash = null;
    if (contract) {
      const tx = await contract.finalizeCurrentRound(winners);
      const receipt = await tx.wait();
      txHash = receipt.hash;
    }

    // Round advanced on-chain; we also advance local round id
    currentRoundId += 1;

    res.json({ ok: true, winners, txHash });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "finalize_failed" });
  }
});

app.get("/", (req, res) => {
  res.send("HODL OR DIE backend up");
});

app.listen(PORT, () => {
  console.log("Backend listening on port", PORT);
});