import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { searchMixcloud, downloadMixcloud } from "../utils/mixcloudDownloader.js";
import { sendAudio } from "../events/autodown.js";
import { drawZingSearch } from "../utils/canvasHelper.js";
import { uploadToTmpFiles } from "../utils/tmpFiles.js";

export const name = "mcl";
export const description = "Tìm kiếm và nghe nhạc Mixcloud với giao diện Canvas";

const tempDir = path.join(process.cwd(), "src", "modules", "cache", "temp");
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const searchCache = new Map();

export const commands = {
    mcl: async (ctx) => {
        const { api, threadId, threadType, senderId, args, message } = ctx;
        const input = args.join(" ").trim();
        if (!input) return api.sendMessage({ msg: "⚠️ Nhập tên mixtape hoặc link Mixcloud!" }, threadId, threadType);

        await api.addReaction("🔍", message).catch(() => { });

        try {
            const results = await searchMixcloud(input, 8);
            if (!results || results.length === 0) {
                await api.addReaction("⚠️", message).catch(() => { });
                return api.sendMessage({ msg: "Không tìm thấy kết quả nào." }, threadId, threadType);
            }

            const searchImgBuffer = await drawZingSearch(results, input, "MIXCLOUD");
            const searchImgPath = path.join(tempDir, `mcl_search_${Date.now()}.png`);
            fs.writeFileSync(searchImgPath, searchImgBuffer);

            const remoteUrl = await uploadToTmpFiles(searchImgPath, api, threadId, threadType);
            const caption = `🔍 Kết quả tìm kiếm cho: "${input}"\n💡 Phản hồi số thứ tự để chọn bài.`;

            let sentMsg;
            if (remoteUrl) {
                sentMsg = await api.sendImageEnhanced({ imageUrl: remoteUrl, threadId, threadType, width: 1280, height: 720, msg: caption });
            } else {
                sentMsg = await api.sendMessage({ msg: caption, file: fs.createReadStream(searchImgPath) }, threadId, threadType);
            }

            if (fs.existsSync(searchImgPath)) fs.unlinkSync(searchImgPath);
            await api.addReaction("✅", message).catch(() => { });

            const msgId = String(sentMsg?.data?.msgId || sentMsg?.data?.globalMsgId || "");
            const session = {
                results: results,
                senderId: senderId,
                msgId: msgId,
                timeout: setTimeout(() => {
                    searchCache.delete(msgId);
                    searchCache.delete(`${threadId}_${senderId}`);
                }, 60000)
            };

            if (msgId) searchCache.set(msgId, session);
            searchCache.set(`${threadId}_${senderId}`, session);

        } catch (e) {
            await api.addReaction("⚠️", message).catch(() => { });
            api.sendMessage({ msg: "Có lỗi xảy ra khi tìm kiếm." }, threadId, threadType);
        }
    }
};

export async function handle(ctx) {
    const { api, threadId, threadType, senderId, content, message } = ctx;
    if (!content || message.isSelf) return false;

    const quoteId = String(message.data.quote?.msgId || message.data.quote?.globalMsgId || "");
    let session = quoteId ? searchCache.get(quoteId) : (/^[1-8]$/.test(content.trim()) ? searchCache.get(`${threadId}_${senderId}`) : null);

    if (!session || senderId !== session.senderId) return false;

    const num = parseInt(content.trim());
    if (isNaN(num) || num < 1 || num > session.results.length) return false;

    // Thả icon xác nhận chọn đúng
    await api.addReaction("🎵", message).catch(() => { });

    clearTimeout(session.timeout);
    searchCache.delete(session.msgId);
    searchCache.delete(`${threadId}_${senderId}`);

    const track = session.results[num - 1];

    try {
        const fullUrl = `https://www.mixcloud.com${track.url}`;
        const data = await downloadMixcloud(fullUrl);
        
        if (!data || data.error) throw new Error(data?.error || "Không lấy được nhạc.");

        const infoMsg = `☁️ Mixcloud Player\n─────────────────\n🎵 ${data.title}\n👤 ${data.artist || data.author}\n⏳ ${Math.floor(data.duration / 60)} phút`;
        await api.sendMessage({ msg: infoMsg }, threadId, threadType);

        // Sử dụng sendAudio để tận dụng mode Copy siêu tốc
        await sendAudio(api, data.streamUrl || data.hlsUrl, threadId, threadType);
        
        await api.addReaction("✅", message).catch(() => { });
    } catch (e) {
        await api.addReaction("⚠️", message).catch(() => { });
        api.sendMessage({ msg: `Lỗi: ${e.message}` }, threadId, threadType);
    }
    return true;
}
