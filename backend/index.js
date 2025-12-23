// backend/index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
const { Pool } = require("pg");
const { v4: uuidv4 } = require('uuid'); // Session ID için

// ---------------- CONFIG ----------------

const PORT = Number(process.env.PORT || 4000);
const ENTRY_FEE_ETH = Number(process.env.ENTRY_FEE_ETH || "0.0003");
const POT_MULTIPLIER = Number(process.env.POT_MULTIPLIER || "333");
const THRESHOLD_ETH = ENTRY_FEE_ETH * POT_MULTIPLIER;

const CONTRACT_ADDRESS_RAW = process.env.CONTRACT_ADDRESS || "0x0000000000000000000000000000000000000000";
const RPC_URL = process.env.BASE_RPC_URL || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

// Render + Neon Bağlantısı
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

if (!RPC_URL || !DATABASE_URL) {
  console.error("❌ Eksik Config: BASE_RPC_URL veya DATABASE_URL yok.");
  process.exit(1);
}

// Contract Address Normalize
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
// Sadece okuma işlemleri ve event kontrolü için contract instance
const readContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);

// Yazma işlemleri (Finalize) için signer
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
  console.warn("⚠️ UYARI: Private Key girilmemiş. Otomatik ödeme çalışmaz.");
}

// ---------------- HELPERS (GÜVENLİK & DB) ----------------

