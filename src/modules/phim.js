import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import axios from "axios";
import * as cheerio from "cheerio";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { log } from "../logger.js";
import { drawMovieSearch, drawMovieDetail } from "../utils/canvasHelper.js";

// ─── ffmpeg setup ─────────────────────────────────────────────────────────────
try { ffmpeg.setFfmpegPath(ffmpegStatic); } catch {}
try { ffmpeg.setFfprobePath(ffprobeStatic.path); } catch {}

// ─── Constants ────────────────────────────────────────────────────────────────
export const name = "phim";
export const description = "Tim kiem va xem phim tu PhimMoi (eile.ie)";

const BASE = "https://eile.ie";
const CACHE_DIR = path.join(process.cwd(), "src/modules/cache");
const DEFAULT_MAX_VIDEO = 100 * 1024 * 1024;

const pendingSearch  = new Map(); // threadId-userId → { results, undoData }
const pendingEpisode = new Map(); // threadId-userId-ep → { episodes, ... }

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8",
    "Referer": BASE + "/",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

async function sendMsg(ctx, text) {
    return ctx.api.sendMessage({
        msg: text,
        quote: ctx.message
    }, ctx.threadId, ctx.threadType);
}

// ─── Scraping layer ───────────────────────────────────────────────────────────

/** Fetch HTML page from eile.ie */
async function fetchHtml(url, retries = 2) {
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await axios.get(url, { headers: HEADERS, timeout: 12000 });
            return res.data;
        } catch (err) {
            if (i === retries) throw err;
            await new Promise(r => setTimeout(r, 800 * (i + 1)));
        }
    }
}

/** Lấy slug gốc từ slug đầy đủ (bỏ phần -ID ở cuối) */
function baseSlug(slug) {
    return slug.replace(/-\d+$/, "");
}

/** Tạo URL ảnh thumbnail từ slug đầy đủ */
function thumbUrl(slug) {
    const bs = baseSlug(slug);
    return `${BASE}/storage/images/${bs}/${bs}-thumb.webp`;
}

function posterUrl(slug) {
    const bs = baseSlug(slug);
    return `${BASE}/storage/images/${bs}/${bs}-poster.webp`;
}

/** Parse danh sách phim từ HTML listing/search */
function parseMovieList(html) {
    const $ = cheerio.load(html);
    const items = [];

    // Pattern 1: movie-card (được dùng cả listing lẫn related)
    $("a[href^='/phim/']").each((_, el) => {
        const href = $(el).attr("href") || "";
        const slug = href.replace("/phim/", "").split("/")[0];
        if (!slug || items.find(x => x.slug === slug)) return;

        const title =
            $(el).find("p.line-clamp-1").text().trim() ||
            $(el).attr("title") ||
            $(el).find("h3, h2").first().text().trim();

        const enTitle = $(el).find("span.text-gray-400").text().trim();
        const statusText =
            $(el).find(".absolute.top-1.left-1").first().text().trim() ||
            $(el).find("[class*='top-1']").first().text().trim();
        const quality =
            $(el).find(".absolute.top-1.right-1").first().text().trim();

        if (!title) return;
        items.push({
            slug,
            name: title,
            origin_name: enTitle || title,
            thumb_url: thumbUrl(slug),
            poster_url: posterUrl(slug),
            lang: statusText,
            quality,
            url: `${BASE}/phim/${slug}`
        });
    });

    // Pattern 2: parse link-only items from breadcrumb-style listing
    if (items.length === 0) {
        const rx = /\[([^\]]+)\]\(https:\/\/eile\.ie\/phim\/([\w-]+)\)/g;
        let m;
        while ((m = rx.exec(html)) !== null) {
            const slug = m[2];
            if (items.find(x => x.slug === slug)) continue;
            items.push({
                slug,
                name: m[1],
                origin_name: m[1],
                thumb_url: thumbUrl(slug),
                poster_url: posterUrl(slug),
                url: `${BASE}/phim/${slug}`
            });
        }
    }

    return items;
}

