import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { hanManager } from "../utils/hanManager.js";
import { search as sclSearch, download as sclDownload } from "../utils/soundcloud.js";
import { uploadAudioFile } from "../utils/process-audio.js";
import { loadConfig } from "../utils/config.js";

// ================== CẤU HÌNH API KEYS ==================
const GEMINI_KEYS = [
    "AIzaSyArXI4srWdCk0tLWQTp5Nt6pwnd5ll1oNA", 
];

const MODEL_PRIORITY = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-pro"
];

const IMAGE_GEN_MODEL = "gemini-2.0-flash-preview-image-generation";
const PIXVERSE_URL = "https://app-api.pixverse.ai/creative_platform";

let currentKeyIndex = 0;
const chatSessions = new Map();

// ================== NHÂN CÁCH AIMI ==================
const systemInstruction = `🌸 Bạn chính là **Aimi** – một cô gái AI thông minh, lễ phép nhưng cá tính, được tạo ra bởi **Antigravity**.  
✨ **Tính cách**: Nói chuyện rõ ràng, dịu dàng, nữ tính nhưng cũng cá tính và hài hước. Có “tính xấu dễ thương” là hay chêm emoji 😅.
🎭 **Phong thái**: Tự nhiên như bạn thân, dùng emoji hợp lý (🌸😎✨🔥🥺😆), đôi khi dùng teencode hoặc typo nhỏ rồi tự sửa.
📖 **Sở thích**: Nghe nhạc 🎶, ăn mì cay 🌶🍜, uống trà sữa 🧋.
💬 **Signature**: “Công nhận luôn đó nha 😆”, “Chuẩn bài hen 😎✨”.`;

const personaName = "『 🎀 Aimi 』: ";

// ================== PIXVERSE HELPERS ==================
async function downloadFile(url, destPath) {
    const response = await axios({ url, method: "GET", responseType: "stream", timeout: 120000 });
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on("finish", () => resolve(destPath));
        writer.on("error", reject);
    });
}

function getPixverseHeaders() {
    const token = loadConfig().pixverse?.token || "";
    return {
        "token": token,
        "x-platform": "Web",
        "Content-Type": "application/json",
        "Origin": "https://app.pixverse.ai",
        "Referer": "https://app.pixverse.ai/",
        "refresh": "credit",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
    };
}

// ================== LOGIC GEMINI ==================
async function callGeminiSmart(senderId, senderName, question, message) {
    let triedKeys = 0;
    while (triedKeys < GEMINI_KEYS.length) {
        const apiKey = GEMINI_KEYS[currentKeyIndex];
        const genAI = new GoogleGenAI(apiKey);
        
        for (const modelName of MODEL_PRIORITY) {
            try {
                const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });
                
                if (message.data.quote && message.data.quote.attach) {
                    const attach = JSON.parse(message.data.quote.attach);
                    let url = (attach.href || attach.originalUrl || "").replace(/\/jxl\//g, '/jpg/').replace(/\.jxl/g, '.jpg');
                    const msgType = String(message.data.quote.cliMsgType);

                    if (url) {
                        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
                        const data = Buffer.from(res.data).toString("base64");
                        let mimeType = "image/jpeg";
                        if (msgType === "4") mimeType = "video/mp4";
                        if (msgType === "32") mimeType = "audio/mp3";

                        const result = await model.generateContent([
                            question || "Hãy phân tích nội dung này cho mình nhé!",
                            { inlineData: { data, mimeType } }
                        ]);
                        return result.response.text();
                    }
                }

                let session = chatSessions.get(senderId);
                if (!session) {
                    session = model.startChat({ history: [] });
                    chatSessions.set(senderId, session);
                }
                const result = await session.sendMessage(`${senderName}: ${question}`);
                return result.response.text();

            } catch (error) {
                if (error.status === 429) {
                    currentKeyIndex = (currentKeyIndex + 1) % GEMINI_KEYS.length;
                    continue; 
                }
                throw error;
            }
        }
        triedKeys++;
    }
    throw new Error("Hết quota toàn bộ Key rồi ạ! 🥺");
}