// KULLANICI PARAYI ÖDEMİŞ Mİ KONTROLÜ
async function hasUserPaid(roundId, walletAddress) {
    try {
        // Blockchain'den "Joined" eventlerini filtrele
        // Bu cüzdan, bu round ID için event yaymış mı?
        const filter = readContract.filters.Joined(walletAddress, roundId);
        
        // Son 10.000 bloğu taramak yerine genelde startBlock verilir ama
        // şimdilik basit queryFilter kullanıyoruz. RPC limitine takılırsa block range eklenmeli.
        const events = await readContract.queryFilter(filter);
        
        return events.length > 0;
    } catch (e) {
        console.error("Payment check error:", e);
        // Hata varsa güvenli mod: Reddet.
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

// ---------------- ROUND & POT LOGIC ----------------

// Basit RAM Cache (Round kapandı mı?)
const roundsMeta = {}; 

async function checkThresholdAndMaybeClose(roundId) {
  if (roundsMeta[roundId]?.closed) return;

  try {
    // 1. On-chain veriyi çek
    const info = await readContract.getCurrentRoundInfo();
    const potEth = Number(ethers.formatEther(info.pot));
    const onChainId = Number(info.id);

    console.log(`🔎 Pot Kontrol: Round #${roundId} (OnChain: #${onChainId}) - Pot: ${potEth} ETH`);

    // Pot hedefi tutmadıysa çık
    if (potEth < THRESHOLD_ETH) return;

    // 2. Kazananı DB'den bul
    const winnerRow = await getWinnerForRound(roundId);
    if (!winnerRow) {
      console.log(`⚠️ Pot doldu ama veritabanında skor yok!`);
      return;
    }

    const winner = winnerRow.wallet;
    console.log(`🏆 KAZANAN ADAYI: ${winner} (Skor: ${winnerRow.best_score_ms}ms)`);

    if (!writeContract) {
      console.warn("⚠️ Signer yok, finalizeRound çağrılamıyor.");
      return;
    }

    // 3. Finalize Transaction Gönder
    console.log("⏳ Finalize işlemi gönderiliyor...");
    const tx = await writeContract.finalizeRound(winner);
    console.log("✅ Tx Hash:", tx.hash);
    
    await tx.wait();
    console.log("✅ Round on-chain kapandı!");

    roundsMeta[roundId] = { closed: true, winner, potEth };

  } catch (e) {
    console.error("❌ CheckThreshold Hatası:", e.message);
  }
}

// ---------------- EXPRESS APP & ENDPOINTS ----------------

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

// 1. OYUN BAŞLAT (ZAMAN TUTUCU - START)
app.post("/api/start-game", async (req, res) => {
    try {
        const { wallet, roundId } = req.body;
        
        if (!wallet || !roundId) return res.status(400).json({ error: "Eksik bilgi" });

        // GÜVENLİK 1: Para ödemiş mi?
        const isPaid = await hasUserPaid(roundId, wallet);
        if (!isPaid) {
            console.log(`⛔ ${wallet} ödeme yapmadan oyuna girmeye çalıştı!`);
            return res.status(403).json({ error: "Lütfen önce oyuna giriş ücretini ödeyin." });
        }

        // GÜVENLİK 2: Oturum oluştur
        const sessionId = uuidv4();
        const serverStartTime = Date.now(); // Sunucu saati esastır

        await pool.query(
            `INSERT INTO active_sessions (wallet_address, session_id, start_time, round_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (wallet_address) 
             DO UPDATE SET session_id = $2, start_time = $3, round_id = $4`,
            [wallet, sessionId, serverStartTime, roundId]
        );

        console.log(`⏱️ START: ${wallet} (Round: ${roundId})`);
        res.json({ ok: true, sessionId });

    } catch (e) {
        console.error("Start Game Error:", e);
        res.status(500).json({ error: "Sunucu hatası" });
    }
});

// 2. SKOR GÖNDER (HİLE KONTROLÜ VE KAYIT)
app.post("/api/submit-score", async (req, res) => {
    try {
        const { roundId, wallet, scoreMs, sessionId } = req.body;

        if (!wallet || !sessionId) return res.status(400).json({ error: "Eksik parametre" });

        // A. Veritabanından oturumu çek
        const sessionRes = await pool.query(
            `SELECT * FROM active_sessions WHERE wallet_address = $1`, 
            [wallet]
        );

        if (sessionRes.rows.length === 0) {
            return res.status(400).json({ error: "Oturum bulunamadı. Lütfen sayfayı yenileyip tekrar deneyin." });
        }

        const session = sessionRes.rows[0];

        // B. Session ID Doğrulama
        if (session.session_id !== sessionId) {
            return res.status(403).json({ error: "Geçersiz oturum!" });
        }

        // C. ZAMAN HİLESİ KONTROLÜ (Anti-Cheat)
        const serverEndTime = Date.now();
        // Veritabanından gelen start_time string olabilir, Number'a çevir
        const startTime = Number(session.start_time);
        
        // Sunucuda geçen gerçek süre
        const maxPossibleScore = serverEndTime - startTime;
        
        // 3 saniyelik ağ gecikmesi toleransı (Buffer)
        const BUFFER_MS = 3000;

        if (Number(scoreMs) > (maxPossibleScore + BUFFER_MS)) {
            console.log(`🚨 HİLE TESPİTİ: ${wallet}`);
            console.log(`İddia: ${scoreMs}ms, Gerçek: ${maxPossibleScore}ms`);
            
            // Hileciyi oturumdan at
            await pool.query(`DELETE FROM active_sessions WHERE wallet_address = $1`, [wallet]);
            return res.status(403).json({ error: "Skor doğrulanamadı (Zaman uyumsuzluğu)." });
        }

        // D. Her şey temiz, skoru kaydet
        const row = await upsertScore({
            roundId,
            wallet,
            scoreMs: Number(scoreMs)
        });

        console.log(`✅ SKOR: ${wallet} -> ${scoreMs}ms`);

        // Oturumu sil (Tekrar kullanamasın)
        await pool.query(`DELETE FROM active_sessions WHERE wallet_address = $1`, [wallet]);

        // Pot kontrolü
        await checkThresholdAndMaybeClose(roundId);

        res.json({ 
            ok: true, 
            bestScoreMs: Number(row.best_score_ms),
            winner: roundsMeta[roundId]?.winner || null
        });

    } catch (e) {
        console.error("Submit Score Error:", e);
        res.status(500).json({ error: "Sunucu hatası" });
    }
});

// 3. LEADERBOARD
app.get("/api/leaderboard", async (req, res) => {
  try {
    let roundId = Number(req.query.roundId);
    if (!roundId) {
       // Onchain round id almayı dene, hata verirse 1 varsay
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
    console.error("Leaderboard Error:", e);
    res.status(500).json({ error: "Liste alınamadı" });
  }
});

// GENEL BİLGİ
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
        res.json({ ok: true, status: "Backend Running", contractError: e.message });
    }
});

// ---------------- START SERVER ----------------

app.listen(PORT, () => {
  console.log(`🚀 Server ${PORT} portunda çalışıyor.`);
});