import axios from "axios";
import * as cheerio from "cheerio";
import { createCanvas, loadImage } from "canvas";
import fs from "node:fs";
import path from "node:path";
import { log } from "../logger.js";
import { protectionManager } from "../utils/protectionManager.js";

export const name = "phatnguoi";
export const description = "Tra cứu phạt nguội xe theo biển số";

// ===================== SETTINGS =====================
const settingsPath = path.join(process.cwd(), "src", "modules", "cache", "phatnguoi_settings.json");

const pnSettings = {
    _data: null,
    load() {
        try {
            if (fs.existsSync(settingsPath)) {
                this._data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
            } else {
                this._data = {};
                this.save();
            }
        } catch (e) {
            log.error("[phatnguoi] Lỗi load settings:", e.message);
            this._data = {};
        }
    },
    save() {
        try {
            fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
            fs.writeFileSync(settingsPath, JSON.stringify(this._data, null, 2), "utf-8");
        } catch (e) {
            log.error("[phatnguoi] Lỗi save settings:", e.message);
        }
    },
    isEnabled(threadId) {
        if (!this._data) this.load();
        return this._data?.[threadId] === true;
    },
    setEnabled(threadId, val) {
        if (!this._data) this.load();
        this._data[threadId] = val;
        this.save();
    }
};

// ===================== VEHICLE TYPES =====================
const VEHICLE_TYPES = [
    { code: "1", name: "ô tô" },
    { code: "2", name: "xe tải" },
    { code: "3", name: "xe máy" },
    { code: "4", name: "xe máy điện" }
];

// ===================== CANVAS MENU =====================
const cacheDir = path.join(process.cwd(), "src", "modules", "cache");

async function drawPhatNguoiMenu(userName, botName = "DGK Bot") {
    const W = 1280, H = 380;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");

    // ── Background gradient (dark premium) ──
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, "#0f172a");
    bg.addColorStop(0.5, "#1e293b");
    bg.addColorStop(1, "#0f172a");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Accent blob
    ctx.save();
    ctx.globalAlpha = 0.25;
    const blob = ctx.createRadialGradient(W * 0.2, H * 0.3, 10, W * 0.2, H * 0.3, 300);
    blob.addColorStop(0, "#ef4444");
    blob.addColorStop(1, "transparent");
    ctx.fillStyle = blob;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // ── Rounded card ──
    const BOX_COLORS = [
        "rgba(255,20,147,0.35)",
        "rgba(128,0,128,0.35)",
        "rgba(0,100,0,0.35)",
        "rgba(0,0,139,0.35)",
        "rgba(184,134,11,0.35)",
        "rgba(138,3,3,0.35)",
        "rgba(0,0,0,0.45)"
    ];
    const boxColor = BOX_COLORS[Math.floor(Math.random() * BOX_COLORS.length)];

    const bx = 40, by = 30, bw = W - 80, bh = H - 60, br = 35;
    ctx.beginPath();
    ctx.moveTo(bx + br, by);
    ctx.lineTo(bx + bw - br, by);
    ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + br);
    ctx.lineTo(bx + bw, by + bh - br);
    ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - br, by + bh);
    ctx.lineTo(bx + br, by + bh);
    ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - br);
    ctx.lineTo(bx, by + br);
    ctx.quadraticCurveTo(bx, by, bx + br, by);
    ctx.closePath();
    ctx.fillStyle = boxColor;
    ctx.fill();

    // Stroke glow
    ctx.strokeStyle = "rgba(239,68,68,0.6)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // ── Car icon (right) ──
    ctx.font = "160px 'NotoEmoji'";
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.textAlign = "right";
    ctx.fillText("🚗", bx + bw - 30, by + bh - 20);

    // ── Time top-right ──
    const vn = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" });
    const hour = new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh", hour: "numeric", hour12: false });
    const timeIcon = (parseInt(hour) >= 6 && parseInt(hour) < 18) ? "🌤️" : "🌙";
    ctx.font = "bold 28px 'BeVietnamProBold', Arial";
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.textAlign = "right";
    ctx.fillText(`${timeIcon} ${vn}`, bx + bw - 20, by + 45);

    // ── Text lines ──
    ctx.textAlign = "left";
    const startX = bx + 50;
    const lines = [
        { text: `Xin chào, ${userName}`, size: 48, color: "#f87171", bold: true },
        { text: "💞 Chào mừng đến menu 🚗 Phạt Nguội", size: 34, color: "#fbbf24", bold: false },
        { text: "!phatnguoi [biển số]: Tra cứu vi phạm", size: 30, color: "rgba(255,255,255,0.85)", bold: false },
        { text: "!phatnguoi on/off: Bật/Tắt trong nhóm", size: 28, color: "rgba(255,255,255,0.7)", bold: false },
        { text: `🤖 Bot: ${botName}  •  DGK System`, size: 24, color: "rgba(255,255,255,0.5)", bold: false },
    ];

    let y = by + 95;
    for (const ln of lines) {
        ctx.font = `${ln.bold ? "bold " : ""}${ln.size}px 'BeVietnamProBold', Arial`;
        ctx.fillStyle = ln.color;
        ctx.fillText(ln.text, startX, y);
        y += ln.size + 18;
    }

    // ── Divider line ──
    ctx.strokeStyle = "rgba(239,68,68,0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx + 40, by + 90);
    ctx.lineTo(bx + bw * 0.65, by + 90);
    ctx.stroke();

    // ── Footer branding ──
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.font = "bold 16px 'BeVietnamPro', Arial";
    ctx.fillText("POWERED BY DGK SYSTEM • ZALO BOT PHẠT NGUỘI", W / 2, H - 15);

    return canvas.toBuffer("image/png");
}

