import { createTaiXiuResultImage, createWaitingImage } from "../utils/taixiuCanvas.js";
import { bankManager } from "../utils/bankManager.js";
import fs from "node:fs";
import path from "node:path";
import { log } from "../logger.js";

const cachePath = path.join(process.cwd(), "src/modules/cache/taixiu_global.json");

// --- GLOBAL STATE ---
let gameState = {
    jackpot: 100000,
    history: [],
    timer: 60,
    status: "betting", // betting | processing
    bets: [], // array of { senderId, senderName, choice, amount, threadId, threadType }
    lastUpdate: Date.now()
};

const loadState = () => {
    try {
        if (fs.existsSync(cachePath)) {
            const data = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
            gameState.jackpot = data.jackpot || 100000;
            gameState.history = data.history || [];
        }
    } catch (e) { log.error("TX load error", e.message); }
};

const saveState = () => {
    try {
        const dir = path.dirname(cachePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify({
            jackpot: gameState.jackpot,
            history: gameState.history
        }, null, 2));
    } catch (e) {}
};

loadState();

// --- GAME LOOP ---
let gameLoopInterval = null;

export const init = (api) => {
    if (gameLoopInterval) return;
    log.system("Tài Xỉu Global Loop started.");
    gameLoopInterval = setInterval(async () => {
        gameState.timer--;

        if (gameState.timer <= 0) {
            if (gameState.status === "betting") {
                gameState.status = "processing";
                await handleEndSession(api);
                gameState.timer = 60;
                gameState.status = "betting";
            }
        }
    }, 1000);
};

async function handleEndSession(api) {
    // 1. Roll dices
    const dices = [Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1];
    const total = dices.reduce((a, b) => a + b, 0);
    const resultSide = total >= 11 ? "tai" : "xiu";
    const isJackpotAttempt = dices[0] === dices[1] && dices[1] === dices[2];

    const taiBetsTotal = gameState.bets.filter(b => b.choice === "tai").reduce((s, b) => s + b.amount, 0);
    const xiuBetsTotal = gameState.bets.filter(b => b.choice === "xiu").reduce((s, b) => s + b.amount, 0);

    // 2. Calculate winners
    let jackpotWinner = null;
    if (isJackpotAttempt) {
        // Find if anyone bet on the winning side during a jackpot roll
        const winnersOnSide = gameState.bets.filter(b => b.choice === resultSide);
        if (winnersOnSide.length > 0) {
            jackpotWinner = winnersOnSide[Math.floor(Math.random() * winnersOnSide.length)];
        }
    }

    const winnerInfo = [];
    gameState.bets.forEach(bet => {
        const won = bet.choice === resultSide;
        if (won) {
            let winAmount = bet.amount * 2;
            let bonus = 0;
            if (jackpotWinner && jackpotWinner.senderId === bet.senderId) {
                bonus = gameState.jackpot;
                gameState.jackpot = 100000; // reset jackpot
            }
            bankManager.add(bet.senderId, winAmount + bonus);
            winnerInfo.push({ ...bet, win: winAmount + bonus - bet.amount, isJP: bonus > 0 });
        } else {
            // Lost bet contributes to jackpot (10%)
            gameState.jackpot += Math.floor(bet.amount * 0.1);
        }
    });

    // 3. Create Result Image
    const jackpotData = jackpotWinner ? { isJackpot: true, amount: gameState.jackpot, winnerName: jackpotWinner.senderName } : null;
    const resultBuffer = await createTaiXiuResultImage({ dice: dices, total, result: resultSide }, taiBetsTotal, xiuBetsTotal, jackpotData);
    
    const tmpPath = path.join(process.cwd(), `src/modules/cache/tx_res_${Date.now()}.png`);
    fs.writeFileSync(tmpPath, resultBuffer);

    // 4. Send Result to active threads
    const activeThreads = [...new Set(gameState.bets.map(b => b.threadId))];
    for (const tid of activeThreads) {
        const betsInThread = gameState.bets.filter(b => b.threadId === tid);
        const winnersInThread = winnerInfo.filter(b => b.threadId === tid);
        
        let msg = `[ 🎲 TÀI XỈU LUXURY - KẾT QUẢ ]\n`;
        msg += `─────────────────\n`;
        msg += `🎲 Xúc xắc: ${dices.join(" - ")} ➜ ${total} điểm\n`;
        msg += `🌟 Kết quả: ${resultSide.toUpperCase()}\n`;
        
        if (winnersInThread.length > 0) {
            msg += `─────────────────\n`;
            msg += `🎉 Chúc mừng các đại gia thắng cược:\n`;
            winnersInThread.forEach(w => {
                msg += `• ${w.senderName}: +${w.win.toLocaleString()} xu${w.isJP ? " (NỔ HŨ 🎰)" : ""}\n`;
            });
        }
        msg += `─────────────────\n`;
        msg += `💰 Quỹ hũ hiện tại: ${gameState.jackpot.toLocaleString()} xu`;

        try {
            await api.sendMessage({ msg, attachment: fs.createReadStream(tmpPath) }, tid, betsInThread[0].threadType);
        } catch (e) {}
    }

    // 5. Cleanup session
    gameState.bets = [];
    gameState.history.push({ total, result: resultSide, dice: dices, time: Date.now() });
    if (gameState.history.length > 50) gameState.history.shift();
    saveState();
    
    setTimeout(() => { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); }, 10000);
}

