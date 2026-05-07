import axios from 'axios';
import * as cheerio from 'cheerio';
import path from 'path';
import fs from 'fs';
import { log } from '../logger.js';
import { drawHentaiSearch, drawHentaiDetail, splitLongImage } from '../utils/hentaiCanvas.js';

const BASE_URL = 'https://sayhentai.run';
const CACHE_DIR = path.join(process.cwd(), 'src/modules/cache');

// ===== SESSION MAPS =====
const pendingSearch   = new Map(); // Lưu phiên tìm kiếm (chờ chọn số)
const pendingDetail   = new Map(); // Lưu phiên chi tiết truyện (chờ chọn chương)
const pendingRead     = new Map(); // Lưu phiên đọc (chờ reaction tim)
const reactionCooldown = new Map(); // Chống spam reaction

const axiosConfig = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': BASE_URL,
    },
    timeout: 15000
};

// ===== MODULE META =====
export const name        = "hentai";
export const description = "Tìm kiếm và đọc manga từ SayHentai - Thả tim ❤️ để xem tiếp!";
export const type        = "command_event";

export const commands = {
    hentai:    async (ctx) => handleSearch(ctx),
    h:         async (ctx) => handleSearch(ctx),
    manga:     async (ctx) => handleSearch(ctx),
    sayhentai: async (ctx) => handleSearch(ctx),
};

// ═══════════════════════════════════════════════════════════════
//  COMMAND: !hentai [tên truyện]
// ═══════════════════════════════════════════════════════════════
async function handleSearch(ctx) {
    const { api, threadId, threadType, args, senderId, prefix } = ctx;
    const query = args.join(' ').trim();

    if (!query) {
        return api.sendMessage({
            msg: `📚 *HENTAI MANGA READER*\n─────────────────\n📝 Cách dùng:\n   ${prefix}hentai [tên truyện]\n   ${prefix}hentai moi (Xem truyện mới cập nhật)\n   ${prefix}hentai theloai [ntr, loli, milf...] (Tìm theo thể loại)\n\n💡 Ví dụ: ${prefix}hentai theloai ntr\n\n❤️ Thả tim vào ảnh để xem trang tiếp!`
        }, threadId, threadType);
    }

    try {
        let results = [];
        let displayQuery = query;

        if (query.toLowerCase() === 'moi') {
            await api.sendMessage({ msg: `🔄 Đang lấy danh sách truyện mới cập nhật...` }, threadId, threadType);
            results = await getMangaList(`${BASE_URL}/danh-sach`);
            displayQuery = "TRUYỆN MỚI CẬP NHẬT";
        } else if (query.toLowerCase().startsWith('theloai ')) {
            const genre = query.substring(8).trim().toLowerCase();
            await api.sendMessage({ msg: `🔍 Đang tìm kiếm thể loại: "${genre}"...` }, threadId, threadType);
            results = await getMangaList(`${BASE_URL}/the-loai/${encodeURIComponent(genre)}`);
            displayQuery = `THỂ LOẠI: ${genre.toUpperCase()}`;
        } else {
            await api.sendMessage({ msg: `🔍 Đang tìm kiếm: "${query}"...` }, threadId, threadType);
            results = await getMangaList(`${BASE_URL}/search?q=${encodeURIComponent(query)}`);
        }

        if (!results.length) {
            return api.sendMessage({ msg: '⚠️ Không tìm thấy truyện nào! Thử từ khóa khác nhé.' }, threadId, threadType);
        }

        // Render canvas
        const buffer = await drawHentaiSearch(results, displayQuery);
        const tmpPath = path.join(CACHE_DIR, `h_search_${Date.now()}.jpg`);
        fs.writeFileSync(tmpPath, buffer);

        const sent = await api.sendMessage({ msg: ``, attachments: [tmpPath] }, threadId, threadType);
        
        // Dọn file tạm ngay sau khi gửi xong
        setTimeout(() => {
            try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
        }, 5000);

        const ids   = extractIds(sent);
        const uKey  = `${threadId}_${senderId}_search`;

        // Tạo undoList để thu hồi sau này
        const undoList = [];
        if (sent.message) undoList.push({ msgId: String(sent.message.msgId), cliMsgId: String(sent.message.cliMsgId) });
        if (Array.isArray(sent.attachment)) {
            sent.attachment.forEach(att => undoList.push({ msgId: String(att.msgId), cliMsgId: String(att.cliMsgId) }));
        }

        const session = { results, senderId, threadId, threadType, ...ids, userKey: uKey, undoList };
        storeSession(pendingSearch, session, ids, uKey, 5 * 60 * 1000);

        log.info(`[HENTAI] Search session stored: ${Object.values(ids).filter(Boolean).join(', ')}`);
    } catch (err) {
        log.error('[HENTAI] Search error:', err.message);
        api.sendMessage({ msg: '❗ Lỗi khi tìm kiếm. Vui lòng thử lại.' }, threadId, threadType);
    }
}

