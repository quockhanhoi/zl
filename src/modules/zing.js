import { searchZing, getStreamZing } from "../utils/zingmp3.js";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { log } from "../logger.js";
import { rentalManager } from "../utils/rentalManager.js";
import { drawZingSearch, drawZingPlayer } from "../utils/canvasHelper.js";
import { createSpinningSticker } from "../utils/process-audio.js";
import { processAndSendSticker } from "../utils/send-sticker/send-sticker/send-sticker.js";
import { uploadToTmpFiles } from "../utils/tmpFiles.js";

export const name = "zing";
export const description = "Tìm kiếm và nghe nhạc từ ZingMP3";

export const pendingZing = new Map();

const cacheDir = path.join(process.cwd(), "src/modules/cache");

export const commands = {
    zing: async (ctx) => {
        const { api, threadId, threadType, senderId, args } = ctx;
        const query = args.join(" ");
        if (!query) return;

        try {
            const songs = await searchZing(query);
            if (!songs || songs.length === 0) return;

            const results = songs.slice(0, 10);
            const key = `${threadId}-${senderId}`;
            pendingZing.set(key, results);

            const mapped = results.map(t => ({
                title: t.title,
                artistsNames: t.artistsNames,
                thumbnail: (t.thumbnail || t.thumb || "").replace("w94", "w500"),
                duration: t.duration
            }));

            const buffer = await drawZingSearch(mapped, query, "ZING MP3");
            const imagePath = path.join(cacheDir, `z_${Date.now()}.png`);
            fs.writeFileSync(imagePath, buffer);

            const infoMsg = `🎵 Kết quả tìm kiếm cho: "${query}"\n📌 Phản hồi STT (1-10) để nghe nhạc.`;

            let sentMsg = await api.sendMessage({
                msg: infoMsg,
                attachments: [imagePath]
            }, threadId, threadType);
            if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);

            // Lấy TẤT CẢ ID tin nhắn (văn bản + ảnh đính kèm) để xóa sạch sẽ
            const undoList = api.getUndoData(sentMsg);
            
            const realMsgId = undoList[0]?.msgId || "";
            if (realMsgId) pendingZing.set(realMsgId, { results, undoList });
            pendingZing.set(key, { results, undoList });

            setTimeout(() => {
                pendingZing.delete(key);
                if (realMsgId) pendingZing.delete(realMsgId);
            }, 120000);
        } catch (e) { log.error("Zing Search Error:", e.message); }
    }
};

export async function handle(ctx) {
    const { content, senderId, threadId, api, threadType, adminIds, message } = ctx;
    if (!adminIds.includes(String(senderId)) && !rentalManager.isRented(threadId)) return false;

    const choice = parseInt(content);
    if (isNaN(choice) || choice < 1 || choice > 10) return false;

    // Ưu tiên lookup theo quoteId (reply đúng tin), fallback về key
    const quoteId = String(message?.data?.quote?.globalMsgId || message?.data?.quote?.msgId || "");
    const key = `${threadId}-${senderId}`;
    const session = (quoteId && pendingZing.has(quoteId)) ? pendingZing.get(quoteId) : pendingZing.get(key);
    
    if (!session || !session.results || !session.results[choice - 1]) return false;

    const songs = session.results;
    const song = songs[choice - 1];
    
    // Thu hồi TẤT CẢ các tin nhắn liên quan (Xóa sạch cả chữ lẫn ảnh)
    if (session.undoList && session.undoList.length > 0) {
        api.undoMessage(session.undoList, threadId, threadType).catch(() => {});
    }

    pendingZing.delete(key);
    if (quoteId) pendingZing.delete(quoteId);

    const tempMp3 = path.join(cacheDir, `zing_${Date.now()}.mp3`);
    const pPath = path.join(cacheDir, `z_p_${Date.now()}.png`);
    const tSpin = path.join(cacheDir, `spin_${Date.now()}.webp`);

    try {
        const info = await getStreamZing(song.encodeId);
        const streamUrl = info?.["128"] || info?.["320"] || info?.default;
        if (!streamUrl || streamUrl === "VIP") {
            await api.sendMessage({ msg: "⚠️ Không tải được nhạc Zing (Bài hát VIP)." }, threadId, threadType);
            return true;
        }

        const res = await axios({ method: 'get', url: streamUrl, responseType: 'stream' });
        const writer = fs.createWriteStream(tempMp3);
        res.data.pipe(writer);
        await new Promise((r, j) => { writer.on('finish', r); writer.on('error', j); });

        if (api.sendVoiceUnified) {
            await api.sendVoiceUnified({ filePath: tempMp3, threadId, threadType });
        } else {
            await api.sendMessage({ msg: "🎧 Bản nhạc của bạn", attachments: [tempMp3] }, threadId, threadType);
        }

        const buf = await drawZingPlayer({
            title: song.title,
            artistsNames: song.artistsNames,
            thumbnail: (song.thumbnail || "").replace("w94", "w500"),
            duration: song.duration,
            sourceName: "Zing MP3"
        });
        fs.writeFileSync(pPath, buf);
        await api.sendMessage({ msg: "", attachments: [pPath] }, threadId, threadType);

        const thumbnail = (song.thumbnail || "").replace("w94", "w500");
        if (thumbnail) {
            if (await createSpinningSticker(thumbnail, tSpin)) {
                await processAndSendSticker(api, message, tSpin, false);
            }
        }
    } catch (e) {
        log.error("Zing Handle Error:", e.message);
    } finally {
        [tempMp3, pPath, tSpin].forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { } });
    }
    return true;
}