export const name = "taixiu";
export const description = "Trò chơi Tài Xỉu Luxury - Global Edition";
export const version = "3.0.0";

export const commands = {
    taixiu: async (ctx) => {
        const { api, args, senderId, senderName, threadId, threadType, prefix } = ctx;
        initTaiXiu(api);

        if (args.length === 0) {
            const taiTotal = gameState.bets.filter(b => b.choice === "tai").reduce((s, b) => s + b.amount, 0);
            const xiuTotal = gameState.bets.filter(b => b.choice === "xiu").reduce((s, b) => s + b.amount, 0);
            
            const buffer = await createWaitingImage(gameState.timer, taiTotal, xiuTotal);
            const tmpPath = path.join(process.cwd(), `src/modules/cache/tx_wait_${Date.now()}.png`);
            fs.writeFileSync(tmpPath, buffer);

            let msg = `[ 🎲 TÀI XỈU LUXURY ]\n`;
            msg += `─────────────────\n`;
            msg += `⏳ Thời gian còn lại: ${gameState.timer}s\n`;
            msg += `🎰 Quỹ hũ: ${gameState.jackpot.toLocaleString()} xu\n`;
            msg += `🔴 Tổng Tài: ${taiTotal.toLocaleString()} xu\n`;
            msg += `🔵 Tổng Xỉu: ${xiuTotal.toLocaleString()} xu\n`;
            msg += `─────────────────\n`;
            msg += `👉 Cú pháp: ${prefix}tx [tai/xiu] [số tiền/all]`;

            await api.sendMessage({ msg, attachment: fs.createReadStream(tmpPath) }, threadId, threadType);
            setTimeout(() => { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); }, 5000);
            return;
        }

        if (args[0] === "status") {
            return api.sendMessage({ msg: `🎲 Trạng thái game: ${gameState.status === "betting" ? "Đang mở cược" : "Đang xử lý kết quả"} (${gameState.timer}s)` }, threadId, threadType);
        }

        const choice = args[0].toLowerCase();
        if (choice !== "tai" && choice !== "xiu") {
            return api.sendMessage({ msg: `⚠️ Vui lòng chọn 'tai' hoặc 'xiu'.\nVí dụ: ${prefix}tx tai 1000` }, threadId, threadType);
        }

        if (gameState.status !== "betting" || gameState.timer < 5) {
            return api.sendMessage({ msg: "⚠️ Hết thời gian đặt cược cho phiên này!" }, threadId, threadType);
        }

        let balance = bankManager.getBalance(senderId);
        let amount = 0;
        if (args[1]?.toLowerCase() === "all") amount = balance;
        else amount = parseInt(args[1]);

        if (isNaN(amount) || amount < 100) {
            return api.sendMessage({ msg: "⚠️ Mức cược tối thiểu là 100 xu." }, threadId, threadType);
        }

        if (amount > balance) {
            return api.sendMessage({ msg: `⚠️ Bạn không đủ xu (Số dư: ${balance.toLocaleString()} xu).` }, threadId, threadType);
        }

        // Check if already bet this session
        const existingBet = gameState.bets.find(b => b.senderId === senderId);
        if (existingBet) {
            if (existingBet.choice !== choice) {
                return api.sendMessage({ msg: `⚠️ Bạn đã đặt '${existingBet.choice.toUpperCase()}' rồi, không thể đặt ngược lại trong cùng một phiên!` }, threadId, threadType);
            }
            existingBet.amount += amount;
        } else {
            gameState.bets.push({ senderId, senderName, choice, amount, threadId, threadType });
        }

        bankManager.subtract(senderId, amount);
        
        return api.sendMessage({ msg: `✅ Đã đặt cược ${amount.toLocaleString()} xu vào ${choice.toUpperCase()}!` }, threadId, threadType);
    },
    
    tx: async (ctx) => commands.taixiu(ctx),

    soicau: async (ctx) => {
        const { api, threadId, threadType } = ctx;
        if (gameState.history.length === 0) return api.sendMessage({ msg: "⚠️ Hiện chưa có lịch sử phiên nào." }, threadId, threadType);
        
        let msg = `[ 📊 THỐNG KÊ CẦU TÀI XỈU ]\n`;
        msg += `─────────────────\n`;
        const last20 = gameState.history.slice(-20).reverse();
        last20.forEach((h, i) => {
            msg += `${h.result === "tai" ? "🔴" : "🔵"} Phiên ${gameState.history.length - i}: ${h.total} (${h.dice.join("-")})\n`;
        });
        msg += `─────────────────\n👉 Dự đoán phiên tiếp theo!`;
        return api.sendMessage({ msg }, threadId, threadType);
    },

    topxu: async (ctx) => {
        const { api, threadId, threadType } = ctx;
        bankManager.load();
        const top = Object.entries(bankManager._data)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        let msg = `[ 🏆 TOP PHÚ HỘ XU ]\n`;
        msg += `─────────────────\n`;
        top.forEach(([uid, bal], i) => {
            msg += `${i + 1}. UID ${uid.slice(-5)}: ${bal.toLocaleString()} xu\n`;
        });
        msg += `─────────────────\n👉 Hãy chơi ${ctx.prefix}tx để làm giàu!`;
        return api.sendMessage({ msg }, threadId, threadType);
    }
};
