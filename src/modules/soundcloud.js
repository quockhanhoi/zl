import { search, download } from "../utils/soundcloud.js";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { pipeline } from "node:stream/promises";
import { log } from "../logger.js";
import { rentalManager } from "../utils/rentalManager.js";
import { drawZingSearch, drawZingPlayer } from "../utils/canvasHelper.js";
import { createSpinningSticker } from "../utils/process-audio.js";
import { processAndSendSticker } from "../utils/send-sticker/send-sticker/send-sticker.js";
import { uploadToTmpFiles } from "../utils/tmpFiles.js";

export const name = "soundcloud";
export const description = "Tìm kiếm và nghe nhạc từ SoundCloud";
export const pendingScl = new Map();

const downloadDir = path.resolve(process.cwd(), "Downloads", "zl");
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

export const commands = {
    soundcloud: async (ctx) => await handleScl(ctx),
    sc: async (ctx) => await handleScl(ctx),
    scl: async (ctx) => await handleScl(ctx)
};

async function handleScl(ctx) {
    const { api, threadId, threadType, senderId, args } = ctx;
    const query = args.join(" ");
    if (!query) return;

    try {
        const results = await search(query);
        const tracks = results.filter(item => item.kind === 'track').slice(0, 10);
        if (tracks.length === 0) return;

        const mapped = tracks.map(t => ({
            title: t.title,
            artistsNames: t.user?.username || "SoundCloud Artist",
            thumbnail: (t.artwork_url || t.user?.avatar_url || "").replace("-large", "-t500x500"),
            duration: Math.floor(t.duration / 1000)
        }));

        const buffer = await drawZingSearch(mapped, query, "SOUNDCLOUD");
        const imagePath = path.join(downloadDir, `scl_search_${Date.now()}.png`);
        fs.writeFileSync(imagePath, buffer);

        const infoMsg = `🎵 Kết quả cho: "${query}"\n📌 Phản hồi STT (1-10) để tải nhạc.`;
        const sentMsg = await api.sendMessage({ msg: infoMsg, attachments: [imagePath] }, threadId, threadType);

        // Lấy TẤT CẢ ID tin nhắn (văn bản + ảnh đính kèm) để xóa sạch sẽ
        const undoList = api.getUndoData(sentMsg);
        if (sentMsg.link) undoList.push({ msgId: String(sentMsg.link.msgId), cliMsgId: String(sentMsg.link.cliMsgId) });
        
        const realMsgId = undoList[0]?.msgId || "";
        const sessionData = { tracks, threadId, messageID: realMsgId, undoList };

        pendingScl.set(`${threadId}-${senderId}`, sessionData);
        if (realMsgId) pendingScl.set(realMsgId, sessionData);

        setTimeout(() => {
            pendingScl.delete(`${threadId}-${senderId}`);
            if (realMsgId) pendingScl.delete(realMsgId);
        }, 120000);
    } catch (e) { log.error("SCL Error:", e.message); }
}

export async function handle(ctx) {
    const { content, senderId, threadId, api, threadType, adminIds, message } = ctx;
    if (!adminIds.includes(String(senderId)) && !rentalManager.isRented(threadId)) return false;

    const choice = parseInt(content);
    if (isNaN(choice) || choice < 1 || choice > 10) return false;

    const quoteId = String(message?.data?.quote?.globalMsgId || message?.data?.quote?.msgId || "");
    const key = `${threadId}-${senderId}`;
    const session = (quoteId && pendingScl.has(quoteId)) ? pendingScl.get(quoteId) : pendingScl.get(key);

    if (!session || !session.tracks) return false;
    
    // Thu hồi TẤT CẢ các tin nhắn liên quan (Xóa sạch cả chữ lẫn ảnh)
    if (session.undoList && session.undoList.length > 0) {
        api.undoMessage(session.undoList, threadId, threadType).catch(() => {});
    }

    const track = session.tracks[choice - 1];
    // Guard: track phải có permalink_url mới download được
    if (!track || !track.permalink_url) return false;

    pendingScl.delete(key);
    if (session.messageID) pendingScl.delete(session.messageID);

    const tempMp3 = path.join(downloadDir, `scl_${Date.now()}.mp3`);
    const pPath = path.join(downloadDir, `scl_p_${Date.now()}.png`);
    const tSpin = path.join(downloadDir, `spin_${Date.now()}.webp`);

    try {
        const dlResult = await download(track.permalink_url);
        const url = dlResult?.url;
        if (!url) {
            await api.sendMessage({ msg: "⚠️ Không lấy được link stream SoundCloud. Thử bài khác nhé!" }, threadId, threadType);
            return true;
        }

        const res = await axios({ method: 'get', url, responseType: 'stream' });
        await pipeline(res.data, fs.createWriteStream(tempMp3));

        if (api.sendVoiceUnified) {
            await api.sendVoiceUnified({ filePath: tempMp3, threadId, threadType });
        } else {
            await api.sendMessage({ msg: "🎧 Bản nhạc của bạn", attachments: [tempMp3] }, threadId, threadType);
        }

        const buf = await drawZingPlayer({
            title: track.title,
            artistsNames: track.user?.username,
            thumbnail: (track.artwork_url || "").replace("-large", "-t500x500"),
            duration: Math.floor(track.duration / 1000),
            sourceName: "SoundCloud"
        });
        fs.writeFileSync(pPath, buf);
        await api.sendMessage({ msg: "", attachments: [pPath] }, threadId, threadType);

        if (track.artwork_url) {
            if (await createSpinningSticker(track.artwork_url.replace("-large", "-t500x500"), tSpin)) {
                await processAndSendSticker(api, message, tSpin, false);
            }
        }
    } catch (e) {
        log.error("Scl Handle Error:", e.stack || e.message);
    } finally {
        [tempMp3, pPath, tSpin].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    }
    return true;
}