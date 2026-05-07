import axios from 'axios';
import zing from './zingmp3.js';

let SPOTIFY_TOKEN = "BQAFTKQ7F5duT2fMfJttQfEkh7GetOTqNwtmih8jmIva5z46hKLrLSeU6To7ctwr1wdVY_AF3aZ6v4qdhdPJrRiKR43cFWTorE4edEo5Oi1risDUa5zYurEIq4xdg53zdj2kKB4wUme2VPQKGKXnVmX_VNwd7516w_ry7qXnHqh7M5duZz-z2w77IAtVdi9X2hi463KIRn2ZuY6NmM2b5ZPAHB2GIw4AXXhAURFy1m5K8zJuBykGe5b4OV8NQs3077p3mu5dW-1B94ntslDbC5a33yxhmouDmx5NaPZ_sc2hlC-bMxGuwDYuVZlBRVjM3tgweGJ_NWEehpx-t0pM4Q1C3Ib2S0qmaoJuH95SSGiTysjni3OyOro3ykCtrEmv9_Khw4buCHezzgm7hw";
let CLIENT_TOKEN = "AAAI78Fcz1TQiPf+cSOQada/VI7ksCJ29zv4tCQ1PQ5Dr5MAVmjfPYl6dE+R5fVTPOS1XlVstFR7QsP5T4k9/yMgDnZ6Nj6aw9xRSkUuq9brdLeBFU0yuDhSgSGzb2QX/CKK+30/UukAAY9dgomiWO4F6h37XhCWi2y/OsVB7io4W/PjXviHBuBMwzipxiyrMofPHEx72/VvtAdtA8SydcCZB7KJ5Fg9rRPdqn9MIahFxDycfZLflDjCv+0UuijdqnIGGqNQL+HjsFvbwU/ODPoF3VSKTW+BbEppuDVkn+vLCdZXRvnK/KT6G041FvbRjg04XyOjMO44ZRLeYSfNsounOfs=";
let TOKEN_EXPIRY = Date.now() + 3600000;

function convert(ms) {
    const m = Math.floor(ms / 60000);
    const s = ((ms % 60000) / 1000).toFixed(0);
    return m + ":" + (s < 10 ? "0" : "") + s;
}

/**
 * Lấy Access Token mới từ Spotify (Guest Token)
 */
async function refreshToken() {
    if (SPOTIFY_TOKEN && Date.now() < TOKEN_EXPIRY) return;
    try {
        const res = await axios.get('https://open.spotify.com/get_access_token?reason=transport&productType=web_player', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                'referer': 'https://open.spotify.com/',
                'origin': 'https://open.spotify.com'
            },
            timeout: 5000
        });
        if (res.data?.accessToken) {
            SPOTIFY_TOKEN = res.data.accessToken;
            TOKEN_EXPIRY = res.data.accessTokenExpirationTimestampMs || (Date.now() + 3000000);
            return true;
        }
    } catch (e) {
        // console.error("Lỗi làm mới Spotify Token:", e.message);
    }
    return false;
}

export async function search(query) {
    // 1. Dùng Deezer API siêu ổn định để tìm kiếm bài hát (tốc độ cao, catalog tương đương Spotify)
    try {
        const fall = await axios.get(`https://api.deezer.com/search?q=${encodeURIComponent(query)}`, { timeout: 8000 });
        if (fall.data && fall.data.data) {
            return fall.data.data.map(t => ({
                id: t.id.toString(),
                title: t.title, 
                artist: t.artist.name, 
                album: t.album.title || "",
                duration: convert(t.duration * 1000), // Deezer gives duration in seconds
                thumbnail: t.album.cover_xl || t.album.cover,
                isSpotify: false // Đánh dấu đây không phải ID Spotify để không gọi nhầm API tải Spotify
            }));
        }
    } catch (e) {
        // console.error("Lỗi tìm kiếm sơ cua Deezer:", e.message);
    }
    
    // 2. Dự phòng ZingMP3
    try {
        const results = await zing.searchZing(query);
        if (results && results.length > 0) {
            return results.map(t => ({
                id: t.encodeId,
                title: t.title,
                artist: t.artistsNames,
                album: "",
                duration: convert(t.duration * 1000),
                thumbnail: t.thumbnailM || t.thumbnail,
                isSpotify: false
            }));
        }
    } catch { }

    return [];
}