// ═══════════════════════════════════════════════════════════════
//  HANDLE: Reply chọn số (search → detail → chapter)
// ═══════════════════════════════════════════════════════════════
export async function handle(ctx) {
    const { content, senderId, threadId, api, threadType, message } = ctx;
    if (!content || message?.isSelf) return false;

    const num = parseInt(content.trim(), 10);
    if (isNaN(num) || num < 1) return false;

    const quoteId    = extractQuoteId(message);
    const searchKey  = `${threadId}_${senderId}_search`;
    const detailKey  = `${threadId}_${senderId}_detail`;

    // ── CASE 1: Chọn từ kết quả tìm kiếm ──────────────────────
    let session = quoteId ? pendingSearch.get(quoteId) : pendingSearch.get(searchKey);
    if (session) {
        if (session.senderId !== senderId) return false;

        const selected = session.results[num - 1];
        if (!selected) {
            await api.sendMessage({ msg: `⚠️ Không có kết quả số ${num}. Chọn 1-${session.results.length}` }, threadId, threadType);
            return true;
        }

        api.addReaction("🔍", message).catch(() => {});
        
        // THỰC HIỆN THU HỒI (UNDO) TIN NHẮN SEARCH
        if (session.undoList && session.undoList.length > 0) {
            api.undoMessage(session.undoList, threadId, threadType).catch(() => { });
        }

        clearSession(pendingSearch, session);

        try {
            await api.sendMessage({ msg: `📖 Đang lấy chi tiết: ${selected.title}...` }, threadId, threadType);
            const detail = await getMangaDetail(selected.link);

            // Render canvas
            const buffer = await drawHentaiDetail(detail);
            const tmpPath = path.join(CACHE_DIR, `h_detail_${Date.now()}.jpg`);
            fs.writeFileSync(tmpPath, buffer);

            const sent = await api.sendMessage({ msg: ``, attachments: [tmpPath] }, threadId, threadType);
            
            setTimeout(() => {
                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
            }, 5000);

            const ids     = extractIds(sent);
            const uKey    = `${threadId}_${senderId}_detail`;

            // Tạo undoList để thu hồi khi chọn tập
            const undoList = [];
            if (sent.message) undoList.push({ msgId: String(sent.message.msgId), cliMsgId: String(sent.message.cliMsgId) });
            if (Array.isArray(sent.attachment)) {
                sent.attachment.forEach(att => undoList.push({ msgId: String(att.msgId), cliMsgId: String(att.cliMsgId) }));
            }

            const detailSess = { manga: detail, senderId, threadId, threadType, ...ids, userKey: uKey, undoList };
            storeSession(pendingDetail, detailSess, ids, uKey, 15 * 60 * 1000);
            log.info(`[HENTAI] Detail session stored for: ${detail.title}`);
        } catch (err) {
            log.error('[HENTAI] Detail error:', err.message);
            api.sendMessage({ msg: '❗ Lỗi khi lấy chi tiết truyện.' }, threadId, threadType);
        }
        return true;
    }

    // ── CASE 2: Chọn chương ────────────────────────────────────
    session = quoteId ? pendingDetail.get(quoteId) : pendingDetail.get(detailKey);
    if (session) {
        if (session.senderId !== senderId) return false;
        if (!session.manga?.chapters?.length) return false;

        const chapter = session.manga.chapters[num - 1];
        if (!chapter) {
            await api.sendMessage({ msg: `⚠️ Không có chương ${num}. Chọn 1-${session.manga.chapters.length}` }, threadId, threadType);
            return true;
        }

        api.addReaction("📖", message).catch(() => {});
        
        // THỰC HIỆN THU HỒI (UNDO) TIN NHẮN DETAIL/CHAPTER LIST
        if (session.undoList && session.undoList.length > 0) {
            api.undoMessage(session.undoList, threadId, threadType).catch(() => { });
        }

        clearSession(pendingDetail, session);

        try {
            await api.sendMessage({ msg: `📥 Đang tải ảnh chương: ${chapter.name}...` }, threadId, threadType);
            const images = await getChapterImages(chapter.link);

            if (!images?.length) {
                await api.sendMessage({ msg: '⚠️ Không tìm thấy ảnh trong chương này!' }, threadId, threadType);
                return true;
            }

            // Tìm index chương hiện tại để hỗ trợ "chương tiếp theo"
            const currentChapterIdx = num - 1;

            const readSession = {
                images,
                currentIndex: 0,
                senderId,
                threadId,
                threadType,
                chapterName:     chapter.name,
                chapterIdx:      currentChapterIdx,
                manga:           session.manga, // Giữ toàn bộ manga info
                userKey:         `${threadId}_${senderId}_read`,
            };

            log.info(`[HENTAI] Starting read: ${chapter.name} | ${images.length} ảnh`);
            await startOrContinueBatch(api, readSession);
        } catch (err) {
            log.error('[HENTAI] Chapter load error:', err.message);
            api.sendMessage({ msg: '❗ Lỗi khi tải ảnh chương.' }, threadId, threadType);
        }
        return true;
    }

    return false;
}

