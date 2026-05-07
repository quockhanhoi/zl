import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import spotify from "../utils/spotify.js";
import spotdl from "../utils/spotdl-wrapper.js";
import { getGeniusLyrics } from "../utils/genius.js";
import { drawZingPlayer, drawZingSearch } from "../utils/canvasHelper.js";
import { processAndSendSticker } from "../utils/send-sticker/send-sticker/send-sticker.js";
import { uploadToTmpFiles } from "../utils/tmpFiles.js";
import { createSpinningSticker } from "../utils/process-audio.js";

const tempDir = path.join(process.cwd(), "src", "modules", "cache", "temp");
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

export const name = "spotify";
export const description = "Tải nhạc từ Spotify đẹp rực rỡ";

const searchCache = new Map();

async function sendBeautifulPlayerCard(ctx, songInfo) {
    const { api, threadId, threadType } = ctx;
    try {
        const trackObj = {
            title: songInfo.title || "Spotify Track",
            artistsNames: songInfo.artist || "Unknown Artist",
            thumbnail: songInfo.thumbnail || "https://developer.spotify.com/images/guidelines/design/icon3@2x.png",
            duration: songInfo.duration || "0:00",
            sourceName: "SPOTIFY"
        };


        const playerImgBuffer = await drawZingPlayer(trackObj);
        const playerPath = path.join(tempDir, `spt_card_${Date.now()}.png`);
        fs.writeFileSync(playerPath, playerImgBuffer);

        const remotePlayerUrl = await uploadToTmpFiles(playerPath, api, threadId, threadType);
        const statusMsg = `[ 🎧 SPOTIFY PLAYER ]\n─────────────────\n🎵 Bài hát: ${trackObj.title}\n👤 Ca sĩ: ${trackObj.artistsNames}\n─────────────────\nChúc bạn nghe nhạc thư giãn! ✨`;

        if (remotePlayerUrl) {
            await api.sendImageEnhanced({ imageUrl: remotePlayerUrl, threadId, threadType, width: 800, height: 260, msg: statusMsg });
        } else {
            await api.sendMessage({ msg: statusMsg, file: fs.createReadStream(playerPath) }, threadId, threadType);
        }

        const spinPath = path.join(tempDir, `spin_spt_${Date.now()}.webp`);
        if (await createSpinningSticker(trackObj.thumbnail, spinPath)) {
            await processAndSendSticker(api, ctx.message, spinPath, false);
            if (fs.existsSync(spinPath)) fs.unlinkSync(spinPath);
        }

        if (fs.existsSync(playerPath)) fs.unlinkSync(playerPath);
    } catch (e) {
        console.error("Lỗi vẽ card Spotify:", e.message);
    }
}