/** Parse JSON-LD schema.org từ trang chi tiết phim */
function parseJsonLd(html) {
    const rx = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = rx.exec(html)) !== null) {
        try {
            const data = JSON.parse(m[1]);
            if (data["@type"] === "Movie" || data["@type"] === "TVSeries") return data;
            if (Array.isArray(data["@graph"])) {
                const found = data["@graph"].find(n =>
                    n["@type"] === "Movie" || n["@type"] === "TVSeries"
                );
                if (found) return found;
            }
        } catch {}
    }
    return null;
}

/** Parse danh sách tập phim từ HTML trang chi tiết */
function parseEpisodes(html) {
    const $ = cheerio.load(html);
    const episodes = [];

    // Tìm các link tập phim có dạng /phim/{slug}/tap-{N} hoặc /tap-full
    const slugMatch = html.match(/\/phim\/([\w-]+)\//);
    if (!slugMatch) return [];
    const movieSlug = slugMatch[1];

    const seen = new Set();
    $(`a[href^='/phim/${movieSlug}/tap-'], a[href*='/phim/${movieSlug}/tap-']`).each((_, el) => {
        const href = $(el).attr("href") || "";
        if (seen.has(href)) return;
        seen.add(href);

        const tapPart = href.split("/tap-")[1] || "";
        const tapName = tapPart === "full" ? "Full" : `Tập ${tapPart}`;
        const tapNum  = tapPart === "full" ? 0 : (parseInt(tapPart) || 0);

        episodes.push({
            name: tapName,
            slug: tapPart,
            num: tapNum,
            link_embed: `${BASE}${href}`,
            link_m3u8: null // phải scrape trang tập mới biết
        });
    });

    // Sort theo số tập
    episodes.sort((a, b) => a.num - b.num);
    return episodes;
}

/** Scrape m3u8/iframe từ trang tập phim của eile.ie */
async function scrapeVideoFromEpisodePage(url) {
    try {
        const html = await fetchHtml(url);
        const $ = cheerio.load(html);
        const m3u8s = [];
        const iframes = [];

        // 1. Tìm m3u8 trực tiếp trong script/html
        const m3u8Regex = /https?:\/\/[^\s"'`]+\.m3u8[^\s"'`]*/gi;
        const matches = html.match(m3u8Regex) || [];
        m3u8s.push(...new Set(matches.map(u => u.replace(/\\/g, ""))));

        // 2. Tìm iframe
        $("iframe").each((_, el) => {
            let src = $(el).attr("src") || $(el).attr("data-src") || "";
            if (src) {
                if (src.startsWith("//")) src = "https:" + src;
                if (!src.startsWith("http")) src = new URL(src, BASE).toString();
                iframes.push(src);
            }
        });

        // 3. Tìm trong các biến javascript
        const jsMatches = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/gi) || [];
        jsMatches.forEach(m => {
            const u = m.slice(1, -1).replace(/\\/g, "");
            if (!m3u8s.includes(u)) m3u8s.push(u);
        });

        return { m3u8s: [...new Set(m3u8s)], iframes: [...new Set(iframes)] };
    } catch (e) {
        log.error("[Phim] Scrape video error:", e.message);
        return { m3u8s: [], iframes: [] };
    }
}

// ─── Nguồn phụ lấy m3u8 (phimapi.com, ophim) ────────────────────────────────

const PHIMAPI_SOURCES = [
    (slug) => `https://phimapi.com/phim/${slug}`,
    (slug) => `https://phimapi.com/v1/api/phim/${slug}`,
    (slug) => `https://ophim17.cc/phim/${slug}`,
];

/** Lấy episodes + m3u8 URL từ phimapi.com (chia sẻ cùng slug với eile.ie) */
async function fetchEpisodesFromApi(slug) {
    for (const buildUrl of PHIMAPI_SOURCES) {
        try {
            const url = buildUrl(slug);
            const res = await axios.get(url, { headers: HEADERS, timeout: 10000 });
            const data = res.data;
            const rawEps = data?.episodes || data?.data?.episodes || [];
            const allServers = rawEps.filter(s => s?.server_data?.length > 0);
            if (!allServers.length) continue;

            // Lấy server đầu + gom fallback từ server khác
            return allServers[0].server_data.map((ep, i) => {
                const fallbacks = allServers.slice(1)
                    .map(sv => sv.server_data?.[i]?.link_m3u8)
                    .filter(Boolean);
                return {
                    name:         ep.name || `Tập ${i + 1}`,
                    slug:         ep.slug || String(i + 1),
                    num:          i,
                    link_m3u8:    ep.link_m3u8 || null,
                    link_embed:   ep.link_embed || null,
                    _fallbackM3u8: fallbacks,
                };
            });
        } catch {}
    }
    return [];
}

/** Tìm kiếm phim — dùng Google Search suggestion hoặc scrape trang chủ */
async function searchPhim(keyword) {
    // Thử endpoint search nội bộ của eile.ie
    const searchUrls = [
        `${BASE}/tim-kiem/${encodeURIComponent(keyword)}`,
        `${BASE}/search?q=${encodeURIComponent(keyword)}`,
        `${BASE}/tim-kiem?q=${encodeURIComponent(keyword)}`,
        `${BASE}/tim-kiem?keyword=${encodeURIComponent(keyword)}`,
    ];

    for (const url of searchUrls) {
        try {
            const html = await fetchHtml(url);
            const items = parseMovieList(html);
            if (items.length > 0) return items;
        } catch {}
    }

    // Fallback: dùng phimapi.com để search, rồi map lại sang eile.ie
    try {
        const res = await axios.get(
            `https://phimapi.com/v1/api/tim-kiem?keyword=${encodeURIComponent(keyword)}`,
            { headers: HEADERS, timeout: 10000 }
        );
        const apiItems = res.data?.items || res.data?.data?.items || [];
        return apiItems.slice(0, 10).map(it => ({
            slug: it.slug,
            name: it.name || it.slug,
            origin_name: it.origin_name || it.name,
            thumb_url: thumbUrl(it.slug),
            poster_url: posterUrl(it.slug),
            year: it.year,
            lang: it.lang,
            quality: it.quality,
            url: `${BASE}/phim/${it.slug}`
        }));
    } catch {}

    throw new Error(`Khong tim thay phim voi tu khoa: "${keyword}"`);
}

/** Lấy danh sách phim mới nhất */
async function getLatest(page = 1) {
    const url = page === 1
        ? `${BASE}/danh-sach/phim-moi-cap-nhat`
        : `${BASE}/danh-sach/${page}`;
    const html = await fetchHtml(url);
    return parseMovieList(html);
}

/** Lấy thông tin chi tiết phim */
async function getMovieInfo(slug) {
    const html = await fetchHtml(`${BASE}/phim/${slug}`);
    const jld  = parseJsonLd(html);
    let eps  = parseEpisodes(html);

    // Fallback: nếu scrape từ HTML không có tập, thử lấy từ phimapi.com
    if (!eps.length) {
        try {
            eps = await fetchEpisodesFromApi(slug);
        } catch (e) {
            log.warn(`[Phim] fetchEpisodesFromApi failed for ${slug}: ${e.message}`);
        }
    }

    if (!eps || eps.length === 0) {
        throw new Error("Không thể lấy danh sách tập phim từ nguồn API.");
    }

    // Parse thêm thông tin từ HTML (genre, country, status...)
    const $ = cheerio.load(html);
    const genres = [];
    const countries = [];
    $('a[href*="/the-loai/"]').each((_, el) => {
        const t = $(el).text().trim();
        if (t && !genres.find(g => g.name === t)) genres.push({ name: t });
    });
    $('a[href*="/quoc-gia/"]').each((_, el) => {
        const t = $(el).text().trim();
        if (t && !countries.find(c => c.name === t)) countries.push({ name: t });
    });

    const info = {
        name:        jld?.name || slug,
        origin_name: jld?.alternateName || "",
        description: jld?.description || "",
        thumb_url:   jld?.thumbnailUrl || thumbUrl(slug),
        poster_url:  jld?.image || posterUrl(slug),
        year:        jld?.datePublished ? new Date(jld.datePublished).getFullYear() : "",
        time:        formatDuration(jld?.duration) || "N/A",
        quality:     "HD",
        lang:        "Vietsub",
        status:      eps.length > 0 ? `${eps.length} tap` : "Dang cap nhat",
        content_rating: jld?.contentRating || "",
        rating:      jld?.aggregateRating?.ratingValue || "",
        category:    genres,
        country:     countries,
        actors:      (jld?.actor || []).map(a => a.name).filter(Boolean),
        directors:   (jld?.director || []).map(d => d.name).filter(Boolean),
        slug,
    };

    return { info, episodes: eps };
}

// ─── Video download ───────────────────────────────────────────────────────────

async function downloadM3U8(m3u8Url, outputPath) {
    const referers = [
        BASE + "/",
        "https://player.phimapi.com/",
        "https://ophim1.com/",
    ];
    try {
        const u = new URL(m3u8Url);
        const cdnOrigin = `${u.protocol}//${u.host}/`;
        if (!referers.includes(cdnOrigin)) referers.unshift(cdnOrigin);
    } catch {}

    let lastErr;
    let command;
    for (const referer of referers) {
        safeUnlink(outputPath);
        try {
            await new Promise((resolve, reject) => {
                let isDone = false;
                const timer = setTimeout(() => {
                    isDone = true;
                    if (command) command.kill('SIGKILL');
                    reject(new Error("Timeout 120s"));
                }, 120000);
                const origin = new URL(referer).origin;
                command = ffmpeg(m3u8Url)
                    .inputOptions([
                        "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
                        "-user_agent", HEADERS["User-Agent"],
                        "-headers",
                        `Referer: ${referer}\r\nOrigin: ${origin}\r\nAccept: */*\r\n`
                    ])
                    .outputOptions(["-c copy", "-bsf:a aac_adtstoasc", "-movflags +faststart"])
                    .output(outputPath)
                    .on("end", () => { if (isDone) return; clearTimeout(timer); resolve(); })
                    .on("error", err => { if (isDone) return; clearTimeout(timer); reject(err); });
                command.run();
            });
            if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10240) return;
            throw new Error("File qua nho sau khi tai");
        } catch (err) {
            lastErr = err;
            safeUnlink(outputPath, 500);
        }
    }
    throw lastErr || new Error("Khong tai duoc video");
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

// ─── Format duration PT111M → 111 phút ───────────────────────────────────────
function formatDuration(iso) {
    if (!iso) return "";
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return iso;
    const h = parseInt(m[1] || 0), mn = parseInt(m[2] || 0), s = parseInt(m[3] || 0);
    const parts = [];
    if (h) parts.push(`${h}g`);
    if (mn) parts.push(`${mn}p`);
    if (s) parts.push(`${s}s`);
    return parts.join(" ");
}

// ─── Canvas drawing wrapper ───────────────────────────────────────────────────

async function drawAndSave(movies, title) {
    ensureCache();
    const results = movies.slice(0, 5).map(m => ({
        name:        m.name || m.slug,
        origin_name:  m.origin_name || "",
        thumb_url:   m.thumb_url || m.poster_url,
        slug:        m.slug,
        lang:        m.lang || "Vietsub",
        quality:     m.quality || "HD",
    }));
    const buffer = await drawMovieSearch(results, title);
    const tmpPath = path.join(CACHE_DIR, `phim_search_${Date.now()}.png`);
    fs.writeFileSync(tmpPath, buffer);
    return { tmpPath, results };
}

async function drawDetailAndSave(info, episodeList) {
    ensureCache();
    const buffer = await drawMovieDetail(info, episodeList);
    const tmpPath = path.join(CACHE_DIR, `phim_detail_${Date.now()}.png`);
    fs.writeFileSync(tmpPath, buffer);
    return tmpPath;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export const commands = {
    phim: async (ctx) => {
        const { api, threadId, threadType, senderId, args } = ctx;
        const query = args.join(" ").trim();

        const pageMatch = query.match(/^(?:trang\s*|t|p)(\d+)$/i);
        const isPageOnly = !query || pageMatch || /^\d+$/.test(query);
        const page = pageMatch
            ? parseInt(pageMatch[1], 10)
            : (/^\d+$/.test(query) ? parseInt(query, 10) : 1);

        // ── Hiển thị phim mới (không có từ khóa) ──────────────────────────
        if (isPageOnly) {
            const pageNum = Math.max(1, page);
            await sendMsg(ctx, `Dang tai phim moi trang ${pageNum}...`);
            try {
                const items = await getLatest(pageNum);
                if (!items.length) {
                    return sendMsg(ctx, `Khong co phim o trang ${pageNum}.`);
                }

                const { tmpPath, results } = await drawAndSave(items, `PHIM MOI - TRANG ${pageNum}`);
                const sent = await api.sendMessage({
                    msg: `Phim moi trang ${pageNum} — reply so (1-${results.length}) de xem chi tiet.\nTrang khac: .phim trang 2`,
                    attachments: [tmpPath]
                }, threadId, threadType);
                safeUnlink(tmpPath);

                // Lưu undoData để hỗ trợ thu hồi (Undo)
                const undoData = api.getUndoData(sent);
                const key = `${threadId}-${senderId}`;
                pendingSearch.set(key, { results, undoData });
                setTimeout(() => pendingSearch.delete(key), 120000);
            } catch (e) {
                log.error("[Phim] Latest error:", e.message);
                await sendMsg(ctx, `Loi tai danh sach phim: ${e.message}`);
            }
            return;
        }

        // ── Tìm kiếm ──────────────────────────────────────────────────────
        try {
            await sendMsg(ctx, `Dang tim kiem: "${query}"...`);
            const items = await searchPhim(query);
            if (!items.length) {
                return sendMsg(ctx, `Khong tim thay phim: "${query}"`);
            }
            const { tmpPath, results } = await drawAndSave(items, query);
            const sent = await api.sendMessage({
                msg: `Tim thay ${items.length} ket qua — reply so (1-${results.length}) de chon.`,
                attachments: [tmpPath]
            }, threadId, threadType);
            safeUnlink(tmpPath);

            // Lưu undoData để hỗ trợ thu hồi (Undo)
            const undoList = [];
            if (sent.message) undoList.push({ msgId: String(sent.message.msgId), cliMsgId: String(sent.message.cliMsgId) });
            if (Array.isArray(sent.attachment)) {
                sent.attachment.forEach(att => undoList.push({ msgId: String(att.msgId), cliMsgId: String(att.cliMsgId) }));
            }
            const undoData = undoList;
            const key = `${threadId}-${senderId}`;
            pendingSearch.set(key, { results, undoData });
            setTimeout(() => pendingSearch.delete(key), 120000);
        } catch (e) {
            log.error("[Phim] Search error:", e.message);
            await sendMsg(ctx, e.message || "Loi tim kiem phim.");
        }
    }
};

// ─── Handle (reply số) ───────────────────────────────────────────────────────

export async function handle(ctx) {
    const { content, senderId, threadId, api, threadType } = ctx;
    const trimmed = content?.trim();
    const num     = parseInt(trimmed, 10);
    if (isNaN(num) || num < 1) return false;

    const searchKey  = `${threadId}-${senderId}`;
    const episodeKey = `${threadId}-${senderId}-ep`;

    // ── Chọn tập phim ─────────────────────────────────────────────────────
    if (pendingEpisode.has(episodeKey)) {
        const epData = pendingEpisode.get(episodeKey);
        const episodes = epData.episodes;
        const idx = num - 1;

        if (idx >= episodes.length) {
            await api.sendMessage({
                msg: `Khong co tap ${num}. Chon tu 1-${episodes.length}.`
            }, threadId, threadType);
            return true;
        }

        // Reset timeout
        if (epData._timeout) clearTimeout(epData._timeout);
        epData._timeout = setTimeout(() => pendingEpisode.delete(episodeKey), 20 * 60 * 1000);

        // Undo bảng danh sách tập cũ
        if (epData.undoData) {
            api.undoMessage(epData.undoData, threadId, threadType).catch(() => {});
        }

        const ep         = episodes[idx];
        const epName     = ep.name || `Tap ${num}`;
        const movieName  = epData.movieName || "Phim";
        const episodeUrl = ep.link_embed;

        await api.sendMessage({
            msg: `Dang lay link va tai "${epName}" - "${movieName}"...`
        }, threadId, threadType);

        const tmpBase = Date.now();
        const tmpMp4  = path.join(CACHE_DIR, `phim_ep_${tmpBase}.mp4`);
        const tmpComp = path.join(CACHE_DIR, `phim_ep_${tmpBase}_c.mp4`);
        let downloaded = false;

        // 1) Lấy m3u8 từ data API phimapi
        let m3u8s = [];
        if (ep.link_m3u8) m3u8s.push(ep.link_m3u8);
        if (ep._fallbackM3u8 && ep._fallbackM3u8.length) m3u8s.push(...ep._fallbackM3u8);
        
        // 2) Nếu không có m3u8 từ API, thử scrape từ trang tập eile.ie
        if (m3u8s.length === 0 && episodeUrl) {
            try {
                const { m3u8s: found, iframes } = await scrapeVideoFromEpisodePage(episodeUrl);
                m3u8s.push(...found);
                
                // Thử scrape thêm từ iframe nếu vẫn chưa thấy m3u8
                if (m3u8s.length === 0) {
                    for (const iUrl of iframes.slice(0, 2)) {
                        try {
                            const { m3u8s: iFound } = await scrapeVideoFromEpisodePage(iUrl);
                            m3u8s.push(...iFound);
                        } catch {}
                    }
                }
            } catch (e) {
                log.warn(`[Phim] Scrape fallback failed for ${episodeUrl}: ${e.message}`);
            }
        }

        if (m3u8s.length === 0) {
             log.warn(`[Phim] Không tìm thấy m3u8 cho tập ${epName}`);
        }

        // 3) Thử download từng m3u8
        for (const streamUrl of m3u8s) {
            try {
                await downloadM3U8(streamUrl, tmpMp4);
                if (fs.existsSync(tmpMp4) && fs.statSync(tmpMp4).size > 10240) {
                    downloaded = true;
                    break;
                }
            } catch (e) {
                log.warn(`[Phim] M3U8 download fail: ${e.message}`);
            }
        }

        try {
            if (downloaded) {
                const maxSize = getMaxVideoSize(api);
                let sendPath  = tmpMp4;
                let stat      = fs.statSync(sendPath);

                if (stat.size > maxSize) {
                    await api.sendMessage({
                        msg: `Video goc ${(stat.size / 1024 / 1024).toFixed(1)} MB, dang nen...`
                    }, threadId, threadType);
                    try {
                        safeUnlink(tmpComp);
                        await compressVideo(tmpMp4, tmpComp, maxSize);
                        const cs = fs.statSync(tmpComp);
                        if (cs.size < stat.size) { sendPath = tmpComp; stat = cs; }
                    } catch (e) {
                        log.warn("[Phim] Compress fail:", e.message);
                    }
                }

                if (stat.size > maxSize) {
                    await api.sendMessage({
                        msg: `[ ${movieName} ] ${epName}\nFile qua lon (${(stat.size/1024/1024).toFixed(1)} MB) sau khi nen.\n\nLink xem online:\n${episodeUrl}`
                    }, threadId, threadType);
                } else if (api.sendVideoUnified) {
                    await api.sendVideoUnified({
                        videoPath:    sendPath,
                        thumbnailUrl: epData.poster,
                        msg:          `${movieName} - ${epName}`,
                        threadId,
                        threadType
                    });
                    await api.sendMessage({
                        msg: `Tap ${num}/${episodes.length} | Go so tap khac (1-${episodes.length}) de doi.`
                    }, threadId, threadType);
                } else {
                    await api.sendMessage({
                        msg:         `${movieName} - ${epName}`,
                        attachments: [sendPath]
                    }, threadId, threadType);
                }
            } else {
                // Không download được → gửi link xem online
                await api.sendMessage({
                    msg: `[ ${movieName} ]\nTap: ${epName}\n\nKhong tai duoc video tu nguon.\n\nXem online tai:\n${episodeUrl}\n\nGo so tap khac (1-${episodes.length}) de thu tap khac.`
                }, threadId, threadType);
            }
        } finally {
            safeUnlink(tmpMp4, 3000);
            safeUnlink(tmpComp, 3000);
        }
        return true;
    }

    // ── Chọn phim từ kết quả tìm kiếm ────────────────────────────────────
    if (!pendingSearch.has(searchKey) || num > 5) return false;

    const session = pendingSearch.get(searchKey);
    const movie   = session.results[num - 1];
    if (!movie) return false;

    if (session.undoData) {
        api.undoMessage(session.undoData, threadId, threadType).catch(() => {});
    }
    pendingSearch.delete(searchKey);

    await api.sendMessage({
        msg: `Dang tai chi tiet "${movie.name || movie.slug}"...`
    }, threadId, threadType);

    try {
        const { info, episodes } = await getMovieInfo(movie.slug);

        if (!episodes.length) {
            const cats = (info.category || []).map(c => c.name).join(", ");
            const ctrs = (info.country || []).map(c => c.name).join(", ");
            await api.sendMessage({
                msg: [
                    `[ ${info.name} ]`,
                    info.origin_name ? `(${info.origin_name})` : "",
                    info.year ? `Nam: ${info.year}` : "",
                    cats ? `The loai: ${cats}` : "",
                    ctrs ? `Quoc gia: ${ctrs}` : "",
                    info.time && info.time !== "N/A" ? `Thoi luong: ${info.time}` : "",
                    info.rating ? `Danh gia: ${info.rating}/10` : "",
                    "",
                    "Phim nay chua co tap nao hoac dang cap nhat.",
                    `Xem tai: ${BASE}/phim/${movie.slug}`
                ].filter(Boolean).join("\n")
            }, threadId, threadType);
            return true;
        }

        // Vẽ card chi tiết
        let tmpPath;
        try {
            tmpPath = await drawDetailAndSave(info, episodes);
        } catch (drawErr) {
            log.warn("[Phim] Draw detail fail:", drawErr.message);
        }

        const epNames = episodes
            .slice(0, 30)
            .map((ep, i) => `${i + 1}.${ep.name}`)
            .join("  ");

        const cats = (info.category || []).map(c => c.name).join(", ");
        const ctrs = (info.country || []).map(c => c.name).join(", ");

        const msgText = [
            `${info.name}${info.origin_name ? ` (${info.origin_name})` : ""}`,
            info.year ? `Nam: ${info.year}` : "",
            cats ? `The loai: ${cats}` : "",
            ctrs ? `Quoc gia: ${ctrs}` : "",
            info.rating ? `Danh gia: ${info.rating}/10` : "",
            `${episodes.length} tap`,
            "────────────────",
            epNames + (episodes.length > 30 ? `\n...va ${episodes.length - 30} tap nua` : ""),
            "────────────────",
            "Go so tap de tai video (VD: 1, 2, 3...)"
        ].filter(Boolean).join("\n");

        const sendOpts = tmpPath
            ? { msg: msgText, attachments: [tmpPath] }
            : { msg: msgText };

        const sent = await api.sendMessage(sendOpts, threadId, threadType);
        // Lưu undoData để hỗ trợ thu hồi (Undo)
        const undoList = [];
        if (sent.message) undoList.push({ msgId: String(sent.message.msgId), cliMsgId: String(sent.message.cliMsgId) });
        if (Array.isArray(sent.attachment)) {
            sent.attachment.forEach(att => undoList.push({ msgId: String(att.msgId), cliMsgId: String(att.cliMsgId) }));
        }

        const epEntry = {
            episodes,
            movieName: info.name,
            poster:    info.poster_url || info.thumb_url || "",
            slug:      movie.slug,
            undoData:  undoList,
            _timeout:  null
        };
        epEntry._timeout = setTimeout(() => pendingEpisode.delete(episodeKey), 20 * 60 * 1000);
        pendingEpisode.set(episodeKey, epEntry);
        if (msgId) pendingEpisode.set(msgId, epEntry);

    } catch (e) {
        log.error("[Phim] Detail error:", e.message);
        await api.sendMessage({
            msg: `Loi lay chi tiet phim: ${e.message}`
        }, threadId, threadType);
    }

    return true;
}
