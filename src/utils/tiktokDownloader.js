import axios from "axios";
import { log } from "../logger.js";
import youtubedl from "yt-dlp-exec";
import { getTiktokUserPosts as getUserPostsFromApi } from "./tiktokApi.js";

// Bộ Header chuẩn để bypass Cloudflare TikWM (đã test thành công)
const tikwmHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    "Referer": "https://trondbargie.nl/",
    "Origin": "https://trondbargie.nl",
    "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    "Accept": "application/json, text/javascript, */*; q=0.01"
};

/**
 * Nguồn 1: TikWM (Với cấu hình mới cực mạnh)
 */
async function downloadTikWM(url) {
    try {
        const { data } = await axios.get(`https://tikwm.com/api/?url=${encodeURIComponent(url)}`, { 
            headers: tikwmHeaders,
            timeout: 10000 
        });
        if (!data || data.code !== 0) return null;
        const item = data.data;
        return {
            source: "TikWM",
            id: item.id,
            uniqueId: item.author?.unique_id,
            title: item.title,
            author: item.author?.nickname,
            videoUrl: item.images?.length > 0 ? null : (item.play || item.wmplay),
            audioUrl: item.music || item.music_info?.play || null,
            images: item.images || [],
            cover: item.cover || item.origin_cover,
            stats: { likes: item.digg_count, views: item.play_count }
        };
    } catch { return null; }
}

/**
 * Nguồn 2: TiklyDown (Dự phòng)
 */
async function downloadTikly(url) {
    try {
        const { data } = await axios.get(`https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(url)}`, { timeout: 10000 });
        if (!data || (!data.video && (!data.images || data.images.length === 0))) return null;
        return {
            source: "TiklyDown", id: data.id, uniqueId: data.author?.unique_id,
            title: data.title, author: data.author?.nickname,
            videoUrl: data.images?.length > 0 ? null : (data.video.noWatermark || data.video.watermark),
            audioUrl: data.music?.play_url || data.music || null,
            images: data.images?.map(img => img.url) || [],
            cover: data.thumbnail
        };
    } catch { return null; }
}

/**
 * Nguồn 3: yt-dlp
 */
async function downloadYtDlp(url) {
    try {
        const result = await youtubedl(url, { dumpSingleJson: true, noCheckCertificates: true, noWarnings: true, preferFreeFormats: true });
        return { source: "yt-dlp", id: result.id, title: result.title, author: result.uploader, videoUrl: result.url, audioUrl: result.audio_url || null, cover: result.thumbnail };
    } catch { return null; }
}

export async function downloadTikTok(url) {
    // Ưu tiên TikWM vì đã test LIVE
    let res = await downloadTikWM(url);
    if (res) return res;
    
    // Thử các nguồn dự phòng
    res = await downloadTikly(url);
    if (res) return res;
    
    res = await downloadYtDlp(url);
    if (res) return res;
    
    return null;
}

export const setTikWMCookie = () => true;
export const getTiktokUserPosts = getUserPostsFromApi;
export const getUserPosts = getUserPostsFromApi;
