import { log } from "../logger.js";
import { uploadFromUrl, uploadFromFile as uploadToGDrive } from "../utils/googleDrive.js";
import { fetchVideosByYtDlp, downloadFile, deleteFile } from "../utils/util.js";
import { downloadTikTok } from "../utils/tiktokDownloader.js";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";

export const name = "api";
export const description = "Bộ công cụ upload GDrive và quét TikTok Bulk";

const CACHE_DIR = path.join(process.cwd(), "src/modules/cache");
const HISTORY_FILE = path.join(CACHE_DIR, "tiktok_history.json");

function loadHistory() {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    } catch (e) {
        return [];
    }
}

function saveHistory(history) {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function saveToDatabase(category, links) {
    const dbPath = path.join(CACHE_DIR, `${category.toLowerCase()}.json`);
    let data = [];
    if (fs.existsSync(dbPath)) {
        try {
            data = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
        } catch (e) {
            data = [];
        }
    }
    if (!Array.isArray(data)) data = [];
    const newData = [...new Set([...data, ...links])];
    fs.writeFileSync(dbPath, JSON.stringify(newData, null, 2));
    return newData.length;
}

function extractUrlFromQuote(quote) {
    if (!quote) return null;
    try {
        const urlRegex = /(https?:\/\/[^\s"'<>]+)/g;

        // 1. Check in attach (Zalo specific for videos/files)
        if (quote.attach) {
            try {
                const attach = typeof quote.attach === "string" ? JSON.parse(quote.attach) : quote.attach;
                if (attach.href) return attach.href;
                if (attach.params) {
                    const params = typeof attach.params === "string" ? JSON.parse(attach.params) : attach.params;
                    if (params.videoUrl) return params.videoUrl;
                    if (params.url) return params.url;
                }
            } catch (e) {
                // If attach is not JSON, check it with regex below
            }
        }

        // 2. Check in all text fields using regex
        const targets = [quote.content, quote.attach, quote.desc, quote.title, quote.href, quote.msg];
        for (const t of targets) {
            if (typeof t === "string") {
                const match = t.match(urlRegex);
                if (match) {
                    // Remove backslashes (Zalo escape) but DO NOT split '?' because GDrive links need it
                    return match[0].replace(/\\/g, "");
                }
            }
        }
    } catch (e) {
        log.error("extractUrlFromQuote error:", e.message);
    }
    return null;
}

export const commands = {
    api: async (ctx) => {
        const { api, message, args, threadId, threadType, prefix } = ctx;
        const subCommand = args[0]?.toLowerCase().trim();

        // [ 1. LỆNH API GET - QUÉT BULK TIKTOK ]
        if (subCommand === "get") {
            const userId = args[1];
            const limit = parseInt(args[2]) || 5;
            const filterType = args[3]?.toLowerCase();
            const category = args[4]?.toLowerCase();

            if (!userId || !filterType || !category) {
                return api.sendMessage({ msg: `⚠️ Sai cú pháp! VD: ${prefix}api get [user] 10 [img/video] [kho]` }, threadId, threadType);
            }

            const waitMsg = await api.sendMessage({ msg: `⏳ Đang quét lọc ${filterType.toUpperCase()} của @${userId}...` }, threadId, threadType);

            try {
                const data = await fetchVideosByYtDlp(userId, limit);
                if (!data.success || !data.videos || data.videos.length === 0) {
                    return api.sendMessage({ msg: `⚠️ Lỗi quét: ${data.error || "No data"}` }, threadId, threadType);
                }

                const history = loadHistory();
                const processedPosts = [];
                let totalNewLinks = 0;
                let dupCount = 0;
                let skipCount = 0;

                const postsToProcess = data.videos.filter(v => {
                    if (history.includes(v.video_id)) {
                        dupCount++;
                        return false;
                    }
                    return true;
                });

                if (postsToProcess.length === 0) {
                    await api.deleteMessage(waitMsg.messageId, threadId).catch(() => { });
                    return api.sendMessage({ msg: `📢 Không có gì mới từ @${userId}. (Bỏ qua ${dupCount} video cũ)` }, threadId, threadType);
                }

                for (let i = 0; i < postsToProcess.length; i++) {
                    const post = postsToProcess[i];
                    const vUrl = `https://www.tiktok.com/@${userId}/video/${post.video_id}`;

                    try {
                        const snap = await downloadTikTok(vUrl);
                        if (!snap) continue;

                        const isImg = snap.images && snap.images.length > 0;
                        if ((filterType === "img" && !isImg) || (filterType === "video" && isImg)) {
                            skipCount++;
                            continue;
                        }

                        let links = [];
                        if (isImg) {
                            for (let j = 0; j < snap.images.length; j++) {
                                const tPath = path.join(process.cwd(), `temp_${Date.now()}_${j}.jpg`);
                                await downloadFile(snap.images[j], tPath);
                                const gLink = await uploadToGDrive(tPath);
                                if (gLink) links.push(gLink);
                                deleteFile(tPath);
                            }
                        } else if (snap.videoUrl) {
                            const tPath = path.join(process.cwd(), `temp_${Date.now()}.mp4`);
                            await downloadFile(snap.videoUrl, tPath);
                            const gLink = await uploadToGDrive(tPath);
                            if (gLink) links.push(gLink);
                            deleteFile(tPath);
                        }

                        if (links.length > 0) {
                            saveToDatabase(category, links);
                            totalNewLinks += links.length;
                            history.push(post.video_id);
                            processedPosts.push(post.video_id);
                        }
                    } catch (err) { log.error(err.message); }
                }

                saveHistory(history);
                await api.deleteMessage(waitMsg.messageId, threadId).catch(() => { });

                const totalInDb = fs.existsSync(path.join(CACHE_DIR, `${category}.json`))
                    ? JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${category}.json`), "utf-8")).length : 0;

                let report = `[ 🏁 API GET TIKTOK ]\n─────────────────\n👤 User: @${userId}\n🎯 Loại: ${filterType.toUpperCase()}\n✅ Thành công: ${processedPosts.length} bài.\n📥 Link mới: ${totalNewLinks}\n📂 Kho: ${category}.json (${totalInDb})\n`;
                if (skipCount > 0) report += `⏩ Lọc bỏ: ${skipCount} bài sai loại.\n`;
                if (dupCount > 0) report += `🚫 Bỏ qua: ${dupCount} bài cũ.\n`;
                report += `─────────────────`;
                return api.sendMessage({ msg: report }, threadId, threadType);

            } catch (e) {
                return api.sendMessage({ msg: `⚠️ Lỗi hệ thống: ${e.message}` }, threadId, threadType);
            }
        }

        // [ 2. LỆNH API ADD - THÊM LẺ VÀO KHO ]
        const isAdd = subCommand === "add";
        const targetType = isAdd ? args[1]?.toLowerCase().trim() : null;
        let url = isAdd ? args.slice(2).join(" ").trim() : args.join(" ").trim();
        let urlFromQuote = false;

        if (!url && message.data && message.data.quote) {
            const quote = message.data.quote;
            log.info(`[API DEBUG] Quote keys: ${Object.keys(quote).join(", ")}`);
            log.info(`[API DEBUG] Quote.attach: ${typeof quote.attach === "string" ? quote.attach.substring(0, 500) : JSON.stringify(quote.attach)?.substring(0, 500)}`);
            url = extractUrlFromQuote(quote);
            urlFromQuote = true;
            log.info(`[API DEBUG] Extracted URL: ${url}`);
        }

        if (!url || !url.startsWith("http")) {
            let guide = `[ 🛠️ API TOOLS ]\n─────────────────\n`;
            guide += `1. ${prefix}api [URL] ➥ Upload Drive\n`;
            guide += `2. ${prefix}api add [tên] [URL] ➥ Lưu database\n`;
            guide += `3. ${prefix}api get [id] [limit] [img/video] [kho]\n`;
            guide += `─────────────────\n💡 VD: ${prefix}api get user 10 video vdgai`;
            return api.sendMessage({ msg: guide }, threadId, threadType);
        }

        log.info(`[API DEBUG] Final URL to process: ${url}`);
        try {
            await api.sendMessage({ msg: `◈ Đang xử lý và upload lên hệ thống...` }, threadId, threadType);

            let linksToStore = [];
            let mainDriveLink = "";

            // Xử lý TikTok / Douyin
            if (url.includes("tiktok.com") || url.includes("douyin.com")) {
                const snap = await downloadTikTok(url);
                if (snap) {
                    if (snap.videoUrl) {
                        mainDriveLink = await uploadFromUrl(snap.videoUrl);
                        if (mainDriveLink) linksToStore.push(mainDriveLink);
                    } else if (snap.images && snap.images.length > 0) {
                        for (const imgUrl of snap.images) {
                            const gLink = await uploadFromUrl(imgUrl);
                            if (gLink) linksToStore.push(gLink);
                        }
                        mainDriveLink = linksToStore[0];
                    }
                }
            }

            // Nếu không phải TikTok hoặc download mặc định
            // Fix 404: Zalo CDN URLs (zadn.vn) cần header Referer đặc biệt
            if (linksToStore.length === 0) {
                const isZaloCdn = urlFromQuote || url.includes("zadn.vn") || url.includes("zalo.me") || url.includes("zdn.vn") || url.includes("dlfl.vn");
                const CACHE = path.join(process.cwd(), "src/modules/cache");
                if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });

                if (isZaloCdn) {
                    // Zalo CDN: tải local trước với header đặc biệt, rồi upload bằng uploadFromFile
                    const ext = url.match(/\.(mp4|jpg|jpeg|png|gif|webp|mp3|aac)/i)?.[0] || ".mp4";
                    const tmpPath = path.join(CACHE, `api_zalo_${Date.now()}${ext}`);
                    let downloaded = false;

                    const zaloCtx = api.getContext?.() || {};
                    const REFERERS = [
                        "https://chat.zalo.me/",
                        "https://zalo.me/",
                        "https://id.zalo.me/",
                    ];

                    for (const referer of REFERERS) {
                        if (downloaded) break;
                        try {
                            const origin = new URL(referer).origin;
                            const res = await axios({
                                method: "GET",
                                url,
                                responseType: "stream",
                                timeout: 60000,
                                maxRedirects: 10,
                                headers: {
                                    "User-Agent": zaloCtx.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
                                    Cookie: zaloCtx.cookie || "",
                                    Referer: referer,
                                    Origin: origin,
                                    Accept: "*/*",
                                }
                            });
                            const writer = fs.createWriteStream(tmpPath);
                            res.data.pipe(writer);
                            await new Promise((resolve, reject) => { writer.on("finish", resolve); writer.on("error", reject); });

                            if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 1024) {
                                downloaded = true;
                                log.info(`[API] Tải Zalo CDN OK (Referer: ${referer}) → ${(fs.statSync(tmpPath).size / 1024).toFixed(1)} KB`);
                            }
                        } catch (err) {
                            log.warn(`[API] Zalo CDN fail (Referer: ${referer}): ${err.message}`);
                            try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { }
                        }
                    }

                    if (downloaded) {
                        try {
                            mainDriveLink = await uploadToGDrive(tmpPath);
                            if (mainDriveLink) linksToStore.push(mainDriveLink);
                        } finally {
                            try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { }
                        }
                    } else {
                        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { }
                        throw new Error("Không tải được file từ Zalo CDN (URL có thể đã hết hạn). Thử copy URL trực tiếp.");
                    }
                } else {
                    // URL bình thường (không phải Zalo CDN)
                    const zaloCtx = api.getContext?.() || {};
                    const headers = {
                        Cookie: zaloCtx.cookie || "",
                        "User-Agent": zaloCtx.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
                    };
                    mainDriveLink = await uploadFromUrl(url, headers);
                    if (mainDriveLink) linksToStore.push(mainDriveLink);
                }
            }

            if (linksToStore.length === 0) throw new Error("Không thể trích xuất link tải hoặc upload thất bại.");

            if (isAdd && targetType) {
                const total = saveToDatabase(targetType, linksToStore);
                await api.sendMessage({
                    msg: `[ ✅ LƯU THÀNH CÔNG ]\n─────────────────\n📂 Kho: ${targetType}.json\n🔗 Drive: ${mainDriveLink}${linksToStore.length > 1 ? ` (+${linksToStore.length - 1} ảnh)` : ""}\n📊 Tổng kho: ${total} link.\n─────────────────`
                }, threadId, threadType);
            } else {
                await api.sendMessage({
                    msg: `[ ✅ UPLOAD THÀNH CÔNG ]\n─────────────────\n🔗 Link Drive:${linksToStore.length > 1 ? ` (Slideshow ${linksToStore.length} ảnh)` : ""}\n${linksToStore.join("\n")}\n─────────────────`
                }, threadId, threadType);
            }
        } catch (e) {
            log.error("API command error:", e.message);
            await api.sendMessage({ msg: `⚠️ Lỗi: ${e.message}` }, threadId, threadType);
        }
    }
};