// ═══════════════════════════════════════════════════════════════
//  HANDLE REACTION: Thả tim ❤️ để xem tiếp
// ═══════════════════════════════════════════════════════════════
export async function handleReaction(ctx) {
    const { event, reaction, api } = ctx;

    const content  = event?.content || {};
    const icon     = String(content.rIcon || '');

    // Chỉ xử lý tim ❤️
    if (icon !== '/-heart' && icon !== '❤️') return;

    const reactorId = String(reaction?.data?.uidFrom || event?.uidFrom || event?.userId || '');

    // Thu thập tất cả possible IDs từ tin nhắn được thả tim
    const targetMsgs  = content?.rMsg || [];
    const possibleIds = [];
    targetMsgs.forEach(m => {
        if (m.gMsgID) possibleIds.push(String(m.gMsgID));
        if (m.cMsgID) possibleIds.push(String(m.cMsgID));
    });
    if (content.msgId)    possibleIds.push(String(content.msgId));
    if (content.cliMsgId) possibleIds.push(String(content.cliMsgId));

    log.debug(`[HENTAI] Reaction IDs: ${possibleIds.join(', ')}`);

    for (const rId of possibleIds) {
        if (!pendingRead.has(rId)) continue;

        const session = pendingRead.get(rId);

        // Chỉ cho phép người gọi lệnh mới được chuyển trang/chương
        if (session.senderId && String(session.senderId) !== String(reactorId)) {
            return;
        }

        // Đồng bộ thread đúng nhóm
        if (session.threadId) ctx.threadId = session.threadId;
        if (session.threadType !== undefined) ctx.threadType = session.threadType;

        // Chống spam
        const cdKey = `hentai-${rId}-${reactorId}`;
        if (reactionCooldown.has(cdKey)) return;
        reactionCooldown.set(cdKey, true);
        setTimeout(() => reactionCooldown.delete(cdKey), 5000);

        log.info(`[HENTAI] ❤️ Reaction matched! ID: ${rId} | Reactor: ${reactorId} | currentIndex: ${session.currentIndex}/${session.images.length}`);

        // Thả reaction xác nhận
        api.addReaction('📖', event).catch(() => {});

        // ── HẾT CHƯƠNG ──────────────────────────────────────────
        if (session.currentIndex >= session.images.length) {
            const nextChapterIdx = session.chapterIdx + 1;
            const manga          = session.manga;

            if (manga && nextChapterIdx < manga.chapters.length) {
                const nextChapter = manga.chapters[nextChapterIdx];
                try {
                    await api.sendMessage({
                        msg: `✅ Đã đọc hết *${session.chapterName}*!\n${'─'.repeat(28)}\n📖 Đang tải chương tiếp theo: *${nextChapter.name}*...`
                    }, session.threadId, session.threadType);

                    const images = await getChapterImages(nextChapter.link);
                    if (!images?.length) {
                        await api.sendMessage({ msg: `⚠️ Không tải được ảnh chương ${nextChapter.name}.` }, session.threadId, session.threadType);
                        return;
                    }

                    // Xóa session cũ (hết chương)
                    pendingRead.delete(rId);
                    pendingRead.delete(session.userKey);

                    // Tạo session mới cho chương tiếp
                    session.images        = images;
                    session.currentIndex  = 0;
                    session.chapterName   = nextChapter.name;
                    session.chapterIdx    = nextChapterIdx;

                    log.info(`[HENTAI] Auto-advance to: ${nextChapter.name} | ${images.length} ảnh`);
                    await startOrContinueBatch(api, session);
                } catch (err) {
                    log.error('[HENTAI] Auto-advance error:', err.message);
                    api.sendMessage({ msg: `❗ Lỗi khi tải chương tiếp theo.` }, session.threadId, session.threadType);
                }
            } else {
                // Hết truyện
                await api.sendMessage({
                    msg: `🎉 Bạn đã đọc đến chương cuối của truyện!\n📚 Dùng lệnh !hentai để tìm truyện khác nhé.`
                }, session.threadId, session.threadType);
            }
            return;
        }

        // ── CÒN ẢNH → GỬI BATCH TIẾP ───────────────────────────
        try {
            // Xóa mapping ID cũ để tránh react nhiều lần vào cùng 1 ảnh
            pendingRead.delete(rId);

            await startOrContinueBatch(api, session);
        } catch (err) {
            log.error('[HENTAI] Next batch error:', err.message);
            api.sendMessage({ msg: '❗ Lỗi khi tải ảnh tiếp theo.' }, session.threadId, session.threadType);
        }
        return;
    }
}

