import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import * as cheerio from "cheerio";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { log } from "../logger.js";
import { drawMovieSearch, drawMovieDetail } from "../utils/canvasHelper.js";
import { fastDownloadM3U8 } from "../utils/fastM3u8.js";

try { ffmpeg.setFfmpegPath(ffmpegStatic); } catch {}
try { ffmpeg.setFfprobePath(ffprobeStatic.path); } catch {}

export const name = "khophim";
export const description = "Tim kiem va xem phim tu nycf.info";

const BASE = "https://nycf.info";
const CACHE_DIR = path.join(process.cwd(), "src/modules/cache");
const DEFAULT_MAX_VIDEO = 100 * 1024 * 1024;

const pendingSearch = new Map();
const pendingEpisode = new Map();

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

function ensureCache() {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function safeUnlink(p, delay = 0, retries = 3) {
    const rm = () => {
        try {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch (e) {
            if (e.code === 'EBUSY' && retries > 0) {
                retries--;
                setTimeout(rm, 1000);
            }
        }
    };
    delay > 0 ? setTimeout(rm, delay) : rm();
}

function getMaxVideoSize(api) {
    const ctx = api?.getContext?.() || api?.context || {};
    const sf = ctx?.settings?.features?.sharefile || {};
    const mb = Number(sf.max_size_share_file_v3 || sf.max_size_share_file || 0);
    if (!isFinite(mb) || mb <= 0) return DEFAULT_MAX_VIDEO;
    return Math.max(32, mb - 5) * 1024 * 1024;
}

// ─── Search API ───────────────────────────────────────────────────────────────
async function searchPhim(keyword) {
    const formData = new URLSearchParams();
    formData.append('action', 'search_film');
    formData.append('keyword', keyword);
    formData.append('limit', '5');

    const res = await axios.post(`${BASE}/wp-admin/admin-ajax.php`, formData.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...HEADERS }
    });

    const data = res.data;
    if (!Array.isArray(data)) return [];

    return data.map(item => ({
        slug: item.slug.replace(`${BASE}/phim/`, '').replace('/', ''),
        name: item.title,
        origin_name: item.original_title,
        thumb_url: item.image,
        poster_url: item.image_poster,
        year: item.year,
        lang: "Vietsub",
        quality: "HD",
        url: item.slug
    }));
}

// ─── Info & Episodes ──────────────────────────────────────────────────────────
async function getMovieInfo(slug) {
    const url = `${BASE}/phim/${slug}/`;
    const html = await axios.get(url, { headers: HEADERS }).then(r => r.data);
    const $ = cheerio.load(html);

    const title = $('h1').first().text().trim() || slug;
    const desc = $('.content-film p').text().trim() || "";
    const poster = $('.poster img').attr('src') || $('.poster img').attr('data-src') || "";
    
    // Find the first playback link
    const firstPlayLink = $('a.button_play').attr('href');
    
    let episodes = [];
    if (firstPlayLink) {
        try {
            const playHtml = await axios.get(firstPlayLink, { headers: HEADERS }).then(r => r.data);
            const $play = cheerio.load(playHtml);
            
            const seenNames = new Set();
            $play("a[href*='/xem-phim/']").each((i, el) => {
                const name = $play(el).text().trim();
                const link = $play(el).attr('href');
                
                // Avoid duplicates like "1", "2" from multiple servers
                if (name && link && !seenNames.has(name) && !name.includes("Xem Phim") && !name.includes("Download")) {
                    seenNames.add(name);
                    episodes.push({
                        name: `Tap ${name}`,
                        link_embed: link.startsWith('http') ? link : `${BASE}${link}`
                    });
                }
            });
            
            if (episodes.length === 0) {
                // Movie has only 1 episode
                episodes.push({
                    name: "Full",
                    link_embed: firstPlayLink.startsWith('http') ? firstPlayLink : `${BASE}${firstPlayLink}`
                });
            }
        } catch (e) {
            log.error("[KhoPhim] Loi lay danh sach tap:", e.message);
        }
    }

    return {
        info: {
            name: title,
            origin_name: "",
            description: desc,
            thumb_url: poster,
            poster_url: poster,
            year: "",
            time: "N/A",
            quality: "HD",
            lang: "Vietsub",
            status: episodes.length > 0 ? `${episodes.length} tap` : "Dang cap nhat",
            rating: "",
            category: [],
            country: [],
            slug: slug
        },
        episodes
    };
}

