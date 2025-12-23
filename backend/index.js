// backend/index.js - SON HALİ (RPC Limit Fix + Anti-Cheat)
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

// Veritabanı Bağlantısı
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

if (!RPC_URL || !DATABASE_URL) {
  console.error("❌ Eksik Config: BASE_RPC_URL veya DATABASE_URL yok.");
  process.exit(1);
}

// Contract Address Doğrulama
let CONTRACT_ADDRESS;
try {
  CONTRACT_ADDRESS = ethers.getAddress(CONTRACT_ADDRESS_RAW);
} catch (e) {
  console.error("❌ Geçersiz Kontrat Adresi:", CONTRACT_ADDRESS_RAW);
  process.exit(1);
}

console.log("✅ Sistem Başlatılıyor...");
console.log("📍 Kontrat:", CONTRACT_ADDRESS);
console.log("💰 Hedef Pot:", THRESHOLD_ETH, "ETH");

// ---------------- ABIs ----------------

const CONTRACT_ABI = [
  "function getCurrentRoundInfo() view returns (uint256 id, uint256 pot, uint256 start, uint256 end, bool finalized)",
  "function finalizeRound(address winner) external",
  "event Joined(address indexed player, uint256 indexed roundId, uint256 amount)"
];

// ---------------- BLOCKCHAIN SETUP ----------------

const provider = new ethers.JsonRpcProvider(RPC_URL);
const readContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);

// Ödül dağıtımı için cüzdan (Opsiyonel)
let signer = null;
let writeContract = null;

if (process.env.BACKEND_WALLET_PRIVATE_KEY) {
  try {
    signer = new ethers.Wallet(process.env.BACKEND_WALLET_PRIVATE_KEY, provider);
    writeContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);
    console.log("✅ Backend Cüzdan Hazır:", signer.address);
  } catch (e) {
    console.error("❌ Cüzdan Hatası:", e.message);
  }
} else {
  console.warn("⚠️ UYARI: Private Key yok. Otomatik ödeme çalışmaz.");
}

// ---------------- HELPERS (YARDIMCILAR) ----------------

// KULLANICI PARAYI ÖDEMİŞ Mİ? (DÜZELTİLMİŞ VERSİYON)
async function hasUserPaid(roundId, walletAddress) {
    try {
        console.log(`🔍 Ödeme Kontrol: ${walletAddress} (Round: ${roundId})`);
        
        const formattedWallet = ethers.getAddress(walletAddress);
        const filter = readContract.filters.Joined(formattedWallet, roundId);
        
        // --- DÜZELTME BURADA ---
        // Hatayı önlemek için "0" yerine "-40000" (Son 40bin blok ~ 22 saat) kullanıyoruz.
        // Base ağında bloklar hızlı olduğu için 40-50bin güvenli bir aralıktır.
        const startBlock = -40000; 
        
        const events = await readContract.queryFilter(filter, startBlock);
        
        console.log(`🧾 Bulunan Makbuz: ${events.length}`);
        return events.length > 0;
    } catch (e) {
        console.error("❌ Payment check error:", e.message);
        // Hata durumunda (RPC çok yoğunsa vb.) false dönerek güvenliği sağla
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

// RAM Cache (Round kapandı mı?)
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

    console.log("⏳ Finalize işlemi gönderiliyor...");
    const tx = await writeContract.finalizeRound(winner);
    console.log("✅ Tx Hash:", tx.hash);
    
    await tx.wait();
    roundsMeta[roundId] = { closed: true, winner, potEth };

  } catch (e) {
    console.error("❌ CheckThreshold Hatası:", e.message);
  }
}

// ---------------- EXPRESS APP ----------------

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

// 1. OYUN BAŞLAT (Anti-Cheat: Zaman Başlatıcı)
app.post("/api/start-game", async (req, res) => {
    try {
        const { wallet, roundId } = req.body;
        
        if (!wallet || !roundId) return res.status(400).json({ error: "Missing data" });

        // Ödeme Kontrolü
        const isPaid = await hasUserPaid(roundId, wallet);
        if (!isPaid) {
            console.log(`⛔ Ödeme bulunamadı: ${wallet}`);
            return res.status(403).json({ error: "Entry fee required (Payment not found in recent blocks)" });
        }

        // Oturum Oluştur
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

// 2. SKOR GÖNDER (Anti-Cheat: Zaman Doğrulayıcı)
app.post("/api/submit-score", async (req, res) => {
    try {
        const { roundId, wallet, scoreMs, sessionId } = req.body;

        if (!wallet || !sessionId) return res.status(400).json({ error: "Missing parameters" });

        // Oturumu Çek
        const sessionRes = await pool.query(
            `SELECT * FROM active_sessions WHERE wallet_address = $1`, 
            [wallet]
        );

        if (sessionRes.rows.length === 0) {
            return res.status(400).json({ error: "Session not found. Refresh page." });
        }

        const session = sessionRes.rows[0];

        // Session ID Kontrol
        if (session.session_id !== sessionId) {
            return res.status(403).json({ error: "Invalid session ID." });
        }

        // ZAMAN HİLESİ KONTROLÜ
        const serverEndTime = Date.now();
        const startTime = Number(session.start_time);
        const maxPossibleScore = serverEndTime - startTime;
        const BUFFER_MS = 4000; // 4 saniye tolerans

        if (Number(scoreMs) > (maxPossibleScore + BUFFER_MS)) {
            console.log(`🚨 CHEAT DETECTED: ${wallet} (Claimed: ${scoreMs}, Real: ${maxPossibleScore})`);
            await pool.query(`DELETE FROM active_sessions WHERE wallet_address = $1`, [wallet]);
            return res.status(403).json({ error: "Time verification failed." });
        }

        // Skoru Kaydet
        const row = await upsertScore({
            roundId,
            wallet,
            scoreMs: Number(scoreMs)
        });

        // Oturumu Temizle
        await pool.query(`DELETE FROM active_sessions WHERE wallet_address = $1`, [wallet]);
        
        // Pot Kontrol
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

// 3. LEADERBOARD
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

// GENEL DURUM
app.get("/", async (req, res) => {
    try {
        const info = await readContract.getCurrentRoundInfo();
        res.json({
            ok: true,
            status: "Backend Running",
            onchainRoundId: Number(info.id),
            potEth: ethers.formatEther(info.pot),
            contract: CONTRACT_ADDRESS
        });
    } catch (e) {
        res.json({ ok: true, status: "Backend Running (RPC Error)", error: e.message });
    }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});