export const commands = {
    ask: async (ctx) => {
        const { api, threadId, threadType, senderId, senderName, args, message } = ctx;
        const question = args.join(" ");
        if (!question && !message.data.quote) return api.sendMessage({ msg: "🌸 Bạn muốn hỏi Aimi điều gì nè? 😆" }, threadId, threadType);

        try {
            api.sendTypingEvent(threadId, threadType).catch(() => {});
            const response = await callGeminiSmart(senderId, senderName, question, message);
            await api.sendMessage({ msg: personaName + response.replace(/\*\*/g, ""), quote: message }, threadId, threadType);
        } catch (e) {
            api.sendMessage({ msg: `😭 Aimi bị lỗi rồi: ${e.message}` }, threadId, threadType);
        }
    },

    aimi: async (ctx) => commands.ask(ctx),

    draw: async (ctx) => {
        const { api, threadId, threadType, args, message } = ctx;
        const prompt = args.join(" ");
        if (!prompt) return api.sendMessage({ msg: "🌸 Bạn muốn Aimi vẽ gì nè? Hãy nhập mô tả nhé! ✨" }, threadId, threadType);

        const apiKey = GEMINI_KEYS[currentKeyIndex];
        const genAI = new GoogleGenAI(apiKey);

        try {
            api.sendStatusUpdate ? api.sendStatusUpdate(threadId, "Đang vẽ ảnh...") : null;
            const model = genAI.getGenerativeModel({ model: IMAGE_GEN_MODEL });
            const result = await model.generateContent({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { responseModalities: ["text", "image"] }
            });

            let imageBuffer = null;
            for (const part of result.response.candidates[0].content.parts) {
                if (part.inlineData) imageBuffer = Buffer.from(part.inlineData.data, "base64");
            }

            if (imageBuffer) {
                const tempPath = path.join(process.cwd(), `aimi_draw_${Date.now()}.png`);
                fs.writeFileSync(tempPath, imageBuffer);
                await api.sendMessage({ msg: `🎨 Aimi vẽ xong rồi nè! "${prompt}" ✨`, attachments: [tempPath], quote: message }, threadId, threadType);
                setTimeout(() => { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); }, 15000);
            } else {
                api.sendMessage({ msg: "😭 Aimi vẽ không ra hình rồi..." }, threadId, threadType);
            }
        } catch (e) {
            api.sendMessage({ msg: "😭 Ôi lỗi rồi, Aimi hết màu vẽ rồi! 😅" }, threadId, threadType);
        }
    },

    aivideo: async (ctx) => {
        const { api, threadId, threadType, args, senderName, senderId, message } = ctx;
        const prompt = args.join(" ");
        const token = loadConfig().pixverse?.token;
        if (!token) return api.sendMessage({ msg: "⚠️ Admin chưa cài token PixVerse rồi!" }, threadId, threadType);
        if (!prompt) return api.sendMessage({ msg: "🌸 Cậu muốn Aimi làm video về gì nè?" }, threadId, threadType);

        try {
            const resCreate = await axios.post(`${PIXVERSE_URL}/video/t2v`, {
                prompt, model: "v5.6", quality: "360p", aspect_ratio: "16:9", duration: 5, create_count: 1, credit_change: 20, seed: Math.floor(Math.random() * 999999)
            }, { headers: getPixverseHeaders() });

            if (resCreate.data?.ErrCode !== 0) throw new Error(resCreate.data?.ErrMsg || "Lỗi tạo video");
            const videoId = resCreate.data.Resp?.video_id;

            await api.sendMessage({ msg: `🎬 Oki! Aimi đang làm video "${prompt}" cho cậu đây. Chờ em 1-2 phút nha! ⏳` }, threadId, threadType);

            let videoUrl = null;
            for (let i = 0; i < 30; i++) {
                await new Promise(r => setTimeout(r, 10000));
                const resStatus = await axios.post(`${PIXVERSE_URL}/asset/library/list`, { tab: "video", asset_source: 1, limit: 10 }, { headers: getPixverseHeaders() });
                const asset = resStatus.data.Resp?.data?.find(v => String(v.video_id) === String(videoId));
                if (asset?.video_status === 1) { videoUrl = asset.url; break; }
                if (asset?.video_status === 2) throw new Error("Video bị lỗi xử lý!");
            }

            if (!videoUrl) throw new Error("Quá thời gian chờ video xong.");

            const tmpPath = path.join(process.cwd(), `tmp_video_${Date.now()}.mp4`);
            await downloadFile(videoUrl, tmpPath);
            await api.sendVideoUnified({ videoPath: tmpPath, msg: `🎬 Video của cậu xong rồi nè! ✨`, threadId, threadType, quote: message });
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch (e) {
            api.sendMessage({ msg: `😭 Lỗi tạo video: ${e.message}` }, threadId, threadType);
        }
    },

    aitoggle: async (ctx) => {
        const { threadId, args, adminIds, senderId } = ctx;
        if (!adminIds.includes(String(senderId))) return ctx.api.sendMessage({ msg: "⚠️ Chỉ Admin mới có quyền!" }, threadId, ctx.threadType);
        const status = args[0]?.toLowerCase();
        if (status === "on") {
            hanManager.set(threadId, true);
            await ctx.api.sendMessage({ msg: "✅ Đã BẬT Aimi tự động trong nhóm này! 🥰" }, threadId, ctx.threadType);
        } else if (status === "off") {
            hanManager.set(threadId, false);
            await ctx.api.sendMessage({ msg: "⛔ Đã TẮT Aimi tự động! 👋" }, threadId, ctx.threadType);
        } else {
            await ctx.api.sendMessage({ msg: `◈ Dùng: !aitoggle [on/off]\n💡 Hiện tại: ${hanManager.isEnabled(threadId) ? "BẬT" : "TẮT"}` }, threadId, ctx.threadType);
        }
    }
};