// ─── Scrape Streams ───────────────────────────────────────────────────────────
async function scrapeVideoFromEpisodePage(url) {
    try {
        const html = await axios.get(url, { headers: HEADERS }).then(r => r.data);
        const $ = cheerio.load(html);
        
        let m3u8s = [];
        $(".streaming-server").each((i, el) => {
            const link = $(el).attr('data-link');
            const type = $(el).attr('data-type');
            if (link && type === 'm3u8') {
                m3u8s.push(link);
            }
        });
        
        const m3u8Match = html.match(/https?:\/\/[^\s"']+\.m3u8/g);
        if (m3u8Match) m3u8s.push(...m3u8Match);

        return [...new Set(m3u8s)];
    } catch (e) {
        log.error("[KhoPhim] Scrape video error:", e.message);
        return [];
    }
}

// ─── Download & Compress ──────────────────────────────────────────────────────
async function downloadM3U8(m3u8Url, outputPath) {
    try {
        await fastDownloadM3U8(m3u8Url, outputPath, {
            headers: HEADERS,
            concurrency: 15,
            timeout: 120000
        });
    } catch (err) {
        safeUnlink(outputPath, 500);
        throw err || new Error("Khong tai duoc video");
    }
}

async function getVideoDuration(inputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, meta) => {
            if (err) return reject(err);
            const d = Number(meta?.format?.duration || 0);
            if (!d || !isFinite(d)) return reject(new Error("Khong lay duoc thoi luong"));
            resolve(d);
        });
    });
}

async function compressVideo(inputPath, outputPath, targetSize) {
    const duration = await getVideoDuration(inputPath);
    const audioBr  = 48;
    const totalBr  = Math.floor(targetSize * 8 / duration / 1000);
    const videoBr  = Math.max(220, totalBr - audioBr - 16);

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .videoCodec("libx264")
            .audioCodec("aac")
            .audioBitrate(`${audioBr}k`)
            .videoBitrate(`${videoBr}k`)
            .size("640x?")
            .outputOptions(["-preset veryfast", "-crf 31", "-maxrate 900k", "-bufsize 1800k", "-movflags +faststart"])
            .output(outputPath)
            .on("end", resolve)
            .on("error", reject)
            .run();
    });

    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size <= 10240)
        throw new Error("Nen video that bai hoac ra file rong");
}

// ─── Canvas drawing ───────────────────────────────────────────────────────────
async function drawAndSave(movies, title) {
    ensureCache();
    const results = movies.slice(0, 5).map(m => ({
        name:        m.name || m.slug,
        origin_name: m.origin_name || "",
        thumb_url:   m.thumb_url || m.poster_url,
        slug:        m.slug,
        lang:        m.lang || "Vietsub",
        quality:     m.quality || "HD",
    }));
    const buffer = await drawMovieSearch(results, title);
    const tmpPath = path.join(CACHE_DIR, `khophim_search_${Date.now()}.png`);
    fs.writeFileSync(tmpPath, buffer);
    return { tmpPath, results };
}

async function drawDetailAndSave(info, episodeList) {
    ensureCache();
    const buffer = await drawMovieDetail(info, episodeList);
    const tmpPath = path.join(CACHE_DIR, `khophim_detail_${Date.now()}.png`);
    fs.writeFileSync(tmpPath, buffer);
    return tmpPath;
}

