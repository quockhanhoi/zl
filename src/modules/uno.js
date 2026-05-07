import { writeFileSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import path from "node:path";
import { createCanvas, registerFont, loadImage } from "canvas";
import { log } from "../logger.js";

// Re-register fonts locally if needed, though they usually stay in memory
const fontPath = path.join(process.cwd(), "src/modules/cache/BeVietnamPro-Bold.ttf");
try {
    registerFont(fontPath, { family: "BeVietnamProBold" });
} catch (e) {}

function drawRoundRect(ctx, x, y, width, height, radius) {
    if (radius === undefined) radius = 0;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

/**
 * UNO GAME CANVAS FUNCTIONS
 */

async function drawUnoBoard({ currentCard, players, turnIdx, deckCount, hand }) {
    const width = 1000;
    const height = 1200;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // 1. Background (Premium Dark Gradient)
    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, "#1a1a2e");
    bg.addColorStop(1, "#16213e");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    // Decorative Blur
    ctx.globalAlpha = 0.3;
    const cardColorHex = getUnoColor(currentCard?.color || "Wild");
    ctx.fillStyle = cardColorHex;
    ctx.beginPath(); ctx.arc(width / 2, height / 2 - 100, 300, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1.0;

    // 2. Header
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 60px BeVietnamProBold, Sans";
    ctx.fillText("UNO ONLINE", width / 2, 80);

    // Draw Deck Info
    ctx.font = "bold 24px BeVietnamPro, Sans";
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.fillText(`CÒN LẠI: ${deckCount} LÁ`, width / 2, 120);

    // 3. Center: Current Card (Pile Top)
    const cardW = 160;
    const cardH = 240;
    const centerX = width / 2 - cardW / 2;
    const centerY = height / 2 - cardH / 2 - 100;

    // Draw Pile Glow
    ctx.shadowColor = cardColorHex;
    ctx.shadowBlur = 40;
    drawUnoCardIcon(ctx, centerX, centerY, cardW, cardH, currentCard, true);
    ctx.shadowBlur = 0;

    // Label: "LÁ HIỆN TẠI"
    ctx.fillStyle = "#fff";
    ctx.font = "bold 22px BeVietnamPro, Sans";
    ctx.fillText("BÀN CHƠI", width / 2, centerY - 30);

    // 4. Players Info list (Circular or Side)
    const playerBoxY = 650;
    const itemW = 280;
    const itemH = 100;
    const gapX = 30;
    const gapY = 20;

    players.forEach((p, i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        const x = 50 + col * (itemW + gapX);
        const y = playerBoxY + row * (itemH + gapY);
        const isTurn = i === turnIdx;

        // Player Card
        ctx.fillStyle = isTurn ? "rgba(255, 255, 255, 0.2)" : "rgba(255, 255, 255, 0.05)";
        drawRoundRect(ctx, x, y, itemW, itemH, 20);
        ctx.fill();
        if (isTurn) {
            ctx.strokeStyle = "#fbbf24";
            ctx.lineWidth = 3;
            ctx.stroke();
            
            // Turn Indicator
            ctx.fillStyle = "#fbbf24";
            ctx.beginPath();
            ctx.arc(x + 25, y + 25, 8, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.textAlign = "left";
        ctx.fillStyle = "#fff";
        ctx.font = "bold 20px BeVietnamProBold, Sans";
        let name = p.name || "Player";
        if (name.length > 15) name = name.substring(0, 13) + "...";
        const txY = y + 40;
        ctx.fillText(name, x + 45, txY);

        ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
        ctx.font = "18px BeVietnamPro, Sans";
        ctx.fillText(`${p.handSize} Lá bài`, x + 45, y + 75);
    });

    // 5. User's Hand (Bottom Section)
    if (hand && hand.length > 0) {
        ctx.textAlign = "center";
        ctx.fillStyle = "#fff";
        ctx.font = "bold 26px BeVietnamProBold, Sans";
        ctx.fillText("BÀI CỦA BẠN", width / 2, 920);

        const handCardW = 100;
        const handCardH = 150;
        const totalW = hand.length * (handCardW + 15) - 15;
        let startX = (width - totalW) / 2;
        if (startX < 20) startX = 20; // Basic Clamp

        hand.forEach((card, i) => {
            const x = startX + i * (handCardW + 15);
            const y = 950;
            if (x + handCardW > width) return; // Clip overflow

            drawUnoCardIcon(ctx, x, y, handCardW, handCardH, card);
            
            // Index Number
            ctx.fillStyle = "rgba(0,0,0,0.5)";
            ctx.beginPath(); ctx.arc(x + 20, y + 20, 15, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = "#fff";
            ctx.font = "bold 14px Arial";
            ctx.fillText(i + 1, x + 20, y + 25);
        });
    }

    // Footer
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
    ctx.font = "bold 18px BeVietnamPro, Sans";
    ctx.fillText("PHẢN HỒI SỐ ĐỂ ĐÁNH  •  GÕ 'B' ĐỂ BỐC BÀI", width / 2, height - 30);

    return canvas.toBuffer("image/png");
}

async function drawUnoHelp() {
    const width = 800;
    const height = 900;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // Background
    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, "#2c3e50");
    bg.addColorStop(1, "#000000");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 70px BeVietnamProBold, Sans";
    ctx.fillText("HƯỚNG DẪN UNO", width / 2, 100);

    const rules = [
        "1. Tham gia: `-uno join`.",
        "2. Bắt đầu: `-uno start` (ít nhất 2 người).",
        "3. Đánh: Khớp MÀU hoặc SỐ.",
        "4. Bốc bài: Gõ 'b' hoặc 'bốc'.",
        "5. +2 (Draw 2): Người kế tiếp bốc 2 & mất lượt.",
        "6. Reverse: Đảo chiều vòng xoay.",
        "7. Skip: Người kế tiếp mất lượt.",
        "8. Wild / +4: Đổi màu bài.",
        "9. Thắng: Người đầu tiên hết bài!"
    ];

    ctx.textAlign = "left";
    ctx.font = "24px BeVietnamPro, Sans";
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    rules.forEach((rule, i) => {
        ctx.fillText(rule, 100, 200 + i * 50);
    });

    drawUnoCardIcon(ctx, width / 2 - 60, 680, 120, 180, { color: "Red", value: "7" });

    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
    ctx.font = "bold 16px BeVietnamPro, Sans";
    ctx.fillText("POWERED BY ZALO BOT • DGK SYSTEM", width / 2, height - 30);

    return canvas.toBuffer("image/png");
}

function getUnoColor(color) {
    switch (color) {
        case "Red": return "#ff4757";
        case "Blue": return "#1e90ff";
        case "Green": return "#2ed573";
        case "Yellow": return "#eccc68";
        default: return "#2f3542";
    }
}

function drawUnoCardIcon(ctx, x, y, w, h, card, large = false) {
    const colorCode = getUnoColor(card?.color);
    const value = card?.value || "?";
    ctx.fillStyle = "#ffffff";
    drawRoundRect(ctx, x, y, w, h, 15);
    ctx.fill();
    ctx.fillStyle = colorCode;
    drawRoundRect(ctx, x + 8, y + 8, w - 16, h - 16, 12);
    ctx.fill();
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(-Math.PI / 6);
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.beginPath();
    ctx.ellipse(0, 0, w * 0.35, h * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${large ? 80 : 40}px BeVietnamProBold, Arial`;
    let disp = value;
    if (value === "Draw2") disp = "+2";
    if (value === "WildDraw4") disp = "+4";
    if (value === "Skip") disp = "⊘";
    if (value === "Reverse") disp = "⇅";
    if (value === "Wild") disp = "❖";
    ctx.fillText(disp, x + w / 2, y + h / 2 + 5);
    ctx.font = `bold ${large ? 24 : 16}px BeVietnamProBold, Arial`;
    ctx.fillText(disp, x + 25, y + 25);
    ctx.fillText(disp, x + w - 25, y + h - 25);
}

export const name = "uno";
export const description = "Trò chơi bài Uno Online - Multiplayer";

if (!global._unoGame) global._unoGame = {};
if (!global._unoWait) global._unoWait = {};

const COLORS = ["Red", "Blue", "Green", "Yellow"];
const VALUES = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "Skip", "Reverse", "Draw2"];
const WILD_CARDS = ["Wild", "WildDraw4"];

class UnoEngine {
    constructor() {
        this.deck = this.createDeck();
        this.discardPile = [];
        this.currentPlayerIdx = 0;
        this.direction = 1; // 1 for clockwise, -1 for counter-clockwise
        this.currentCard = null;
        this.players = []; // { id, name, hand: [] }
    }

    createDeck() {
        let deck = [];
        for (const color of COLORS) {
            for (const value of VALUES) {
                deck.push({ color, value });
                if (value !== "0") deck.push({ color, value });
            }
        }
        for (let i = 0; i < 4; i++) {
            deck.push({ color: "Wild", value: "Wild" });
            deck.push({ color: "Wild", value: "WildDraw4" });
        }
        return this.shuffle(deck);
    }

    shuffle(deck) {
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        return deck;
    }

    deal(count) {
        return this.deck.splice(0, count);
    }

    draw() {
        if (this.deck.length === 0) {
            const top = this.discardPile.pop();
            this.deck = this.shuffle(this.discardPile);
            this.discardPile = [top];
        }
        return this.deck.pop();
    }

    start(players) {
        this.players = players.map(p => ({ ...p, hand: this.deal(7) }));
        this.currentCard = this.draw();
        // Skip wild cards on start if possible
        while (this.currentCard.color === "Wild") {
            this.deck.unshift(this.currentCard);
            this.currentCard = this.draw();
        }
        this.discardPile.push(this.currentCard);
    }

    canPlay(card) {
        if (card.color === "Wild") return true;
        return card.color === this.currentCard.color || card.value === this.currentCard.value;
    }

    play(playerIdx, cardIdx, wildColor = null) {
        const player = this.players[playerIdx];
        const card = player.hand[cardIdx];

        if (!this.canPlay(card)) return { success: false, msg: "Lá bài không hợp lệ!" };

        player.hand.splice(cardIdx, 1);
        this.discardPile.push(card);
        this.currentCard = { ...card };
        if (wildColor) this.currentCard.color = wildColor;

        // Apply effects
        let skipNext = false;
        let drawNext = 0;

        if (card.value === "Skip") skipNext = true;
        else if (card.value === "Reverse") {
            if (this.players.length === 2) skipNext = true;
            else this.direction *= -1;
        } else if (card.value === "Draw2") drawNext = 2;
        else if (card.value === "WildDraw4") drawNext = 4;

        const win = player.hand.length === 0;
        let score = 0;
        if (win) {
            // Calculate score from other players' hands according to GameVui rules
            this.players.forEach(p => {
                if (p.id !== player.id) {
                    p.hand.forEach(c => {
                        if (c.color === "Wild") score += 50;
                        else if (["Skip", "Reverse", "Draw2"].includes(c.value)) score += 20;
                        else score += parseInt(c.value) || 0;
                    });
                }
            });
        }
        
        // Move to next turn
        this.nextTurn();
        if (skipNext) this.nextTurn();
        if (drawNext > 0) {
            const nextP = this.players[this.currentPlayerIdx];
            for (let i = 0; i < drawNext; i++) nextP.hand.push(this.draw());
            this.nextTurn();
        }

        return { success: true, win, score, currentCard: this.currentCard };
    }

    nextTurn() {
        this.currentPlayerIdx = (this.currentPlayerIdx + this.direction + this.players.length) % this.players.length;
    }
}

export async function handle(ctx) {
    const { threadId, content, senderId, api, threadType } = ctx;
    const input = content?.toLowerCase().trim();
    if (!input) return false;

    if (global._unoGame[threadId]) {
        const game = global._unoGame[threadId];
        const currentPlayer = game.engine.players[game.engine.currentPlayerIdx];
        
        if (senderId !== currentPlayer.id) return false;

        if (input === "b" || input === "bốc" || input === "draw") {
            const card = game.engine.draw();
            currentPlayer.hand.push(card);
            
            let reply = `🃏 Bạn đã bốc thêm 1 lá: [${card.color} ${card.value}]`;
            if (game.engine.canPlay(card)) {
                reply += "\n👉 Lá này có thể đánh được! Phản hồi số để đánh hoặc nhắn gì đó để bỏ lượt.";
            } else {
                game.engine.nextTurn();
            }
            await api.sendMessage({ msg: reply }, threadId, threadType);
            await sendBoard(ctx, game);
            return true;
        }

        const num = parseInt(input);
        if (!isNaN(num) && num >= 1 && num <= currentPlayer.hand.length) {
            const cardIdx = num - 1;
            const card = currentPlayer.hand[cardIdx];
            
            let wildColor = null;
            if (card.color === "Wild") {
                // If it's a wild card, we need a color. For simplicity, we'll ask in the next step or just pick a random one if not provided.
                // But let's try to parse something like "1 red"
                const parts = content.split(/\s+/);
                if (parts.length > 1) {
                    const c = parts[1].charAt(0).toUpperCase() + parts[1].slice(1).toLowerCase();
                    if (COLORS.includes(c)) wildColor = c;
                }
                
                if (!wildColor) {
                    await api.sendMessage({ msg: "🌈 Vui lòng chọn màu sau số thứ tự (Ví dụ: 1 Red, 1 Blue, 1 Green, 1 Yellow)" }, threadId, threadType);
                    return true;
                }
            }

            const res = game.engine.play(game.engine.currentPlayerIdx, cardIdx, wildColor);
            if (!res.success) {
                await api.sendMessage({ msg: "⚠️ " + res.msg }, threadId, threadType);
                return true;
            }

            if (res.win) {
                await api.sendMessage({ msg: `🎊 CHÚC MỪNG! ${currentPlayer.name} đã giành chiến thắng! 🏆\n💎 Điểm thưởng: ${res.score} (Tổng giá trị bài đối thủ)` }, threadId, threadType);
                delete global._unoGame[threadId];
            } else {
                await sendBoard(ctx, game);
            }
            return true;
        }
    }
    return false;
}

async function sendBoard(ctx, game) {
    const { api, threadId, threadType } = ctx;
    const engine = game.engine;
    const currentPlayer = engine.players[engine.currentPlayerIdx];

    // Withdraw previous board
    if (game.lastMsgId) {
        api.undoMessage({ msgId: game.lastMsgId, cliMsgId: game.lastCliMsgId }, threadId, threadType).catch(() => {});
    }

    const buffer = await drawUnoBoard({
        currentCard: engine.currentCard,
        players: engine.players.map(p => ({ name: p.name, handSize: p.hand.length })),
        turnIdx: engine.currentPlayerIdx,
        deckCount: engine.deck.length,
        hand: currentPlayer.hand
    });

    const tmpPath = path.join(process.cwd(), `uno_${threadId}_${Date.now()}.png`);
    writeFileSync(tmpPath, buffer);

    const res = await api.sendMessage({
        msg: `🎮 [ UNO ONLINE ]\n─────────────────\n🔥 Lượt của: @tag\n👉 Đánh bài: Nhập số thứ tự\n👉 Bốc bài: Nhắn "bốc"\n👉 Hướng dẫn: -uno help`,
        mentions: [{ uid: currentPlayer.id, pos: 35, len: 4 }],
        attachments: [tmpPath]
    }, threadId, threadType);

    const att = res.attachment?.[0];
    const msg = res.message;
    game.lastMsgId = att?.msgId || att?.globalMsgId || msg?.msgId || msg?.globalMsgId || null;
    game.lastCliMsgId = att?.cliMsgId || msg?.cliMsgId || null;

    if (existsSync(tmpPath)) unlinkSync(tmpPath);
}

export const commands = {
    uno: async (ctx) => {
        const { api, threadId, threadType, args, senderId, senderName, prefix } = ctx;
        const input = args[0]?.toLowerCase();

        if (input === "help") {
            const buffer = await drawUnoHelp();
            const tmpPath = path.join(process.cwd(), `uno_help_${Date.now()}.png`);
            writeFileSync(tmpPath, buffer);
            await api.sendMessage({ msg: "📖 Hướng dẫn chơi Uno", attachments: [tmpPath] }, threadId, threadType);
            if (existsSync(tmpPath)) unlinkSync(tmpPath);
            return;
        }

        if (input === "stop") {
            if (global._unoGame[threadId]) {
                delete global._unoGame[threadId];
                return api.sendMessage({ msg: "⏹️ Đã dừng ván bài Uno." }, threadId, threadType);
            }
            return api.sendMessage({ msg: "⚠️ Không có ván bài nào đang diễn ra." }, threadId, threadType);
        }

        if (input === "join") {
            if (global._unoGame[threadId]) return api.sendMessage({ msg: "⚠️ Ván bài đang diễn ra rồi!" }, threadId, threadType);
            if (!global._unoWait[threadId]) global._unoWait[threadId] = [];
            if (global._unoWait[threadId].find(p => p.id === senderId)) return api.sendMessage({ msg: "⚠️ Bạn đã tham gia rồi." }, threadId, threadType);
            
            global._unoWait[threadId].push({ id: senderId, name: senderName });
            return api.sendMessage({ msg: `✅ ${senderName} đã tham gia! (Tổng: ${global._unoWait[threadId].length} người)\n👉 Gõ "${prefix}uno start" để bắt đầu.` }, threadId, threadType);
        }

        if (input === "start") {
            if (global._unoGame[threadId]) return api.sendMessage({ msg: "⚠️ Ván bài đang diễn ra rồi!" }, threadId, threadType);
            const players = global._unoWait[threadId] || [];
            if (players.length < 2) return api.sendMessage({ msg: "⚠️ Cần ít nhất 2 người để bắt đầu! Gõ \"-uno join\" để tham gia." }, threadId, threadType);

            const engine = new UnoEngine();
            engine.start(players);
            
            global._unoGame[threadId] = { engine, lastMsgId: null, lastCliMsgId: null };
            global._unoWait[threadId] = [];

            await api.sendMessage({ msg: "🚀 Ván bài UNO bắt đầu!" }, threadId, threadType);
            await sendBoard(ctx, global._unoGame[threadId]);
            return;
        }

        // Display Y8/GameVui links as requested
        const helpMsg = `🎮 [ UNO ONLINE ]\n─────────────────\n👉 ${prefix}uno join : Tham gia phòng\n👉 ${prefix}uno start : Bắt đầu ván\n👉 ${prefix}uno stop : Dừng ván bài\n👉 ${prefix}uno help : Xem hướng dẫn\n─────────────────\n🔗 Link GameVui: https://gamevui.vn/uno-online/game\n🔗 Link Y8: https://vi.y8.com/games/uno_online/mobile`;
        await api.sendMessage({ msg: helpMsg }, threadId, threadType);
    }
};
