import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import retry from "async-retry";
import { log } from "../logger.js";

const tikwmHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    "Referer": "https://trondbargie.nl/",
    "Origin": "https://trondbargie.nl",
    "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    "Accept": "application/json, text/javascript, */*; q=0.01"
};

const KHOTOOLS_KEY = "sk_test_ZJE7r8txplRZVYmJ84UF_uR1JWDuA4Wx";
const khotoolsHeaders = {
    "x-api-key": KHOTOOLS_KEY,
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json"
};

const tiktokvApi = "https://api16-normal-useast5.tiktokv.us";

const tiktokApiParams = (args) => {
    return new URLSearchParams({
        ...args,
        version_name: "1.1.9", version_code: "2018111632", device_id: "7238642534011110914",
        iid: "7318518857994389254", device_platform: "android", channel: "googleplay"
    }).toString();
};

export const reqIdVideoTiktok = async (url) => {
    url = url.replace("https://vm", "https://vt");
    try {
        const { request } = await axios({ method: "HEAD", url });
        const { responseUrl } = request.res;
        return responseUrl.match(/\d{17,21}/g)?.[0] || null;
    } catch { return null; }
};

export const fetchTiktokData = async (ID) => {
    try {
        return await retry(async () => {
            const url = `${tiktokvApi}/aweme/v1/feed/?${tiktokApiParams({ aweme_id: ID })}`;
            const res = await axios(url, { headers: { "User-Agent": "com.zhiliaoapp.musically/300904" } });
            return res.data.aweme_list[0];
        }, { retries: 3 });
    } catch { return null; }
};

const _mapUserPosts = (videos, cleanId) => {
    const TIKWM_BASE = "https://www.tikwm.com";
    return videos.map(v => ({
        id: v.video_id, desc: v.title, cover: v.cover,
        author: { id: v.author?.id, uniqueId: v.author?.unique_id || cleanId, nickname: v.author?.nickname || cleanId },
        stat: { diggCount: v.digg_count, playCount: v.play_count },
        play: v.play ? (v.play.startsWith("http") ? v.play : TIKWM_BASE + v.play) : null,
        music: v.music ? (v.music.startsWith("http") ? v.music : TIKWM_BASE + v.music) : null
    }));
};

// Map kết quả từ khotools API (awemeList format)
const _mapKhotoolsPosts = (awemeList, fallbackId = "") => {
    return awemeList.map(v => {
        const videoMedia = v.medias?.find(m => m.type === "video");
        const audioMedia = v.medias?.find(m => m.type === "audio");
        return {
            id: v.id,
            desc: v.title || "",
            cover: v.cover || v.thumbnail || null,
            author: {
                uniqueId: v.author?.unique_id || v.author?.uniqueId || fallbackId,
                nickname: v.author?.nickname || fallbackId
            },
            stat: { diggCount: v.digg_count || v.stats?.likes || 0, playCount: v.play_count || 0 },
            play: videoMedia?.url || v.play || null,
            music: audioMedia?.url || v.music || null
        };
    });
};

export const getTiktokUserPosts = async (uniqueId, limit = 10) => {
    const cleanId = uniqueId.startsWith("@") ? uniqueId.slice(1) : uniqueId;
    const count = Math.min(limit * 2, 50);

    // CÁCH 1: POST request TikWM (mặc định)
    try {
        const { data } = await axios.post("https://tikwm.com/api/user/posts",
            new URLSearchParams({ unique_id: cleanId, count, cursor: 0 }),
            { headers: tikwmHeaders, timeout: 12000 }
        );
        if (data?.code === 0 && data.data?.videos?.length > 0) {
            log.info(`[TikTokAPI] user/posts POST OK cho @${cleanId}: ${data.data.videos.length} video`);
            return _mapUserPosts(data.data.videos.slice(0, limit), cleanId);
        }
    } catch (e) {
        log.warn(`[TikTokAPI] user/posts POST thất bại (${e.response?.status || e.message}), thử GET TikWM...`);
    }

    // CÁCH 2: GET TikWM (fallback khi POST bị block)
    try {
        const { data } = await axios.get(`https://tikwm.com/api/user/posts`,
            {
                params: { unique_id: cleanId, count, cursor: 0 },
                headers: { ...tikwmHeaders, "Content-Type": undefined },
                timeout: 12000
            }
        );
        if (data?.code === 0 && data.data?.videos?.length > 0) {
            log.info(`[TikTokAPI] user/posts GET OK cho @${cleanId}: ${data.data.videos.length} video`);
            return _mapUserPosts(data.data.videos.slice(0, limit), cleanId);
        }
    } catch (e) {
        log.warn(`[TikTokAPI] user/posts GET thất bại (${e.response?.status || e.message}), thử khotools...`);
    }

    // CÁCH 3: khotools user-aweme-list
    try {
        const { data } = await axios.get("https://api.khotools.com/api/v1/tiktok/user-aweme-list", {
            params: { username: cleanId, cursor: 0, maxCursor: 0 },
            headers: khotoolsHeaders,
            timeout: 12000
        });
        if (data?.awemeList?.length > 0) {
            log.info(`[TikTokAPI] khotools user-aweme-list OK cho @${cleanId}: ${data.awemeList.length} video`);
            return _mapKhotoolsPosts(data.awemeList.slice(0, limit), cleanId);
        }
    } catch (e) {
        log.warn(`[TikTokAPI] khotools user-aweme-list thất bại (${e.response?.status || e.message}), thử search+filter...`);
    }

    // CÁCH 4: Search @username rồi filter đúng tác giả (fallback cuối)
    try {
        log.info(`[TikTokAPI] Dùng search+filter cho @${cleanId}...`);
        const searchRes = await searchTiktok(`@${cleanId}`, 50);
        const filtered = searchRes.filter(v =>
            v.author?.uniqueId === cleanId ||
            (v.author?.uniqueId || "").toLowerCase() === cleanId.toLowerCase()
        );
        if (filtered.length > 0) {
            log.info(`[TikTokAPI] search+filter cho @${cleanId}: lấy được ${filtered.length} video đúng user`);
            return filtered.slice(0, limit);
        }
    } catch (e) {
        log.warn(`[TikTokAPI] search+filter lỗi: ${e.message}`);
    }

    return [];
};

// Lấy video FYP (For You Page) từ khotools API
export const getTiktokFYP = async (count = 6) => {
    try {
        const { data } = await axios.get("https://api.khotools.com/api/v1/tiktok/fyp-feed", {
            params: { count, maxCursor: 0, minCursor: 0, pullType: 0, type: 0 },
            headers: khotoolsHeaders,
            timeout: 12000
        });
        if (data?.awemeList?.length > 0) {
            log.info(`[TikTokAPI] FYP feed OK: ${data.awemeList.length} video`);
            return _mapKhotoolsPosts(data.awemeList);
        }
        return [];
    } catch (e) {
        log.warn(`[TikTokAPI] FYP feed lỗi: ${e.message}`);
        return [];
    }
};

export const searchTiktok = async (keywords, limit = 10) => {
    try {
        // TikWM thường trả ít hơn count yêu cầu, nên request gấp đôi rồi slice
        const requestCount = Math.min(limit * 2, 100);
        const { data } = await axios.post("https://tikwm.com/api/feed/search", 
            new URLSearchParams({ keywords, count: requestCount, cursor: 0 }),
            { headers: tikwmHeaders, timeout: 10000 }
        );
        if (data && data.code === 0 && data.data?.videos) {
            const TIKWM_BASE = "https://www.tikwm.com";
            return data.data.videos.slice(0, limit).map(v => ({
                id: v.video_id, desc: v.title, cover: v.cover,
                author: { id: v.author?.id, uniqueId: v.author?.unique_id, nickname: v.author?.nickname },
                stat: { diggCount: v.digg_count, playCount: v.play_count },
                play: v.play ? (v.play.startsWith("http") ? v.play : TIKWM_BASE + v.play) : null,
                music: v.music ? (v.music.startsWith("http") ? v.music : TIKWM_BASE + v.music) : null
            }));
        }
        return [];
    } catch { return []; }
};

export const getDataDownloadVideo = async (url) => {
    const { downloadTikTok } = await import("./tiktokDownloader.js");
    return await downloadTikTok(url);
};

export const getTiktokRelated = async (idOfVideo) => [];
export const setTikWMCookie = () => true;

export const getTiktokUserInfo = async (username) => {
    try {
        const cleanName = username.startsWith("@") ? username.slice(1) : username;
        const { data } = await axios.get(`https://www.tikwm.com/api/user/info?unique_id=${cleanName}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 10000
        });
        
        if (data && data.code === 0 && data.data) {
            const user = data.data.user || {};
            const stats = data.data.stats || {};
            
            return {
                userid: user.id,
                username: user.uniqueId,
                fullname: user.nickname,
                profile: user.avatarLarger || user.avatarMedium || user.avatarThumb,
                verified: user.verified ? "Yes" : "No",
                followers: stats.followerCount,
                heart_count: stats.heartCount,
                video: stats.videoCount,
                region: user.region || "N/A",
                created_time: user.createTime ? new Date(user.createTime * 1000).toLocaleString("vi-VN") : "N/A"
            };
        }
        return null;
    } catch (e) {
        return null;
    }
};