// ─── Commands ─────────────────────────────────────────────────────────────────
export const commands = {
    khophim: async (ctx) => {
        const { api, threadId, threadType, senderId, args } = ctx;
        const query = args.join(" ").trim();

        if (!query) return api.sendMessage({ msg: "Vui long nhap ten phim can tim." }, threadId, threadType);

        try {
            await api.sendMessage({ msg: `Dang tim kiem: "${query}"...` }, threadId, threadType);
            const items = await searchPhim(query);
            
            if (!items.length) {
                return api.sendMessage({ msg: `Khong tim thay phim: "${query}"` }, threadId, threadType);
            }
            
            const { tmpPath, results } = await drawAndSave(items, query);
            const sent = await api.sendMessage({
                msg: `Tim thay ${items.length} ket qua — reply so (1-${results.length}) de chon.`,
                attachments: [tmpPath]
            }, threadId, threadType);
            
            safeUnlink(tmpPath);

            const undoList = [];
            if (sent.message) undoList.push({ msgId: String(sent.message.msgId), cliMsgId: String(sent.message.cliMsgId) });
            if (Array.isArray(sent.attachment)) {
                sent.attachment.forEach(att => undoList.push({ msgId: String(att.msgId), cliMsgId: String(att.cliMsgId) }));
            }
            
            const key = `${threadId}-${senderId}`;
            pendingSearch.set(key, { results, undoData: undoList });
            setTimeout(() => pendingSearch.delete(key), 120000);
        } catch (e) {
            log.error("[KhoPhim] Search error:", e.message);
            await api.sendMessage({ msg: e.message || "Loi tim kiem phim." }, threadId, threadType);
        }
    }
};