/**
 * TẢI NHẠC 
 */
export async function download(id, title = "", artist = "") {
    try {
        let trackId = id.toString();
        
        // Nếu là ID chuẩn của Spotify (Base62) thì ta gọi trực tiếp API tải Spotify
        const isSpotifyID = !/^\d+$/.test(trackId) && !trackId.startsWith("Z"); 

        if (isSpotifyID) {
            // Tải nhạc Spotify trực tiếp qua VgaSoft
            const vgaData = await downloadFromVgaSoft(trackId);
            if (vgaData) return vgaData;
            
            const spotifyDownData = await downloadFromSpotifyDown(trackId);
            if (spotifyDownData) return spotifyDownData;
        }

        // Nếu ID là số (Deezer) hoặc ID Zing (Zxxxx), ta skip API Spotify và qua Zing luôn! 
        // Zing MP3 làm Fallback xử lý tải MP3 siêu chuẩn xác (Dựa trên title và artist lấy đc từ Deezer).
        const zingData = await downloadFromZing(title, artist);
        if (zingData) return zingData;

        throw new Error("Không lấy được link tải bài hát này từ hệ thống. Bạn có thể thử tìm từ khóa khác!");
    } catch (e) {
        throw new Error(e.message || "Lỗi không xác định khi tải nhạc");
    }
}

async function downloadFromVgaSoft(spId) {
    try {
        const spotifyLink = `https://open.spotify.com/track/${spId}`;
        const vgaApi = `https://download.vgasoft.vn/web/c/spotify/getVideo?link=${encodeURIComponent(spotifyLink)}`;
        const headers = { 'User-Agent': 'Mozilla/5.0', 'OS': 'webSite', 'Referer': 'https://downloadvideo.vn/', 'Origin': 'https://downloadvideo.vn' };
        const res = await axios.get(vgaApi, { headers, timeout: 15000 });
        const result = res.data?.result;
        if (!result) return null;
        const mp3Url = result.music?.[0]?.url || result.music?.[0]?.link;
        if (mp3Url) return { id: spId, primaryUrl: mp3Url, title: result.title || "Spotify Track", thumbnail: result.thumbnail };
    } catch { return null; }
}

async function downloadFromSpotifyDown(spId) {
    try {
        const res = await axios.get(`https://api.spotifydown.com/download/${spId}`, {
            headers: { 'Origin': 'https://spotifydown.com', 'Referer': 'https://spotifydown.com/', 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000
        });
        if (res.data?.success && res.data.link) {
            return { id: spId, primaryUrl: res.data.link, title: res.data.metadata?.title, artist: res.data.metadata?.artists, thumbnail: res.data.metadata?.cover };
        }
    } catch { return null; }
    return null;
}

async function downloadFromZing(title, artist) {
    try {
        const query = `${title} ${artist}`.trim();
        const results = await zing.searchZing(query);
        if (results.length > 0) {
            const first = results[0];
            const stream = await zing.getStreamZing(first.encodeId);
            const url = stream?.["128"] || stream?.["320"];
            if (url) {
                return {
                    id: first.encodeId,
                    primaryUrl: url,
                    title: first.title,
                    artist: first.artistsNames,
                    thumbnail: first.thumbnail
                };
            }
        }
    } catch { return null; }
    return null;
}

/**
 * LẤY LYRICS 
 */
export async function getLyrics(trackId, coverUrl, title = "", artist = "") {
    await refreshToken();
    try {
        let spId = trackId.toString();
        if (/^\d+$/.test(spId)) {
            const query = `${title} ${artist}`;
            const searchResults = await search(query);
            const found = searchResults.find(r => r.isSpotify);
            if (found) spId = found.id;
            else return null;
        }

        const url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${spId}/image/${encodeURIComponent(coverUrl)}?format=json&vocalRemoval=false&market=from_token`;
        const res = await axios.get(url, {
            headers: { 'authorization': `Bearer ${SPOTIFY_TOKEN}`, 'client-token': CLIENT_TOKEN, 'app-platform': 'WebPlayer', 'user-agent': 'Mozilla/5.0' },
            timeout: 8000
        });
        if (res.data?.lyrics?.lines) return res.data.lyrics.lines.map(line => line.words).filter(w => w && w.trim() !== "").join('\n');
    } catch (e) { }
    return null;
}

export default { search, download, getLyrics };
