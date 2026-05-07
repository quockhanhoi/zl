import axios from 'axios';
import youtubedl from 'yt-dlp-exec';
import { log } from '../logger.js';

/**
 * downloadAll sử dụng API subhatde.id.vn
 * Hỗ trợ đa nền tảng: Facebook, YouTube, TikTok, Instagram...
 */
const API_URL = "https://api.subhatde.id.vn/api/downall";
const API_KEY = "682166a8f47ccd60713e668e50916d9c";

async function downloadYtDlpFallback(url) {
    try {
        const result = await youtubedl(url, {
            dumpSingleJson: true,
            noWarnings: true,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'
        });

        if (!result) return null;

        const medias = [];
        if (result.url) {
            medias.push({
                url: result.url,
                quality: result.format || "Default",
                extension: result.ext || "mp4",
                type: "video"
            });
        }

        return {
            source: "yt-dlp",
            title: result.title || "Video",
            author: result.uploader || result.uploader_id || "N/A",
            thumbnail: result.thumbnail || null,
            duration: result.duration || 0,
            medias: medias
        };
    } catch (e) {
        console.error("Lỗi yt-dlp fallback:", e.message);
        return null;
    }
}

export async function downloadAll(link) {
    try {
        const { data: resObj } = await axios.get(API_URL, {
            params: {
                url: link,
                apikey: API_KEY
            },
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'
            }
        });

        if (!resObj || !resObj.medias || resObj.medias.length === 0) {
            log.warn(`[SOCIAL] SubHatDe rỗng, thử yt-dlp cho: ${link}`);
            const ytdlp = await downloadYtDlpFallback(link);
            if (ytdlp) return ytdlp;
            return { error: true, message: "⚠️ Không tìm thấy media phù hợp." };
        }

        // Cho phép toàn bộ media, không lọc bỏ thunzilla nữa theo yêu cầu
        const filteredMedias = resObj.medias;

        if (filteredMedias.length === 0) {
            const ytdlp = await downloadYtDlpFallback(link);
            if (ytdlp) return ytdlp;
            return { error: true, message: "⚠️ Không tìm thấy media phù hợp." };
        }

        const medias = filteredMedias.map(m => {
            let url = m.url;
            let type = "video";
            const isImg = m.type.includes("image") || /\.(jpg|jpeg|png|webp|heic)(\?|$)/i.test(url);
            const isAudio = m.type.includes("audio") || /\.(mp3|wav|ogg|m4a)(\?|$)/i.test(url);

            if (isImg) type = "image";
            else if (isAudio) type = "audio";

            let extension = type === "video" ? "mp4" : (type === "audio" ? "mp3" : "jpg");
            if (m.type && m.type.includes('/')) {
                extension = m.type.split('/')[1];
            } else if (type === "image") {
                extension = "jpg";
            }

            return {
                url: m.url,
                quality: m.quality || "Default",
                extension: extension,
                type: type
            };
        });

        let authorName = "Người dùng Facebook";
        if (resObj.author) {
            if (typeof resObj.author === 'string') {
                authorName = resObj.author;
            } else if (typeof resObj.author === 'object') {
                authorName = resObj.author.name || resObj.author.nickname || resObj.author.username || resObj.author.display_name || "Người dùng Facebook";
            }
        }

        return {
            source: "subhatde-api",
            title: resObj.title || "Video Facebook",
            author: authorName,
            thumbnail: resObj.thumbnail || resObj.author?.image || resObj.author?.avatar || "https://photo-stal-17.zdn.vn/gr/jpg/f288c96bd87e1920406f/1321651193041366091.jpg",
            duration: 0,
            medias: medias
        };

    } catch (err) {
        console.error("Lỗi SubHatDe API:", err.message);
        return { error: true, message: `⚠️ Lỗi kết nối API SubHatDe: ${err.message}` };
    }
}