// ===================== SCRAPER =====================
async function lookupViolations(plateNumber) {
    const url = "https://phatnguoixe.com/1026";
    const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    };

    let foundVehicle = null;
    const violations = [];

    for (const vt of VEHICLE_TYPES) {
        try {
            const resp = await axios.post(url, `BienSo=${encodeURIComponent(plateNumber)}&LoaiXe=${vt.code}`, {
                headers: {
                    ...headers,
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                timeout: 10000,
                maxRedirects: 0,
                validateStatus: (s) => s === 200 || s === 302
            });

            if (resp.status === 302) continue;
            if (resp.status !== 200) continue;

            const $ = cheerio.load(resp.data);

            // Check "không tìm thấy"
            const noViolation = $("h3").filter((_, el) =>
                $(el).text().includes("Không tìm thấy vi phạm")
            ).length > 0;
            if (noViolation) continue;

            foundVehicle = vt.name;

            $("table.css_table").each((_, table) => {
                const info = {};
                $(table).find("tr").each((_, row) => {
                    const cells = $(row).find("td");
                    if (cells.length === 2) {
                        const key = $(cells[0]).text().trim();
                        const val = $(cells[1]).text().trim();
                        if (key) info[key] = val;
                    }
                });

                // Nơi giải quyết (colspan=2)
                const places = [];
                $(table).find("td[colspan='2']").each((_, td) => {
                    const t = $(td).text().trim();
                    if (t) places.push(t);
                });
                if (places.length > 0) info["Nơi giải quyết"] = places.join(" | ");

                if (Object.keys(info).length > 0) violations.push(info);
            });

            break; // Tìm thấy rồi, stop
        } catch (e) {
            log.warn(`[phatnguoi] Lỗi request vehicle ${vt.name}:`, e.message);
        }
    }

    return { foundVehicle, violations };
}

// ===================== HELPER =====================
async function getDisplayName(api, uid) {
    try {
        const info = await api.getUserInfo([uid]);
        const p = info?.changed_profiles?.[uid] || info?.[uid] || info || {};
        return p.displayName || p.zaloName || p.name || `User_${uid}`;
    } catch {
        return `User_${uid}`;
    }
}

