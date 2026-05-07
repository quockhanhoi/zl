import fs, { existsSync, unlinkSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import axios from "axios";
import { spawn } from "node:child_process";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import sizeOf from "image-size";
import sharp from "sharp";
import { uploadToTmpFiles } from "../utils/tmpFiles.js";
import { processAndSendSticker } from "../utils/send-sticker/send-sticker/send-sticker.js";
import { drawStickerSearch } from "../utils/canvasHelper.js";

// Sử dụng ffmpeg-static để đảm bảo có ffmpeg chạy
const ffmpegPath = (typeof ffmpegStatic === "object" && ffmpegStatic.path) ? ffmpegStatic.path : ffmpegStatic;
ffmpeg.setFfmpegPath(ffmpegPath);

export const name = "stk";
export const description = "Sticker Pro: Tạo stk từ ảnh/GIF/video, Tìm Giphy, Xem bộ sticker. Sub: p (xem bộ), xt (xoay đĩa), bo (bo góc), xn (xóa nền)";
export const pendingStk = new Map();

/**
 * Tạo hiệu ứng "Đĩa than" cho ảnh bằng Sharp (Xén tròn + Viền đen + Tâm đĩa)
 */
async function createVinylDisk(buffer) {
    const size = 512;
    // Chỉ xén tròn đơn giản như sếp muốn
    const circleMask = Buffer.from(`
        <svg width="${size}" height="${size}">
            <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/>
        </svg>
    `);

    return await sharp(buffer)
        .resize(size, size, { fit: 'cover' })
        .composite([
            { input: circleMask, blend: 'dest-in' }
        ])
        .png()
        .toBuffer();
}

/**
 * Bo góc ảnh bằng Sharp cực mượt bằng SVG mask
 */
async function createRoundedCorner(buffer, radius = 80) {
    const meta = await sharp(buffer).metadata();
    const w = meta.width;
    const h = meta.height;
    const mask = Buffer.from(`
        <svg width="${w}" height="${h}">
            <rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="white"/>
        </svg>
    `);
    return await sharp(buffer)
        .composite([{ input: mask, blend: 'dest-in' }])
        .png()
        .toBuffer();
}

const cacheDir = path.join(process.cwd(), "src", "modules", "cache", "stk_temp");
if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });

// --- CẤU HÌNH FILTER ---
const ROUND_R = 40;
const _RND_A = `if(lte(pow(X-min(max(X\\,${ROUND_R})\\,W-${ROUND_R})\\,2)+pow(Y-min(max(Y\\,${ROUND_R})\\,2)\\,${ROUND_R * ROUND_R})\\,255\\,0)`;
const ROUNDED_FILTER = `format=rgba,geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='${_RND_A}'`;

const ZALO_DL_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://chat.zalo.me/",
};

async function downloadMedia(url, dest) {
    const response = await axios({
        method: "GET",
        url: url,
        responseType: "arraybuffer",
        timeout: 40000,
        headers: ZALO_DL_HEADERS
    });
    const contentType = response.headers["content-type"] || "";
    if (contentType.includes("text/html")) {
        throw new Error("Zalo tải về lỗi (bị chặn CDN hoặc link hết hạn).");
    }
    const buf = Buffer.from(response.data);
    if (buf.length < 100) {
        throw new Error("Tệp tải về quá nhỏ hoặc không hợp lệ.");
    }
    writeFileSync(dest, buf);
    return true;
}


function loadConfig() {
    try {
        const data = readFileSync(path.join(process.cwd(), "config.json"), "utf8");
        return JSON.parse(data);
    } catch { return {}; }
}

const REMOVE_BG_KEYS = [
    "t4Jf1ju4zEpiWbKWXxoSANn4", "CTWSe4CZ5AjNQgR8nvXKMZBd",
    "PtwV35qUq557yQ7ZNX1vUXED", "wGXThT64dV6qz3C6AhHuKAHV",
    "82odzR95h1nRp97Qy7bSRV5M", "4F1jQ7ZkPbkQ6wEQryokqTmo",
    "sBssYDZ8qZZ4NraJhq7ySySR", "NuZtiQ53S2F5CnaiYy4faMek",
    "f8fujcR1G43C1RmaT4ZSXpwW", "vLHEhVk6Te5LVRTcAejisroo"
];