// ═══════════════════════════════════════════════════════════════
//  CORE: Gửi batch ảnh và đăng ký ID để nhận reaction tiếp
// ═══════════════════════════════════════════════════════════════
async function startOrContinueBatch(api, session) {
    const BATCH = 5;
    const { images, currentIndex, threadId, threadType, chapterName } = session;
    const batch    = images.slice(currentIndex, currentIndex + BATCH);
    const total    = images.length;
    const newIndex = currentIndex + batch.length;

    if (!batch.length) return;

    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

    const sentIds  = [];
    const tempFiles = [];

    for (let i = 0; i < batch.length; i++) {
        const imgUrl = batch[i];
        const isLast = i === batch.length - 1;

        try {
            // Tải ảnh về local và cắt nếu quá dài
            const res  = await axios.get(imgUrl, { ...axiosConfig, responseType: 'arraybuffer' });
            
            // Xử lý cắt ảnh dài (Sharp tự convert webp sang jpg cho an toàn)
            const imageChunks = await splitLongImage(Buffer.from(res.data));
            const chunkPaths = [];
            
            for (let c = 0; c < imageChunks.length; c++) {
                const tmpP = path.join(CACHE_DIR, `h_${Date.now()}_${i}_${c}_${Math.random().toString(36).slice(2, 7)}.jpg`);
                fs.writeFileSync(tmpP, imageChunks[c]);
                chunkPaths.push(tmpP);
                tempFiles.push(tmpP);
            }

            // Chỉ ảnh CUỐI của batch mới có text hướng dẫn
            let msgText = '';
            if (isLast) {
                msgText = `📖 *${chapterName}*\n`;
                msgText += `🖼️ Trang ${currentIndex + 1}–${newIndex} / ${total}\n`;
                if (newIndex < total) {
                    const remaining = total - newIndex;
                    msgText += `\n❤️ Thả tim vào ảnh này để xem tiếp ${Math.min(BATCH, remaining)} trang!`;
                } else {
                    const hasNext = session.chapterIdx + 1 < session.manga?.chapters?.length;
                    msgText += `\n✅ Hết chương!`;
                    if (hasNext) {
                        msgText += `\n❤️ Thả tim để đọc chương tiếp theo!`;
                    } else {
                        msgText += `\n🎉 Đây là chương cuối của truyện!`;
                    }
                }
            }

            // Gửi tất cả các phần cắt của 1 ảnh cùng lúc
            const sent = await api.sendMessage({ msg: msgText, attachments: chunkPaths }, threadId, threadType);
            if (isLast) log.debug(`[HENTAI] sent object: ${JSON.stringify(sent)}`);

            if (sent && isLast) {
                let mId = String(sent?.msgId || sent?.id || sent?.data?.msgId || sent?.data?.id || '');
                if (!mId && sent?.attachment && sent.attachment.length > 0) {
                    // Lấy msgId của phần ảnh cuối cùng nếu có nhiều mảnh
                    const lastAttach = sent.attachment[sent.attachment.length - 1];
                    mId = String(lastAttach?.msgId || lastAttach?.id || '');
                }
                const gId = String(sent?.globalMsgId || sent?.data?.globalMsgId || '');
                const cId = String(sent?.cliMsgId || sent?.data?.cliMsgId || '');
                if (mId) sentIds.push(mId);
                if (gId) sentIds.push(gId);
                if (cId) sentIds.push(cId);
            }
        } catch (e) {
            log.error(`[HENTAI] Image ${currentIndex + i} error: ${e.message}`);
        }
    }

    // Cập nhật index
    session.currentIndex = newIndex;

    // Lưu session với các ID mới (chỉ ảnh cuối batch là "hotspot" reaction)
    if (sentIds.length > 0) {
        sentIds.forEach(id => pendingRead.set(id, session));
        pendingRead.set(session.userKey, session);
        setTimeout(() => {
            sentIds.forEach(id => pendingRead.delete(id));
            pendingRead.delete(session.userKey);
        }, 60 * 60 * 1000); // session tồn tại 1 tiếng
        log.info(`[HENTAI] Batch sent: pages ${currentIndex + 1}-${newIndex}/${total} | registered IDs: ${sentIds.join(', ')}`);
    }

    // Dọn file tạm
    tempFiles.forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} });
}