// ===================== COMMANDS =====================
export const commands = {

    phatnguoi: async (ctx) => {
        const { api, args, threadId, threadType, senderId, isGroup, message, adminIds } = ctx;

        const arg0 = (args[0] || "").toLowerCase();

        // ── on/off ──
        if (arg0 === "on" || arg0 === "off") {
            if (!adminIds.includes(String(senderId))) {
                return api.sendMessage({ msg: "⚠️ Bạn không phải admin bot!", quote: message }, threadId, threadType);
            }
            const enable = arg0 === "on";
            pnSettings.setEnabled(threadId, enable);
            return api.sendMessage({
                msg: enable
                    ? `🚦 Lệnh !phatnguoi đã được Bật 🚀 trong nhóm này ✅`
                    : `🚦 Lệnh !phatnguoi đã Tắt ⭕ trong nhóm này ✅`,
                quote: message
            }, threadId, threadType);
        }

        // ── Kiểm tra feature có được bật không (chỉ trong group) ──
        if (isGroup && !pnSettings.isEnabled(threadId)) {
            return; // Tính năng chưa bật, bỏ qua
        }

        // ── Menu (không có args) ──
        if (!arg0) {
            try {
                const userName = await getDisplayName(api, senderId);
                const buf = await drawPhatNguoiMenu(userName);
                const tmpPath = path.join(cacheDir, `phatnguoi_menu_${Date.now()}.png`);
                fs.mkdirSync(cacheDir, { recursive: true });
                fs.writeFileSync(tmpPath, buf);

                const menuText =
                    `🚦 ${userName}\n` +
                    `➜ !phatnguoi [biển số]: Tra cứu thông tin phạt nguội\n` +
                    `📌 Bot tự nhận diện loại xe (ô tô, xe tải, xe máy, xe máy điện)\n` +
                    `VD: !phatnguoi 60K-36752\n` +
                    `🤖 BOT luôn sẵn sàng phục vụ bạn! 🌸`;

                await api.sendMessage({
                    msg: menuText,
                    attachments: [tmpPath],
                    quote: message
                }, threadId, threadType);

                if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
            } catch (e) {
                log.error("[phatnguoi] Lỗi vẽ menu:", e.message);
                api.sendMessage({ msg: "⚠️ Lỗi tạo ảnh menu!", quote: message }, threadId, threadType);
            }
            return;
        }

        // ── Tra cứu biển số ──
        const plateRaw = args[0].toUpperCase();
        const userName = await getDisplayName(api, senderId);

        // Thông báo đang tra
        await api.sendMessage({
            msg: `🔍 Đang tra cứu biển số **${plateRaw}**, vui lòng chờ...`,
            quote: message
        }, threadId, threadType);

        try {
            const { foundVehicle, violations } = await lookupViolations(plateRaw);

            if (!foundVehicle) {
                return api.sendMessage({
                    msg: `✅ ${userName}, không tìm thấy vi phạm nào cho biển số ${plateRaw}.`,
                    quote: message
                }, threadId, threadType);
            }

            if (violations.length === 0) {
                return api.sendMessage({
                    msg: `✅ ${userName}, không tìm thấy vi phạm nào cho biển số ${plateRaw} (${foundVehicle}).`,
                    quote: message
                }, threadId, threadType);
            }

            for (let i = 0; i < violations.length; i++) {
                const v = violations[i];
                const details = Object.entries(v).map(([k, val]) => `• ${k}: ${val}`).join("\n");
                const msg =
                    `🚨 VI PHẠM ${i + 1}/${violations.length} — ${plateRaw} (${foundVehicle})\n` +
                    `─────────────────\n` +
                    `${details}\n` +
                    `─────────────────`;
                await api.sendMessage({ msg, quote: message }, threadId, threadType);
            }

        } catch (e) {
            log.error("[phatnguoi] Lỗi tra cứu:", e.message);
            api.sendMessage({ msg: "🐞 Đã xảy ra lỗi khi tra cứu! Vui lòng thử lại.", quote: message }, threadId, threadType);
        }
    }
};