export const commands = {
    spt: async (ctx) => {
        const { api, threadId, threadType, senderId, args, message } = ctx;
        const input = args.join(" ").trim();
        if (!input) return api.sendMessage({ msg: "⚠️ Nhập tên bài hát hoặc link Spotify!" }, threadId, threadType);

        await api.addReaction("🔍", message).catch(() => { });


        const linkMatch = input.match(/track\/([a-zA-Z0-9]+)/);
        if (linkMatch) {
            try {
                const { success, filePath, error } = await spotdl.download(`https://open.spotify.com/track/${linkMatch[1]}`);
                if (!success) throw new Error(error || "Không lấy được link tải MP3 qua spotDL.");

                const tempPath = filePath;

                await api.addReaction("🎵", message).catch(() => { });


                await api.sendVoiceUnified({ filePath: tempPath, threadId, threadType });
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);


                // Placeholder metadata for link downloads
                const trackInfo = {
                    title: "Spotify Track",
                    artist: "Spotify Artist",
                    thumbnail: "https://developer.spotify.com/images/guidelines/design/icon3@2x.png",
                    duration: "0:00"
                };

                await sendBeautifulPlayerCard(ctx, trackInfo);
                await api.addReaction("✅", message).catch(() => { });
            } catch (e) {
        await api.addReaction("⚠️", message).catch(() => { });
                api.sendMessage({ msg: ` Lỗi: ${e.message}` }, threadId, threadType);
            }
            return;
        }


        try {
            const results = await spotify.search(input);
            if (results.length === 0) {
                await api.addReaction("⚠️", message).catch(() => { });
                return api.sendMessage({ msg: " Không tìm thấy bài hát này." }, threadId, threadType);
            }
            const searchImgBuffer = await drawZingSearch(results, input, "SPOTIFY");
            const searchImgPath = path.join(tempDir, `spt_search_${Date.now()}.png`);
            fs.writeFileSync(searchImgPath, searchImgBuffer);

            const remoteUrl = await uploadToTmpFiles(searchImgPath, api, threadId, threadType);
            const caption = `🔍 Kết quả tìm kiếm cho: "${input}"\n💡 Phản hồi STT hoặc "STT mp3/lyric" để tải.`;

            let sentMsg;
            if (remoteUrl) {
                sentMsg = await api.sendImageEnhanced({ imageUrl: remoteUrl, threadId, threadType, width: 1280, height: 720, msg: caption });
            } else {
                sentMsg = await api.sendMessage({ msg: caption, file: fs.createReadStream(searchImgPath) }, threadId, threadType);
            }

            if (fs.existsSync(searchImgPath)) fs.unlinkSync(searchImgPath);
            await api.addReaction("✅", message).catch(() => { });

            const undoData = { msgId: String(sentMsg?.data?.msgId || ""), cliMsgId: String(sentMsg?.data?.cliMsgId || "") };
            const realMsgId = undoData.msgId;
            const session = {
                results: results,
                senderId: senderId,
                undoData: undoData,
                timeout: setTimeout(() => {
                    api.undoMessage(session.undoData, threadId, threadType).catch(() => { });
                    if (realMsgId) searchCache.delete(realMsgId);
                    searchCache.delete(`${threadId}_${senderId}`);
                }, 60000)
            };
            if (realMsgId) searchCache.set(realMsgId, session);
            searchCache.set(`${threadId}_${senderId}`, session);
        } catch (e) {
            await api.addReaction("⚠️", message).catch(() => { });
            api.sendMessage({ msg: "⚠️ Có lỗi xảy ra khi tìm kiếm." }, threadId, threadType);
        }
    }
};

export async function handle(ctx) {
    const { api, threadId, threadType, senderId, content, message } = ctx;
    if (!content || message.isSelf) return false;

    const quoteId = message.data.quote?.msgId || message.data.quote?.globalMsgId;
    let session = quoteId ? searchCache.get(quoteId) : (/^[1-8](\s+(mp3|lyric))?$/i.test(content) ? searchCache.get(`${threadId}_${senderId}`) : null);

    if (!session || senderId !== session.senderId) return false;

    const lowerContent = content.toLowerCase();
    const isMp3 = lowerContent.includes("mp3");
    const isLyric = lowerContent.includes("lyric");
    const num = parseInt(content);
    if (isNaN(num) || num < 1 || num > session.results.length) return false;

    api.undoMessage(session.undoData, threadId, threadType).catch(() => { });
    clearTimeout(session.timeout);
    searchCache.delete(`${threadId}_${senderId}`);

    const track = session.results[num - 1];
    await api.addReaction("🎵", message).catch(() => { });

    try {

        const { success, filePath, error } = await spotdl.download(track.isSpotify ? `https://open.spotify.com/track/${track.id}` : `${track.title} ${track.artist}`);
        if (!success) throw new Error(error || "Nguồn này hiện không khả dụng.");

        const tempPath = filePath;

        if (isMp3) await api.sendFile(tempPath, threadId, threadType);
        else await api.sendVoiceUnified({ filePath: tempPath, threadId, threadType });

        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

        await sendBeautifulPlayerCard(ctx, {
            title: track.title,
            artist: track.artist,
            thumbnail: track.thumbnail,
            duration: track.duration
        });

        if (isLyric) {
            let lyrics = await spotify.getLyrics(track.id, track.thumbnail, track.title, track.artist);
            if (!lyrics) {
                // Fallback qua Genius nếu Spotify không có lời
                lyrics = await getGeniusLyrics(`${track.title} ${track.artist}`);
            }

            if (lyrics) {
                await api.sendMessage({ msg: `[ 📝 LYRICS: ${track.title.toUpperCase()} ]\n─────────────────\n${lyrics}` }, threadId, threadType);
            } else {
                await api.sendMessage({ msg: `⚠️ Rất tiếc, cả Spotify và Genius đều không có lời cho bài này.` }, threadId, threadType);
            }
        }

        await api.addReaction("✅", message).catch(() => { });
    } catch (e) {
        await api.addReaction("⚠️", message).catch(() => { });
        api.sendMessage({ msg: ` Lỗi: ${e.message}` }, threadId, threadType);
    }
    return true;
}
