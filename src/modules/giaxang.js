import axios from "axios";
import * as cheerio from "cheerio";
import { drawFuelPrice } from "../utils/canvasHelper.js";
import { uploadToTmpFiles } from "../utils/tmpFiles.js";
import fs from "node:fs";
import path from "node:path";
import { log } from "../logger.js";

export const name = "giaxang";
export const description = "Cập nhật giá xăng dầu hôm nay (Petrolimex)";

// ===== Giá xăng tĩnh fallback (cập nhật ngày 29/04/2026) =====
const STATIC_FUEL = {
    updateTime: "15:00 ngày 29/04/2026",
    items: [
        { name: "Xăng E5 RON 92", price: "20,393", change: "-893" },
        { name: "Xăng RON 95-III", price: "21,390", change: "-820" },
        { name: "Dầu Diesel 0.05S", price: "17,760", change: "-833" },
        { name: "Dầu hỏa", price: "17,042", change: "-762" },
        { name: "Dầu Mazut 180CST 3.5S", price: "16,230", change: "-570" },
    ]
};

/**
 * Scrape bài thông cáo điều hành giá mới nhất từ Petrolimex
 * Parse giá từ nội dung bài viết
 */
async function scrapePetrolimex() {
    // Lấy trang thông cáo để tìm bài mới nhất
    const listRes = await axios.get("https://petrolimex.com.vn/ndi/thong-cao-bao-chi.html", {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
            "Referer": "https://petrolimex.com.vn/"
        },
        timeout: 12000
    });

    const $list = cheerio.load(listRes.data);
    // Tìm link bài điều chỉnh giá xăng dầu mới nhất
    let articleUrl = null;
    $list("a").each((_, el) => {
        const href = $list(el).attr("href") || "";
        const text = $list(el).text();
        if (!articleUrl && (text.includes("điều chỉnh giá") || text.includes("dieu chinh gia")) && href.includes("petrolimex")) {
            articleUrl = href.startsWith("http") ? href : `https://petrolimex.com.vn${href}`;
        }
    });

    if (!articleUrl) throw new Error("Không tìm thấy bài điều chỉnh giá");

    const articleRes = await axios.get(articleUrl, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
            "Referer": "https://petrolimex.com.vn/"
        },
        timeout: 12000
    });

    const $a = cheerio.load(articleRes.data);
    const fullText = $a("body").text();

    // Parse thời gian hiệu lực
    const timeMatch = fullText.match(/(\d{1,2})\s*gi[ờo]\s*(\d{2})\s*ph[uú]t\s*ng[aà]y\s*(\d{2})[./](\d{2})[./](\d{4})/i);
    let updateTime = "";
    if (timeMatch) {
        updateTime = `${timeMatch[1]}:${timeMatch[2]} ngày ${timeMatch[3]}/${timeMatch[4]}/${timeMatch[5]}`;
    }

    // Parse giá từ bảng nếu có
    const fuelItems = [];
    $a("table tr").each((i, row) => {
        if (i === 0) return; // skip header
        const cols = $a(row).find("td");
        if (cols.length < 2) return;
        const nameRaw = $a(cols.eq(0)).text().trim() || $a(cols.eq(1)).text().trim();
        // Tìm ô có giá (số lớn > 10000)
        let priceStr = "", changeStr = "";
        cols.each((j, td) => {
            const t = $a(td).text().trim().replace(/[.\s]/g, "");
            const n = parseInt(t);
            if (!isNaN(n) && n > 10000 && n < 100000 && !priceStr) {
                priceStr = $a(td).text().trim();
            }
        });

        if (nameRaw && priceStr) {
            fuelItems.push({ name: nameRaw, price: priceStr, change: changeStr });
        }
    });

    // Nếu không parse được bảng, thử regex từ text
    if (fuelItems.length === 0) {
        const patterns = [
            /[Xx]ăng\s*E5\s*RON\s*92[^\d]*(\d[\d.,]+)/,
            /[Xx]ăng\s*RON\s*95[^\d]*(\d[\d.,]+)/,
            /[Dd][aầ]u\s*[Dd]iezel?[^\d]*(\d[\d.,]+)/i,
            /[Dd][aầ]u\s*h[oỏ]a[^\d]*(\d[\d.,]+)/i,
        ];
        const names = ["Xăng E5 RON 92", "Xăng RON 95-III", "Dầu Diesel 0.05S", "Dầu hỏa"];
        patterns.forEach((pat, i) => {
            const m = fullText.match(pat);
            if (m) fuelItems.push({ name: names[i], price: m[1], change: "" });
        });
    }

    if (fuelItems.length === 0) throw new Error("Không parse được giá từ bài viết");

    return { items: fuelItems, updateTime };
}

export const commands = {
    giaxang: async (ctx) => {
        const { api, threadId, threadType } = ctx;

        try {
            let fuelData = null;
            let source = "PETROLIMEX";

            // Thử scrape live
            try {
                fuelData = await scrapePetrolimex();
                log.info("[giaxang] Scraped live OK, items:", fuelData.items.length);
            } catch (scrapeErr) {
                log.warn("[giaxang] Scrape failed:", scrapeErr.message, "- dùng giá tĩnh");
                fuelData = STATIC_FUEL;
                source = "PETROLIMEX (cached)";
            }

            const buffer = await drawFuelPrice(fuelData.items, fuelData.updateTime, source);
            const tempPath = path.join(process.cwd(), `src/modules/cache/fuel_${Date.now()}.png`);
            if (!fs.existsSync(path.dirname(tempPath))) fs.mkdirSync(path.dirname(tempPath), { recursive: true });
            fs.writeFileSync(tempPath, buffer);

            const remoteUrl = await uploadToTmpFiles(tempPath, api, threadId, threadType);
            const statusMsg = `⛽ GIÁ XĂNG DẦU ${source.toUpperCase()}\n─────────────────\n🕒 ${fuelData.updateTime ? "Cập nhật: " + fuelData.updateTime : "Cập nhật hôm nay"}\n💡 Đơn vị: VNĐ/Lít`;

            if (remoteUrl) {
                await api.sendImageEnhanced({
                    imageUrl: remoteUrl,
                    threadId, threadType,
                    width: 820,
                    height: 140 + fuelData.items.length * 80 + 80,
                    msg: statusMsg
                });
            } else {
                await api.sendMessage({ msg: statusMsg, attachments: [tempPath] }, threadId, threadType);
            }

            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

        } catch (err) {
            log.error("[giaxang] Fatal error:", err.message);
            api.sendMessage({ msg: "⚠️ Lỗi khi lấy giá xăng dầu!" }, threadId, threadType);
        }
    }
};
