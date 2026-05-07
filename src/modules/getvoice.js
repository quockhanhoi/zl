import axios from "axios";
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import path from "node:path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import { log } from "../logger.js";

// Cấu hình ffmpeg
const ffmpegPath = (typeof ffmpegStatic === "object" && ffmpegStatic.path) ? ffmpegStatic.path : ffmpegStatic;
ffmpeg.setFfmpegPath(ffmpegPath);

export const name = "getvoice";
export const description = "Trích xuất giọng nói từ video sếp reply ạ! (Bú từ Vitzl)";

export const commands = {
    getvoice: async (ctx) => {
        const { api, threadId, threadType, message } = ctx;
        
        // 1. Trích xuất URL video từ tin nhắn được quote
        const quote = message.data?.quote || message.quote;
        if (!quote) return api.sendMessage({ msg: "⚠️ Sếp ơi, hãy reply (phản hồi) vào cái video mà sếp muốn em lấy giọng nói nhé!" }, threadId, threadType);

        const data = quote.data || quote;
        const attach = typeof data.attach === "string" ? (JSON.parse(data.attach) || {}) : (data.attach || {});
        const params = typeof attach.params === "string" ? (JSON.parse(attach.params) || {}) : (attach.params || {});

        // Ưu tiên link HD hoặc link gốc
        const videoUrl = attach.href || params.href || data.hdUrl || data.url || params.hdUrl || params.url;
        
        if (!videoUrl || typeof videoUrl !== "string" || !videoUrl.startsWith("http")) {
            return api.sendMessage({ msg: "⚠️ Em không tìm thấy link video nào trong tin nhắn này cả sếp ạ!" }, threadId, threadType);
        }

        const cacheDir = path.join(process.cwd(), "src", "modules", "cache");
        if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });

        const tmpVideo = path.join(cacheDir, `v_${Date.now()}.mp4`);
        const tmpAudio = path.join(cacheDir, `a_${Date.now()}.mp3`);

        let waitMsg = null;
        try {
            waitMsg = await api.sendMessage({ msg: "⏳ Đang trích xuất giọng nói từ video cho sếp đây... Đợi em xíu nhé!" }, threadId, threadType);

            // 2. Tải video về tạm
            log.info(`[GetVoice] Downloading: ${videoUrl}`);
            const response = await axios.get(videoUrl, { 
                responseType: "arraybuffer",
                headers: {
                    'User-Agent': 'Mozilla/5.0'
                }
            });
            writeFileSync(tmpVideo, response.data);

            // 3. Dùng FFmpeg để trích xuất audio (mp3)
            log.info(`[GetVoice] Extracting audio...`);
            await new Promise((resolve, reject) => {
                ffmpeg(tmpVideo)
                    .toFormat('mp3')
                    .audioChannels(1) // Mono cho nhẹ và chuẩn voice
                    .audioBitrate('128k')
                    .on('end', resolve)
                    .on('error', (err) => {
                        log.error("[GetVoice] FFmpeg Error:", err.message);
                        reject(err);
                    })
                    .save(tmpAudio);
            });

            // 4. Gửi qua Zalo bằng sendVoiceUnified (đã có sẵn trong bot sếp)
            log.info(`[GetVoice] Sending voice message...`);
            await api.sendVoiceUnified({
                filePath: tmpAudio,
                threadId,
                threadType
            });

        } catch (err) {
            log.error("[GetVoice] Error:", err.message);
            api.sendMessage({ msg: "⚠️ Toi rồi sếp ơi! Em không lấy được giọng nói: " + err.message }, threadId, threadType);
        } finally {
            // Xóa tin nhắn chờ
            if (waitMsg && waitMsg.message) {
                try {
                    if (typeof api.undo === "function") await api.undoMessage(waitMsg.message, threadId, threadType);
                } catch (e) {}
            }
            // Dọn dẹp rác
            if (existsSync(tmpVideo)) try { unlinkSync(tmpVideo); } catch (e) {}
            if (existsSync(tmpAudio)) try { unlinkSync(tmpAudio); } catch (e) {}
        }
    }
};