async function removeBgWithAPI(filePath, apiKey) {
    const FormData = (await import("form-data")).default;
    const form = new FormData();
    form.append("size", "auto");
    form.append("image_file", fs.readFileSync(filePath), { filename: "image.png" });

    const res = await axios.post("https://api.remove.bg/v1.0/removebg", form, {
        headers: {
            ...form.getHeaders(),
            "X-Api-Key": apiKey
        },
        responseType: "arraybuffer",
        timeout: 30000
    });
    return res.data;
}

function extractMediaUrl(message) {
    const quote = message.data?.quote || message.quote;
    if (!quote) return null;

    const data = quote.data || quote;
    const content = data.content;
    const attach = typeof data.attach === "string" ? (JSON.parse(data.attach) || {}) : (data.attach || {});
    const params = typeof attach.params === "string" ? (JSON.parse(attach.params) || {}) : (attach.params || {});

    // 1. Ưu tiên các trường URL trực tiếp (ưu tiên link thật href thay vì thumbnail)
    const url = attach.href || params.href || content?.href || data.hdUrl || data.url || params.hdUrl || params.url || (params.webp && params.webp.url) || data.thumbUrl || content?.thumb || params.thumbUrl;
    if (url && typeof url === "string" && url.startsWith("http")) {
        return decodeURIComponent(url.replace(/\\\//g, "/"));
    }

    // 2. Tìm trong content bằng Regex nếu là text chứa link
    if (typeof content === "string") {
        const urlRegex = /(https?:\/\/[^\s"'<>]+)/g;
        const match = content.match(urlRegex);
        if (match && match[0].match(/\.(jpg|jpeg|png|webp|gif|mp4|mov|m4v)/i)) {
            return match[0].replace(/\\/g, "");
        }
    }

    return null;
}

async function convertToSticker(input, output, options = {}) {
    const { isAnimated = false, rotate = false, round = false, speed = 2, isStaticImage = true, duration = 15 } = options;
    const willAnimate = isAnimated || rotate;

    return new Promise((resolve, reject) => {
        let ff = ffmpeg(input);

        // Bắt buộc loop tệp tĩnh nếu muốn xuất animation (như xoay)
        if (isStaticImage && willAnimate) {
            ff.inputOptions(["-loop", "1"]);
        }

        let filterChain = [];

        if (round) {
            // Cut a square from the center, scale to 512x512
            filterChain.push(`crop='min(iw,ih)':'min(iw,ih)':'(iw-min(iw,ih))/2':'(ih-min(iw,ih))/2'`);
            filterChain.push(`scale=512:512`);
            // Apply circle mask
            filterChain.push(`format=rgba`);
            filterChain.push(`geq=r='r(X,Y)':a='if(gt(hypot(X-256,Y-256),256),0,alpha(X,Y))'`);
        } else {
            // Normal scale
            filterChain.push(`scale='if(gt(iw,ih),min(iw,512),-1)':'if(gt(iw,ih),-1,min(ih,512))'`);
            // Đảm bảo có Alpha channel cho Sticker trong suốt
            filterChain.push(`format=rgba`);
        }

        if (rotate) {
            // Xoay như đĩa nhạc (quay sang phải)
            filterChain.push(`rotate=-${speed}*t:c=none:ow='iw':oh='ih'`);
        }

        ff.outputOptions([
            "-vf", filterChain.join(","),
            "-c:v", "libwebp",
            "-preset", "default", // Sửa lại thành default vì libwebp không có preset sticker
            "-lossless", "0",
            "-q:v", "75",
            "-loop", "0",
            "-an"
        ]);

        if (willAnimate) {
            // Nếu video dài hơn 15s, giảm fps để tệp không quá nặng
            const fps = duration > 20 ? 12 : 18;
            ff.outputOptions(["-t", String(duration), "-r", String(fps)]);
        } else {
            ff.outputOptions(["-frames:v", "1"]);
        }

        ff.save(output)
            .on("end", () => resolve(true))
            .on("error", (err, stdout, stderr) => {
                let errLog = err.message;
                if (stderr) errLog += ` | Stderr: ${stderr.substring(stderr.length > 300 ? stderr.length - 300 : 0).replace(/\n/g, ' ')}`;
                reject(new Error(errLog));
            });
    });
}

export const commands = {
    stk: async (ctx) => {
        const { api, args, message, threadId, threadType, log, senderName, senderId } = ctx;
        let mediaUrl = null;

        const subCmd = args[0]?.toLowerCase();
        const isRotate = subCmd === "xt";
        const isRounded = subCmd === "bo" || subCmd === "xt";
        const rotSpeed = subCmd === "xt" ? (args[1] || 2) : 0;

        const safeStringify = (obj) => {
            const cache = new Set();
            try {
                return JSON.stringify(obj, (key, value) => {
                    if (typeof value === "object" && value !== null) {
                        if (cache.has(value)) return;
                        cache.add(value);
                    }
                    return value;
                });
            } catch (e) {
                return "";
            }
        };

        // [NEW] Cập nhật sticker mới nhất (stk update)
        if (subCmd === "update" || subCmd === "refresh") {
            await api.addReaction("⏳", message).catch(() => {});
            try {
                const res = await api.updatePersonalSticker({ version: 0 });
                if (res && !res.error) {
                    await api.addReaction("✅", message).catch(() => {});
                    return api.sendMessage({ msg: "✅ Đã cập nhật danh sách sticker mới nhất từ hệ thống Zalo! 🚀" }, threadId, threadType);
                }
                throw new Error(res?.error?.message || "Lỗi không xác định");
            } catch (e) {
                return api.sendMessage({ msg: `⚠️ Cập nhật thất bại: ${e.message}` }, threadId, threadType);
            }
        }

        // [NEW] Khôi phục tính năng xem bộ sticker (stk p)
        if (subCmd === "p" || subCmd === "pack") {
            const quote = message.data?.quote || message.quote;
            let cateId = null;
            
            if (quote) {
                const quoteStr = safeStringify(quote);
                const cateMatch = quoteStr.match(/(?:cateId|catId|pStickerRootCateId|categoryId)[\\'"]*\s*:\s*[\\'"]*(\d+)/i);
                if (cateMatch && cateMatch[1]) {
                    cateId = parseInt(cateMatch[1]);
                }
            }
            
            if (!cateId) {
                return api.sendMessage({ msg: "⚠️ Vui lòng reply vào một sticker Zalo để xem trọn bộ." }, threadId, threadType);
            }
            
            api.sendMessage({ msg: `⏳ Đang tải dữ liệu bộ sticker (ID: ${cateId})...` }, threadId, threadType).catch(() => {});
            
            const packData = await fetchAndDrawPack(cateId, api, cacheDir);
            if (!packData) {
                return api.sendMessage({ msg: `⚠️ Không tìm thấy thông tin bộ sticker ID: ${cateId}` }, threadId, threadType);
            }
            
            const msgInfo = `📦 Đã tìm thấy ${packData.stickers.length} sticker trong bộ.\n📌 Reply số (1-${packData.stickers.length}) để chọn gửi.`;
            const sentMsg = await api.sendMessage({ msg: msgInfo, attachments: [packData.path] }, threadId, threadType);
            
            const undoList = api.getUndoData ? api.getUndoData(sentMsg) : [];
            if (sentMsg?.link) undoList.push({ msgId: String(sentMsg.link.msgId), cliMsgId: String(sentMsg.link.cliMsgId) });
            const realMsgId = undoList[0]?.msgId || sentMsg?.msgId || (sentMsg?.link ? sentMsg.link.msgId : "");
            
            const sessionData = {
                packStickers: packData.stickers,
                threadId, senderId, undoList, messageID: realMsgId
            };
            pendingStk.set(`${threadId}-${senderId}`, sessionData);
            if (realMsgId) pendingStk.set(String(realMsgId), sessionData);
            
            setTimeout(() => {
                pendingStk.delete(`${threadId}-${senderId}`);
                if (realMsgId) pendingStk.delete(String(realMsgId));
                if (existsSync(packData.path)) unlinkSync(packData.path);
            }, 120000);
            
            return;
        }

        // 1. Kiểm tra link trực tiếp
        const urlRegex = /^(https?:\/\/[^\s]+)$/;
        const linkInArgs = args.find(a => urlRegex.test(a?.trim()));
        if (linkInArgs) mediaUrl = linkInArgs.trim();

        // 2. Kiểm tra reply
        if (!mediaUrl) {
            mediaUrl = extractMediaUrl(message);
        }

        if (!mediaUrl) {
            // 1. Trường hợp Sticker Native (Copy nguyên bản - chỉ khi không có sub-command)
            if (!subCmd) {
                const quote = message.data?.quote || message.quote;
                if (quote) {
                    const quoteStr = safeStringify(quote);
                    const cateMatch = quoteStr.match(/(?:cateId|catId|pStickerRootCateId|categoryId)[\\'"]*\s*:\s*[\\'"]*(\d+)/i);
                    const stkMatch = quoteStr.match(/(?:stickerId|id)[\\'"]*\s*:\s*[\\'"]*(\d+)/i);
                    
                    if (cateMatch && cateMatch[1] && stkMatch && stkMatch[1]) {
                        const cateId = parseInt(cateMatch[1]);
                        const stickerId = parseInt(stkMatch[1]);
                        
                        await api.addReaction("🎯", message).catch(() => { });
                        return await api.sendStickerNative({ stickerId, cateId, threadId, threadType, stickerType: 1 });
                    }
                }
            }

            // 2. Tìm kiếm sticker từ kho Zalo
            const isSearchCmd = ["search", "tìm", "find"].includes(subCmd);
            const rawTerms = isSearchCmd ? args.slice(1).join(" ") : args.join(" ");

            if (rawTerms && !["xt", "bo", "xn", "update", "refresh", "p", "pack"].includes(subCmd)) {
                try {
                    const searchTerms = rawTerms.trim();
                    const isGifSearch = isSearchCmd && args[1]?.toLowerCase() === "gif";
                    const finalQuery = isGifSearch ? args.slice(2).join(" ").trim() : searchTerms;
                    const apiKey = "Gc7131jiJuvI7IdN0HZ1D7nh0ow5BU6g"; // Restored original key

                    log.info(`[stk] Đang tìm ${isGifSearch ? 'GIF' : 'STICKER'} trên Giphy cho: "${finalQuery}"`);

                    // 1. TÌM TRÊN GIPHY TRƯỚC
                    let giphyUrl = isGifSearch 
                        ? `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(finalQuery)}&limit=15`
                        : `https://api.giphy.com/v1/stickers/search?api_key=${apiKey}&q=${encodeURIComponent(finalQuery)}&limit=15`;
                    
                    let gRes = await axios.get(giphyUrl).catch(e => { log.error("[stk] Giphy API Error:", e.message); return null; });
                    let gifs = gRes?.data?.data || [];

                    // 2. NẾU KHÔNG CÓ KẾT QUẢ VÀ KHÔNG PHẢI TÌM GIF -> THỬ TÌM TRÊN ZALO
                    if (gifs.length === 0 && !isGifSearch) {
                        log.info(`[stk] Giphy không có kết quả, đang thử tìm trong kho Zalo...`);
                        const searchResult = await api.searchSticker(finalQuery).catch(e => { log.error("[stk] Zalo Search Error:", e.message); return null; });
                        let stickers = [];
                        if (Array.isArray(searchResult)) stickers = searchResult;
                        else if (searchResult?.data) stickers = searchResult.data.items || searchResult.data.stickers || [];
                        else if (searchResult?.items) stickers = searchResult.items;

                        if (stickers.length > 0) {
                            const packData = await drawPackSearch(stickers, finalQuery);
                            const gridPath = path.join(cacheDir, `zalo_search_${Date.now()}.png`);
                            writeFileSync(gridPath, packData.path);
                            
                            const msg = `🔍 Tìm thấy ${stickers.length} sticker Zalo cho "${finalQuery}".\n📌 Reply số (1-${stickers.length}) để gửi.`;
                            const sentMsg = await api.sendMessage({ msg, attachments: [gridPath] }, threadId, threadType);
                            
                            const undoList = api.getUndoData ? api.getUndoData(sentMsg) : [];
                            const realMsgId = undoList[0]?.msgId || sentMsg?.msgId || (sentMsg?.link ? sentMsg.link.msgId : "");
                            
                            const sessionData = { packStickers: stickers, threadId, senderId, undoList, messageID: realMsgId };
                            pendingStk.set(`${threadId}-${senderId}`, sessionData);
                            if (realMsgId) pendingStk.set(String(realMsgId), sessionData);

                            setTimeout(() => {
                                pendingStk.delete(`${threadId}-${senderId}`);
                                if (realMsgId) pendingStk.delete(String(realMsgId));
                                if (existsSync(gridPath)) unlinkSync(gridPath);
                            }, 120000);
                            return;
                        }

                        // 3. NẾU ZALO CŨNG KHÔNG CÓ -> THỬ TÌM GIF TRÊN GIPHY LÀM CUỐI CÙNG
                        log.info(`[stk] Zalo cũng không có, thử tìm GIF Giphy làm phương án cuối...`);
                        giphyUrl = `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(finalQuery)}&limit=15`;
                        gRes = await axios.get(giphyUrl).catch(() => null);
                        gifs = gRes?.data?.data || [];
                    }

                    // 4. HIỂN THỊ KẾT QUẢ GIPHY (GRID 15 Ô)
                    if (gifs.length > 0) {
                        const topGifs = gifs.slice(0, 15);
                        const buffer = await drawStickerSearch(topGifs, finalQuery);
                        const gridPath = path.join(cacheDir, `grid_${Date.now()}.png`);
                        writeFileSync(gridPath, buffer);
                        
                        const msgInfo = `🔎 Đã tìm thấy ${gifs.length} kết quả từ Giphy cho "${finalQuery}".\n📌 Vui lòng reply số (1-${topGifs.length}) để chọn Sticker.`;
                        const sentMsg = await api.sendMessage({ msg: msgInfo, attachments: [gridPath] }, threadId, threadType);
                        
                        const undoList = api.getUndoData ? api.getUndoData(sentMsg) : [];
                        const realMsgId = undoList[0]?.msgId || sentMsg?.msgId || (sentMsg?.link ? sentMsg.link.msgId : "");
                        
                        const sessionData = { gifs: topGifs, threadId, senderId, undoList, messageID: realMsgId, subCmd, rotSpeed };
                        pendingStk.set(`${threadId}-${senderId}`, sessionData);
                        if (realMsgId) pendingStk.set(String(realMsgId), sessionData);
                        
                        setTimeout(() => {
                            pendingStk.delete(`${threadId}-${senderId}`);
                            if (realMsgId) pendingStk.delete(String(realMsgId));
                            if (existsSync(gridPath)) unlinkSync(gridPath);
                        }, 120000);
                        return;
                    }

                    if (!mediaUrl) {
                        return api.sendMessage({ msg: `⚠️ Không tìm thấy sticker hay GIF nào cho từ khóa "${finalQuery}"` }, threadId, threadType);
                    }
                } catch (err) {
                    log.error("[stk] Search error:", err.message);
                    return api.sendMessage({ msg: `⚠️ Lỗi tìm kiếm: ${err.message}` }, threadId, threadType);
                }
            }
        }

            if (!mediaUrl) {
                const helpMsg = 
                    `🎨 [ STICKER PRO - HƯỚNG DẪN ]\n` +
                    `─────────────────\n` +
                    `1️⃣ Tạo Sticker: Reply vào ảnh/GIF/video hoặc dán link sau lệnh\n` +
                    `2️⃣ Xóa nền: -stk xn (Reply ảnh)\n` +
                    `3️⃣ Xoay đĩa: -stk xt (Reply ảnh)\n` +
                    `4️⃣ Bo góc: -stk bo (Reply ảnh)\n` +
                    `5️⃣ Xem bộ Zalo: -stk p (Reply sticker Zalo)\n` +
                    `6️⃣ Tìm Sticker: -stk [từ khóa]\n` +
                    `7️⃣ Tìm GIF: -stk search gif [từ khóa]\n` +
                    `─────────────────\n` +
                    `💡 Mẹo: Kết hợp -stk xn xt để vừa xóa nền vừa xoay đĩa!`;
                return api.sendMessage({ msg: helpMsg }, threadId, threadType);
            }

        const ts = Date.now();
        // Phát hiện extension từ URL - quan trọng để sharp đọc đúng format
        let urlExt = (mediaUrl.match(/\.(jpg|jpeg|png|webp|gif|mp4|mov|m4v)/i)?.[1] || 'jpg').toLowerCase();
        let tempIn = path.join(cacheDir, `in_${ts}.${urlExt}`);
        const tempOut = path.join(cacheDir, `out_${ts}.webp`);

        try {
            await api.addReaction("⏳", message).catch(() => { });
            await downloadMedia(mediaUrl, tempIn);

            let isGifOrVid = false;
            let bypassFfmpeg = false;
            let finalDuration = 15;

            // Xác định xem có phải Video message không
            const quoteData = message.data?.quote || message.quote;
            const rootData = quoteData?.data || quoteData;
            const msgTypeStr = String(rootData?.msgType || rootData?.cliMsgType || "0");
            const isVideoMsg = ["5", "18", "44", "105"].includes(msgTypeStr);

            const tempInBuf = fs.readFileSync(tempIn);
            // Chỉ gọi Sharp metadata nếu KHÔNG phải video để tránh lỗi "unsupported image format"
            let meta = { format: urlExt };
            if (!isVideoMsg && urlExt !== "mp4" && urlExt !== "mov" && urlExt !== "m4v") {
                try {
                    meta = await sharp(tempInBuf, { animated: true }).metadata();
                    
                    if ((meta.format === "gif" || meta.format === "webp") && meta.pages > 1) {
                        isGifOrVid = true;
                        if (meta.delay) {
                            const totalDelay = Array.isArray(meta.delay) ? meta.delay.reduce((a, b) => a + b, 0) : (meta.delay * meta.pages);
                            finalDuration = Math.min(60, totalDelay / 1000);
                        } else {
                            finalDuration = Math.min(60, meta.pages * 0.1);
                        }
                    }
                } catch (e) { 
                    log.warn("[stk] Sharp metadata lỗi (có thể là video):", e.message); 
                }
            }

            // --- XỬ LÝ ẢNH CAO CẤP (SHARP PRE-PROCESS) ---
            if (!isGifOrVid) {
                let processedBuffer = tempInBuf;
                let needsUpdate = false;

                if (isRotate) {
                    processedBuffer = await createVinylDisk(processedBuffer);
                    needsUpdate = true;
                } else if (isRounded) {
                    processedBuffer = await createRoundedCorner(processedBuffer);
                    needsUpdate = true;
                }

                if (needsUpdate) {
                    fs.writeFileSync(tempIn, processedBuffer);
                }
            }

            if ((meta.format === "gif" || meta.format === "webp") && meta.pages > 1) {
                if (!isRounded && !isRotate) {
                    bypassFfmpeg = true;
                } else if (meta.format === "webp") {
                    // Nếu cần xoay/bo góc, chuyển WebP sang GIF để ffmpeg dễ xử lý
                    urlExt = "gif";
                    const newTempIn = path.join(cacheDir, `in_${ts}.${urlExt}`);
                    await sharp(tempInBuf, { animated: true, limitInputPixels: false }).gif().toFile(newTempIn);
                    if (existsSync(tempIn)) unlinkSync(tempIn);
                    tempIn = newTempIn;
                }
            }

            if (!isGifOrVid) {
                isGifOrVid = urlExt === "gif" || mediaUrl.toLowerCase().match(/\.(mp4|mov|m4v)/i) || isVideoMsg;
            }

            // Nếu là Video, dùng ffprobe lấy duration chính xác
            if (isGifOrVid && !bypassFfmpeg && (urlExt !== "gif" && urlExt !== "webp" || isVideoMsg)) {
                try {
                    const videoMeta = await new Promise((resolve, reject) => {
                        ffmpeg.ffprobe(tempIn, (err, metadata) => err ? reject(err) : resolve(metadata));
                    });
                    const duration = videoMeta.format?.duration || 0;
                    if (duration > 0) finalDuration = Math.min(60, duration);
                } catch (e) { log.warn("[stk] FFprobe duration lỗi:", e.message); }
            }
            const isStatic = !isGifOrVid;

            // XÓA NỀN (XN)
            if (subCmd === "xn" && !bypassFfmpeg) {
                if (!isStatic) throw new Error("Tính năng xoá nền chỉ hoạt động với ảnh tĩnh, không hỗ trợ video/GIF.");
                const config = loadConfig();
                const removeKey = config?.bot?.remove_bg_key;

                api.sendMessage({ msg: "⏳ Đang tạo sticker..." }, threadId, threadType).catch(() => { });

                try {
                    let cleanBuffer = null;
                    let lastError = null;

                    // 1. Thử dùng Key cấu hình trước (nếu có)
                    if (removeKey && removeKey.length > 5 && removeKey !== "KEY_CUA_BAN_O_DAY") {
                        try {
                            cleanBuffer = await removeBgWithAPI(tempIn, removeKey);
                        } catch (e) { lastError = e; log.warn("Key Remove.BG cá nhân lỗi:", e.message); }
                    }

                    // 2. Thử kho Key tổng hợp (Random) nếu bước 1 lỗi/không có
                    if (!cleanBuffer) {
                        // Shuffle mảng để chia đều load cho các keys (Tránh hit rate limit)
                        const keys = [...REMOVE_BG_KEYS].sort(() => Math.random() - 0.5);
                        for (const key of keys) {
                            try {
                                cleanBuffer = await removeBgWithAPI(tempIn, key);
                                log.info(`[xn] Sử dụng thành công fallback key: ${key.substring(0, 6)}...`);
                                break;
                            } catch (err) {
                                lastError = err;
                            }
                        }
                    }

                    if (!cleanBuffer) {
                        throw new Error(`Tất cả Key Remove.BG đều hết hạn hoặc lỗi: ${lastError?.message || "Lỗi không xác định"}`);
                    }

                    // Ghi đè file ảnh đã xóa nền lên tempIn để tí nữa convertToSticker ăn vào
                    writeFileSync(tempIn, cleanBuffer);
                } catch (e) {
                    throw new Error("Xoá nền thất bại! (" + e.message + ")");
                }
            }

            if (!bypassFfmpeg) {
                await convertToSticker(tempIn, tempOut, {
                    isAnimated: !!isGifOrVid,
                    rotate: isRotate,
                    round: isRounded,
                    speed: rotSpeed,
                    isStaticImage: isStatic,
                    duration: finalDuration
                });
            }

            // Sử dụng module send-sticker chính chủ để upload và gửi (Bắt qua folder chính theo yêu cầu)
            await processAndSendSticker(api, message, bypassFfmpeg ? tempIn : tempOut, false);
            api.addReaction("✅", message).catch(() => { });
        } catch (e) {
            log.error("[stk] Error:", e.message);
            api.sendMessage({ msg: `⚠️ Lỗi: ${e.message}` }, threadId, threadType);
        } finally {
            if (existsSync(tempIn)) try { unlinkSync(tempIn); } catch { }
            if (existsSync(tempOut)) try { unlinkSync(tempOut); } catch { }
        }
    }
};

commands.s = commands.stk;

export async function handle(ctx) {
    const { content, senderId, threadId, api, threadType, message } = ctx;
    
    const choice = parseInt(content);
    if (isNaN(choice) || choice < 1 || choice > 40) return false;

    const quoteId = String(message?.data?.quote?.globalMsgId || message?.data?.quote?.msgId || "");
    const key = `${threadId}-${senderId}`;
    const session = (quoteId && pendingStk.has(quoteId)) ? pendingStk.get(quoteId) : pendingStk.get(key);

    if (!session) return false;
    if (!session.gifs && !session.packStickers) return false;
    
    // Đảm bảo chỉ người gọi lệnh mới được chọn
    if (String(session.senderId) !== String(senderId)) return false;

    // Xử lý reply gửi Giphy GIF
    if (session.gifs) {
        const gif = session.gifs[choice - 1];
        if (!gif) return false;

        if (session.undoList && session.undoList.length > 0) {
            api.undoMessage(session.undoList, threadId, threadType).catch(() => {});
        }

        pendingStk.delete(key);
        if (session.messageID) pendingStk.delete(String(session.messageID));

        const mediaUrl = gif?.images?.original?.url || gif?.images?.downsized?.url || gif?.images?.fixed_height?.url || gif?.images?.fixed_width?.url;
        if (!mediaUrl) {
            return api.sendMessage({ msg: "⚠️ Không tìm thấy link sticker này, vui lòng thử cái khác." }, threadId, threadType);
        }

        ctx.args = [mediaUrl];
        if (session.subCmd && session.subCmd !== "search" && session.subCmd !== "tìm" && session.subCmd !== "find") {
            ctx.args.unshift(session.subCmd);
            if (session.rotSpeed) ctx.args.push(session.rotSpeed);
        }
        
        if (ctx.message && ctx.message.data) {
            ctx.message.data.quote = null;
        }

        return await commands.stk(ctx);
    }
    
    // Xử lý reply gửi Zalo Native Sticker từ Pack Lookup
    if (session.packStickers) {
        const stkData = session.packStickers[choice - 1];
        if (!stkData) return false;
        
        if (session.undoList && session.undoList.length > 0) {
            api.undoMessage(session.undoList, threadId, threadType).catch(() => {});
        }
        
        pendingStk.delete(key);
        if (session.messageID) pendingStk.delete(String(session.messageID));
        
        return await api.sendStickerNative({
            stickerId: stkData.id || stkData.stickerId,
            cateId: stkData.cateId || stkData.category_id,
            threadId, threadType,
            stickerType: stkData.type || stkData.stickerType || 1
        });
    }

    return false;
}

// Khôi phục hàm vẽ bảng Sticker Pack
async function fetchAndDrawPack(cateId, api, cacheDir) {
    let stickers = await api.getStickerCategory({ cateId }).catch((e) => {
        console.error("[stk] API Lỗi:", e);
        return [];
    });
    
    // Phân tích linh hoạt cấu trúc trả về vì Zalo có thể trả về Array trực tiếp, hoặc Object chứa Array
    let stickersArray = [];
    if (Array.isArray(stickers)) stickersArray = stickers;
    else if (stickers && Array.isArray(stickers.stickers)) stickersArray = stickers.stickers;
    else if (stickers && Array.isArray(stickers.items)) stickersArray = stickers.items;
    else if (stickers && Array.isArray(stickers.data)) stickersArray = stickers.data;
    else if (stickers?.data && Array.isArray(stickers.data.stickers)) stickersArray = stickers.data.stickers;
    
    if (!stickersArray || stickersArray.length === 0) {
        console.log("[stk] API Response for cateId:", cateId, "is not an array or is empty:", stickers);
        return null;
    }
    
    // limit to 40
    const topStickers = stickersArray.slice(0, 40);
    const { createCanvas, loadImage } = await import("canvas");
    
    const cols = 5;
    const rows = Math.ceil(topStickers.length / cols);
    const itemSize = 120;
    const padding = 10;
    
    const canvas = createCanvas(cols * itemSize, rows * itemSize + 60);
    const ctx = canvas.getContext("2d");
    
    ctx.fillStyle = "#1e1e1e";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 24px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`Bộ Sticker (ID: ${cateId}) - ${topStickers.length} ảnh`, canvas.width / 2, 40);
    
    for (let i = 0; i < topStickers.length; i++) {
        const stk = topStickers[i];
        const x = (i % cols) * itemSize;
        const y = 60 + Math.floor(i / cols) * itemSize;
        try {
            const url = stk.stickerUrl || stk.stickerSpriteUrl || `https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?eid=${stk.id}&size=130`;
            const img = await loadImage(url);
            const drawSize = itemSize - padding * 2;
            ctx.drawImage(img, x + padding, y + padding, drawSize, drawSize);
            
            ctx.fillStyle = "rgba(0,0,0,0.6)";
            ctx.beginPath();
            ctx.arc(x + 25, y + 25, 12, 0, Math.PI * 2);
            ctx.fill();
            
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 14px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText((i + 1).toString(), x + 25, y + 25);
        } catch(e) {}
    }
    
    const outPath = path.join(cacheDir, `pack_${cateId}_${Date.now()}.png`);
    writeFileSync(outPath, canvas.toBuffer("image/png"));
    return { path: outPath, stickers: topStickers };
}