// ═══════════════════════════════════════════════════════════════
//  SCRAPERS
// ═══════════════════════════════════════════════════════════════
async function getMangaList(url) {
    const { data } = await axios.get(url, axiosConfig);
    const $      = cheerio.load(data);
    const results = [];

    $('.halim-item').each((i, el) => {
        if (i >= 12) return;
        const title     = $(el).find('.entry-title').text().trim();
        let link        = $(el).find('a').attr('href');
        if (link && !link.startsWith('http')) link = BASE_URL + link;
        const thumbnail = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
        if (title && link) results.push({ title, link, thumbnail });
    });

    return results;
}

async function getMangaDetail(url) {
    const { data } = await axios.get(url, axiosConfig);
    const $ = cheerio.load(data);

    const title    = $('.entry-title').text().trim();
    const thumbnail = $('.movie-poster img').attr('data-src') || $('.movie-poster img').attr('src');
    const genres   = $('.the_tag_list a').map((_, el) => $(el).text().trim()).get().join(', ') || 'Đang cập nhật';
    const author   = $('a[href*="/tac-gia/"]').map((_, el) => $(el).text().trim()).get().join(', ') || 'Đang cập nhật';

    const chapters = [];
    $('li.chapter a').each((_, el) => {
        const name = $(el).text().trim().split('\n')[0];
        let link   = $(el).attr('href');
        if (link && !link.startsWith('http')) link = BASE_URL + link;
        if (name && link) chapters.push({ name, link });
    });
    chapters.reverse(); // Chương 1 trước

    return {
        title,
        thumbnail: thumbnail && !thumbnail.startsWith('http') ? BASE_URL + thumbnail : thumbnail,
        genres,
        author,
        chapters,
    };
}

async function getChapterImages(url) {
    if (!url) return [];
    const { data } = await axios.get(url, axiosConfig);
    const $ = cheerio.load(data);
    const images = [];

    // Selector chính
    $('.contentimg img').each((_, el) => {
        let src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || $(el).attr('data-original');
        if (src && !src.includes('base64')) {
            if (!src.startsWith('http')) src = BASE_URL + src;
            images.push(src);
        }
    });

    // Fallback nếu selector không trúng
    if (!images.length) {
        $('img').each((_, el) => {
            let src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
            if (src && (src.includes('wtcdn.xyz') || src.match(/\.(jpg|png|webp)/i))) {
                if (!src.includes('logo') && !src.includes('base64')) {
                    if (!src.startsWith('http')) src = BASE_URL + src;
                    images.push(src);
                }
            }
        });
    }

    return images;
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════
function extractIds(sent) {
    const mId = String(sent?.msgId  || sent?.id  || sent?.data?.msgId  || sent?.data?.id  || '');
    const gId = String(sent?.globalMsgId || sent?.data?.globalMsgId || '');
    const cId = String(sent?.cliMsgId   || sent?.data?.cliMsgId    || '');
    return { mId, gId, cId };
}

function extractQuoteId(message) {
    return String(
        message?.data?.quote?.globalMsgId ||
        message?.data?.quote?.msgId       ||
        message?.data?.content?.quote?.globalMsgId ||
        message?.data?.content?.quote?.msgId ||
        ''
    );
}

function storeSession(map, session, ids, userKey, ttl) {
    const { mId, gId, cId } = ids;
    if (mId) map.set(mId, session);
    if (gId) map.set(gId, session);
    if (cId) map.set(cId, session);
    map.set(userKey, session);
    setTimeout(() => {
        if (mId) map.delete(mId);
        if (gId) map.delete(gId);
        if (cId) map.delete(cId);
        map.delete(userKey);
    }, ttl);
}

function clearSession(map, session) {
    const { mId, gId, cId, userKey } = session;
    if (mId) map.delete(mId);
    if (gId) map.delete(gId);
    if (cId) map.delete(cId);
    if (userKey) map.delete(userKey);
}