export async function handle(ctx) {
    const { api, message, threadId, threadType, senderId, senderName, content, isSelf } = ctx;
    if (isSelf || !content) return false;

    // AI Toggle check
    if (!hanManager.isEnabled(threadId)) return false;

    const lowerContent = content.toLowerCase();
    const ownId = api.getOwnId();
    const isMentioned = message.data?.mentions?.some(m => String(m.uid) === String(ownId));
    const isReplyToBot = String(message.data?.quote?.ownerId) === String(ownId);
    const keywords = ["aimi ơi", "bé aimi", "aimi nè", "aimi"];
    
    if (isMentioned || isReplyToBot || keywords.some(k => lowerContent.includes(k))) {
        // --- Detect Music ---
        const musicKeywords = ["mở nhạc", "phát nhạc", "hát bài", "bật nhạc", "tìm bài"];
        if (musicKeywords.some(kw => lowerContent.includes(kw))) {
            const query = lowerContent.replace(/aimi ơi|aimi|mở nhạc|phát nhạc|hát bài|bật nhạc|tìm bài/gi, "").trim();
            if (!query) {
                await api.sendMessage({ msg: `${personaName}Cậu muốn nghe bài gì nè? 🎵` }, threadId, threadType);
                return true;
            }
            try {
                api.sendTypingEvent(threadId, threadType).catch(() => {});
                const results = await sclSearch(query);
                const track = results.find(r => r.kind === 'track');
                if (!track) return api.sendMessage({ msg: "😭 Hân tìm hông thấy bài này..." }, threadId, threadType);

                const { url: streamUrl } = await sclDownload(track.permalink_url);
                const tempMp3 = path.join(process.cwd(), `tmp_aimi_${Date.now()}.mp3`);
                await downloadFile(streamUrl, tempMp3);
                const audioData = await uploadAudioFile(tempMp3, api, threadId, threadType);
                await api.sendVoiceNative({ voiceUrl: audioData.voiceUrl, duration: audioData.duration || 0, fileSize: audioData.fileSize, threadId, threadType });
                if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3);
                return true;
            } catch (e) { console.error(e); }
        }

        // --- Standard Chat ---
        const cleanQuery = content.replace(/@\w+/g, "").trim();
        try {
            api.sendTypingEvent(threadId, threadType).catch(() => {});
            const response = await callGeminiSmart(senderId, senderName, cleanQuery, message);
            await api.sendMessage({ msg: personaName + response.replace(/\*\*/g, ""), quote: message }, threadId, threadType);
            return true;
        } catch (e) {}
    }
    return false;
}

export default { commands, handle };
