import fetch from "node-fetch";
import { log } from "../logger.js";

/**
 * Tìm kiếm lời bài hát từ LRCLIB (Miễn phí, không bị Cloudflare chặn)
 * @param {string} query Tên bài hát + ca sĩ
 * @returns {Promise<string|null>} Lời bài hát hoặc null
 */
export async function getGeniusLyrics(query) {
    try {
        log.info(`[LRCLIB] Đang tìm lời cho: ${query}`);
        const url = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;
        const res = await fetch(url);
        
        if (!res.ok) {
            log.error(`[LRCLIB] Lỗi API: ${res.status}`);
            return null;
        }

        const data = await res.json();
        if (!data || data.length === 0) return null;

        // Ưu tiên bài có plainLyrics
        const song = data.find(s => s.plainLyrics) || data[0];
        return song.plainLyrics || null;
    } catch (e) {
        log.error(`[LRCLIB] Lỗi lấy lời: ${e.message}`);
        return null;
    }
}

/**
 * Tìm kiếm bài hát và trả về thông tin chi tiết
 * @param {string} query 
 */
export async function searchGenius(query) {
    try {
        const url = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;
        const res = await fetch(url);
        const data = await res.json();
        
        return data.map(s => ({
            id: s.id,
            title: s.trackName,
            artist: s.artistName,
            thumbnail: "", // LRCLIB không có ảnh bìa
            url: `https://lrclib.net/api/get/${s.id}`
        }));
    } catch (e) {
        log.error(`[LRCLIB] Lỗi tìm kiếm: ${e.message}`);
        return [];
    }
}

export default { getGeniusLyrics, searchGenius };