// ─── Handle ───────────────────────────────────────────────────────────────────
export async function handle(ctx) {
    const { content, senderId, threadId, api, threadType } = ctx;
    const trimmed = content?.trim();
    const num     = parseInt(trimmed, 10);
    if (isNaN(num) || num < 1) return false;

    const searchKey  = `${threadId}-${senderId}`;
    const episodeKey = `${threadId}-${senderId}-ep`;

    // ── Chon tap phim
    if (pendingEpisode.has(episodeKey)) {
        const epData = pendingEpisode.get(episodeKey);
        const episodes = epData.episodes;
        const idx = num - 1;

        if (idx >= episodes.length) return false;

        if (epData._timeout) clearTimeout(epData._timeout);
        epData._timeout = setTimeout(() => pendingEpisode.delete(episodeKey), 20 * 60 * 1000);

        if (epData.undoData) {
            api.undoMessage(epData.undoData, threadId, threadType).catch(() => {});
        }

        const ep = episodes[idx];
        const epName = ep.name || `Tap ${num}`;
        const movieName = epData.movieName || "Phim";
        const episodeUrl = ep.link_embed;

        await api.sendMessage({ msg: `Dang lay link va tai "${epName}" - "${movieName}"...` }, threadId, threadType);

        const tmpBase = Date.now();
        const tmpMp4  = path.join(CACHE_DIR, `khophim_ep_${tmpBase}.mp4`);
        const tmpComp = path.join(CACHE_DIR, `khophim_ep_${tmpBase}_c.mp4`);
        let downloaded = false;

        const m3u8s = await scrapeVideoFromEpisodePage(episodeUrl);

        for (const streamUrl of m3u8s) {
            try {
                await downloadM3U8(streamUrl, tmpMp4);
                if (fs.existsSync(tmpMp4) && fs.statSync(tmpMp4).size > 10240) {
                    downloaded = true;
                    break;
                }
            } catch (e) {
                log.warn(`[KhoPhim] M3U8 download fail: ${e.message}`);
            }
        }

        try {
            if (downloaded) {
                const maxSize = getMaxVideoSize(api);
                let sendPath  = tmpMp4;
                let stat      = fs.statSync(sendPath);

                if (stat.size > maxSize) {
                    await api.sendMessage({ msg: `Video goc ${(stat.size / 1024 / 1024).toFixed(1)} MB, dang nen...` }, threadId, threadType);
                    try {
                        safeUnlink(tmpComp);
                        await compressVideo(tmpMp4, tmpComp, maxSize);
                        const cs = fs.statSync(tmpComp);
                        if (cs.size < stat.size) { sendPath = tmpComp; stat = cs; }
                    } catch (e) {
                        log.warn("[KhoPhim] Compress fail:", e.message);
                    }
                }

                if (stat.size > maxSize) {
                    await api.sendMessage({
                        msg: `[ ${movieName} ] ${epName}\nFile qua lon (${(stat.size/1024/1024).toFixed(1)} MB) sau khi nen.\n\nLink xem online:\n${episodeUrl}`
                    }, threadId, threadType);
                } else if (api.sendVideoUnified) {
                    await api.sendVideoUnified({
                        videoPath: sendPath,
                        thumbnailUrl: epData.poster,
                        msg: `${movieName} - ${epName}`,
                        threadId,
                        threadType
                    });
                    await api.sendMessage({ msg: `Tap ${num}/${episodes.length} | Go so tap khac (1-${episodes.length}) de doi.` }, threadId, threadType);
                } else {
                    await api.sendMessage({
                        msg: `${movieName} - ${epName}`,
                        attachments: [sendPath]
                    }, threadId, threadType);
                }
            } else {
                await api.sendMessage({
                    msg: `[ ${movieName} ]\nTap: ${epName}\n\nKhong tai duoc video.\nXem online tai: ${episodeUrl}`
                }, threadId, threadType);
            }
        } finally {
            safeUnlink(tmpMp4, 3000);
            safeUnlink(tmpComp, 3000);
        }
        return true;
    }

    // ── Chon phim
    if (!pendingSearch.has(searchKey) || num > 5) return false;

    const session = pendingSearch.get(searchKey);
    const movie = session.results[num - 1];
    if (!movie) return false;

    if (session.undoData) {
        api.undoMessage(session.undoData, threadId, threadType).catch(() => {});
    }
    pendingSearch.delete(searchKey);

    await api.sendMessage({ msg: `Dang tai chi tiet "${movie.name}"...` }, threadId, threadType);

    try {
        const { info, episodes } = await getMovieInfo(movie.slug);

        if (!episodes.length) {
            await api.sendMessage({ msg: `Phim "${info.name}" chua co tap nao hoac dang cap nhat.` }, threadId, threadType);
            return true;
        }

        let tmpPath;
        try { tmpPath = await drawDetailAndSave(info, episodes); } catch (e) { log.warn(e); }

        const epNames = episodes.slice(0, 30).map((ep, i) => `${i + 1}. ${ep.name}`).join("  ");

        const msgText = [
            `${info.name}`,
            `${episodes.length} tap`,
            "────────────────",
            epNames + (episodes.length > 30 ? `\n...va ${episodes.length - 30} tap nua` : ""),
            "────────────────",
            "Go so tap de tai video (VD: 1, 2, 3...)"
        ].join("\n");

        const sendOpts = tmpPath ? { msg: msgText, attachments: [tmpPath] } : { msg: msgText };
        const sent = await api.sendMessage(sendOpts, threadId, threadType);
        
        const undoList = [];
        if (sent.message) undoList.push({ msgId: String(sent.message.msgId), cliMsgId: String(sent.message.cliMsgId) });
        if (Array.isArray(sent.attachment)) {
            sent.attachment.forEach(att => undoList.push({ msgId: String(att.msgId), cliMsgId: String(att.cliMsgId) }));
        }

        const epEntry = {
            episodes,
            movieName: info.name,
            poster: info.poster_url || "",
            undoData: undoList,
            _timeout: null
        };

        epEntry._timeout = setTimeout(() => pendingEpisode.delete(episodeKey), 20 * 60 * 1000);
        pendingEpisode.set(episodeKey, epEntry);

    } catch (e) {
        log.error("[KhoPhim] Detail error:", e.message);
        await api.sendMessage({ msg: "Loi tai chi tiet phim." }, threadId, threadType);
    }
    return true;
}
