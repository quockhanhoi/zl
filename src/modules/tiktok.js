import { searchTiktok, getTiktokRelated, getTiktokUserPosts, setTikWMCookie as setApiCookie, getTiktokUserInfo } from "../utils/tiktokApi.js";
import { getUserPosts, setTikWMCookie as setDownloaderCookie, downloadTikTok } from "../utils/tiktokDownloader.js";
import { downloadFile, uploadTempFile, uploadToCatbox, fetchVideosByYtDlp } from "../utils/util.js";
import youtubedl from "yt-dlp-exec";
import { log } from "../logger.js";
import { drawTikTokSearch } from "../utils/canvasHelper.js";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";

export const name = "tiktok";
export const description = "Tìm kiếm và tải video TikTok không logo";
export const type = "command_event"; // Đánh dấu module này vừa là lệnh vừa là sự kiện

const pendingTikTokSelections = new Map();
export const sentTikTokVideos = new Map();
const reactionCooldown = new Map();
const threadVideoHistory = new Map(); // Lịch sử video đã gửi cho từng nhóm để tránh lặp
const userVideoCache = new Map();    // Cache danh sách video theo username (30 phút TTL)

export const commands = {
    tiktok: async (ctx) => {
        const { api, args, threadId, threadType, senderId, prefix, isOwner } = ctx;
        const subCommand = args[0]?.toLowerCase().trim();

        if (subCommand === "cookie" && isOwner) {
            const newCookie = args.slice(1).join(" ").trim();
            if (!newCookie) return api.sendMessage({ msg: "⚠️ Vui lòng nhập cookie mới!" }, threadId, threadType);
            setApiCookie(newCookie);
            setDownloaderCookie(newCookie);
            return api.sendMessage({ msg: "✅ Đã cập nhật Cookie Bypass TikWM thành công!" }, threadId, threadType);
        }

        // Nếu dùng '-tiktok search [query]' → lấy phần sau chữ 'search' làm query thực sự
        let query;
        if (subCommand === "search") {
            query = args.slice(1).join(" ").trim();
            if (!query) return api.sendMessage({ msg: `⚠️ Vui lòng nhập từ khóa sau 'search'. Ví dụ: ${prefix}tiktok search n.chusas` }, threadId, threadType);
        } else {
            query = args.join(" ").trim();
        }

        if (!query) {
            return api.sendMessage({ msg: `[ TIKTOK ]\n─────────────────\n📝 Cách dùng:\n1. ${prefix}tiktok [từ khóa] - Tìm kiếm video\n2. ${prefix}tiktok [username] - Lấy video của user\n3. ${prefix}tiktok [link] - Tải video từ link\n4. ${prefix}tiktok info [username] - Xem thông tin kênh\n\n💡 Ví dụ: ${prefix}tiktok n.chusas` }, threadId, threadType);
        }

        if (subCommand === "info") {
            const username = args.slice(1).join(" ").trim();
            if (!username) return api.sendMessage({ msg: "⚠️ Vui lòng nhập username (ví dụ: linhvu_228)" }, threadId, threadType);
            
            api.sendMessage({ msg: "⏳ Đang lấy thông tin kênh TikTok..." }, threadId, threadType);
            const userInfo = await getTiktokUserInfo(username);
            
            if (!userInfo || !userInfo.userid) {
                return api.sendMessage({ msg: `⚠️ Không tìm thấy hoặc không lấy được thông tin của: @${username}` }, threadId, threadType);
            }
            
            const infoMsg = `📱 𝗧𝗛𝗢̂𝗡𝗚 𝗧𝗜𝗡 𝗧𝗜𝗞𝗧𝗢𝗞
👤 Tên: ${userInfo.fullname || "Không có"} (@${userInfo.username || "N/A"})
🆔 ID: ${userInfo.userid}
✅ Tích xanh: ${userInfo.verified === "Yes" ? "Có" : "Không"}
🌍 Khu vực: ${userInfo.region || "N/A"}
👥 Người theo dõi: ${userInfo.followers || "0"}
❤️ Tổng số tim: ${userInfo.heart_count || userInfo.likes || "0"}
🎬 Số video: ${userInfo.video || "0"}
─────────────────
⏳ Tham gia: ${userInfo.created_time || "N/A"}`;

            if (userInfo.profile && userInfo.profile.startsWith("http")) {
                const tempAvatar = path.join(process.cwd(), `src/modules/cache/tk_avt_${Date.now()}.jpg`);
                try {
                    await downloadFile(userInfo.profile, tempAvatar);
                    await api.sendMessage({ msg: infoMsg, attachments: [tempAvatar] }, threadId, threadType);
                    fs.unlinkSync(tempAvatar);
                    return;
                } catch (e) {
                    log.warn(`[TIKTOK] Lỗi tải avatar: ${e.message}`);
                }
            }
            
            return api.sendMessage({ msg: infoMsg }, threadId, threadType);
        }

        if (query.startsWith("http")) {
            const waitMsg = await api.sendMessage({ msg: "⏳ Đang lấy dữ liệu video..." }, threadId, threadType);
            try {
                const videoData = await getDataDownloadVideo(query);
                if (!videoData) throw new Error("Không lấy được dữ liệu video.");
                await sendVideo(ctx, videoData);
            } catch (e) {
                log.error("TikTok Link Error:", e.message);
                api.sendMessage({ msg: `⚠️ Lỗi: ${e.message}` }, threadId, threadType);
            }
            return;
        }

        const waitMsg = await api.sendMessage({ msg: `⏳ Đang lấy danh sách video: "${query}"...` }, threadId, threadType);
        try {
            let results = [];
            const cleanQuery = query.startsWith("@") ? query.slice(1) : query;
            
            // Chỉ dùng User Posts API khi:
            // 1. Query bắt đầu bằng @ (ví dụ: @linhvu_228)
            // 2. Hoặc query trông đúng như username TikTok: không có dấu cách, chỉ a-z 0-9 . _ và tối thiểu 3 ký tự
            const looksLikeUsername = query.startsWith("@") || /^[a-zA-Z0-9._]{3,30}$/.test(query);

            if (looksLikeUsername) {
                log.info(`[TIKTOK] Ưu tiên lấy Profile cho: @${cleanQuery}...`);
                results = await getTiktokUserPosts(cleanQuery, 10).catch(() => []);
            }

            // TẦNG 2: Nếu Tầng 1 rỗng (username không tồn tại) hoặc không phải username → dùng Search API
            if (!results || results.length === 0) {
                log.info(`[TIKTOK] Profile rỗng hoặc không phải username, dùng Search API cho: ${query}...`);
                results = await searchTiktok(query, 10).catch(() => []);
            }

            // TẦNG 3: Vẫn rỗng → thử search với @ prefix
            if (!results || results.length === 0) {
                log.info(`[TIKTOK] Vẫn rỗng, thử search với @prefix cho: ${query}...`);
                results = await searchTiktok(`@${cleanQuery}`, 10).catch(() => []);
            }

            if (!results || results.length === 0) {
                return api.sendMessage({ msg: `⚠️ Không tìm thấy kết quả nào cho: "${query}"` }, threadId, threadType);
            }

            const canvasBuffer = await drawTikTokSearch(results, query);
            if (!canvasBuffer) throw new Error("Không thể tạo hình ảnh kết quả.");

            const tempCanvasPath = path.join(process.cwd(), "src", "modules", "cache", `tiktok_search_${Date.now()}.png`);
            fs.writeFileSync(tempCanvasPath, canvasBuffer);

            const sent = await api.sendMessage({ 
                msg: `[ 🎬 TIKTOK SEARCH ]\n─────────────────\n✨ Có sẵn 𝟭-${results.length} kết quả cho bạn.\n🔎 Từ khóa: "${query}"\n\n👉 Phản hồi số thứ tự để tải video.`,
                attachments: [tempCanvasPath]
            }, threadId, threadType);

            // Xóa file tạm sau khi gửi
            setTimeout(() => {
                if (fs.existsSync(tempCanvasPath)) fs.unlinkSync(tempCanvasPath);
            }, 30000);

            if (sent) {
                // Trích xuất ID tin nhắn đã gửi (Zalo API có nhiều cấu trúc phản hồi)
                const mId = String(
                    sent.msgId || 
                    sent.id || 
                    sent.message?.msgId || 
                    sent.message?.id || 
                    sent.data?.msgId || 
                    sent.data?.id || 
                    sent.cliMsgId || 
                    sent.data?.cliMsgId || 
                    ""
                );
                
                // Lưu ID tin nhắn để hỗ trợ thu hồi (Undo)
                const undoList = api.getUndoData(sent);

                pendingTikTokSelections.set(`${threadId}-${senderId}`, {
                    data: results,
                    currentChoices: results,
                    page: 1,
                    type: "search",
                    isVideo: true,
                    msgId: mId,
                    undoList: undoList
                });
            }
        } catch (e) {
            log.error("TikTok Search Error:", e.stack || e.message);
            api.sendMessage({ msg: `⚠️ Lỗi khi tìm kiếm: ${e.message}` }, threadId, threadType);
        }
    }
};

export async function handle(ctx) {
    const { api, content, threadId, threadType, senderId, log, message } = ctx;
    const key = `${threadId}-${senderId}`;
    const selection = pendingTikTokSelections.get(key);

    if (!selection) return false;

    log.info(`[TIKTOK] Handle: user=${senderId} content="${content}" selection_msgId=${selection.msgId} choicesLength=${selection.currentChoices.length}`);

    // Chỉ xử lý nếu nội dung là một số nguyên hợp lệ
    const choice = parseInt(content);
    if (isNaN(choice)) return false;
    
    if (choice < 1 || choice > selection.currentChoices.length) {
        log.warn(`[TIKTOK] Lựa chọn ${choice} vượt quá số lượng kết quả (${selection.currentChoices.length})`);
        return false;
    }

    // Nếu là reply, kiểm tra xem có reply đúng tin nhắn list không (tùy chọn nhưng tốt hơn)
    const quote = message?.data?.quote || message?.data?.content?.quote;
    if (quote) {
        const quoteId = String(quote.msgId || quote.id || "");
        if (selection.msgId && quoteId && String(selection.msgId) !== quoteId) return false;
    }

    const item = selection.currentChoices[choice - 1];
    if (!item) return false;

    // THỰC HIỆN THU HỒI (UNDO) TIN NHẮN SEARCH
    if (selection.undoList && selection.undoList.length > 0) {
        api.undoMessage(selection.undoList, threadId, threadType).catch(() => { });
    }

    const icons = ["akoi", "ok", "Đang tải...", "Xong rùi ✨"];
    let iconIdx = 0;
    const reactionInterval = setInterval(() => {
        if (ctx.message && ctx.message.data) {
            api.addReaction(icons[iconIdx % icons.length], ctx.message).catch(() => { });
            iconIdx++;
        }
    }, 2000);

    try {
        const videoData = {
            id: item.id || item.video_id,
            desc: item.desc || item.title,
            author: {
                uniqueId: item.author?.uniqueId || item.author?.unique_id || item.uniqueId,
                nickname: item.author?.nickname || item.author?.unique_id || item.author?.uniqueId || item.uniqueId
            },
            video: {
                url: item.video?.url || item.play || item.playUrl || item.playAddr || null,
                cover: item.video?.cover || item.cover,
                duration: item.video?.duration || (item.duration * 1000) || 0
            },
            images: item.images || [],
            music: {
                url: item.audioUrl || item.music?.url || item.music || null,
                title: item.music?.title || "Original Sound"
            },
            stat: {
                diggCount: item.stat?.diggCount || item.stats?.likes || item.digg_count || item.digg
            }
        };

        await sendVideo(ctx, videoData);
        return true;
    } catch (e) {
        log.error("TikTok Reply Error:", e.message);
        api.sendMessage({ msg: `⚠️ Lỗi khi tải video: ${e.message}` }, threadId, threadType);
    } finally {
        clearInterval(reactionInterval);
        pendingTikTokSelections.delete(key);
    }
    return false;
}

async function sendVideo(ctx, item) {
    const { api, threadId, threadType, senderId, log } = ctx;
    
    const vidId = String(item.id || item.video_id);
    const history = threadVideoHistory.get(threadId) || [];
    if (!history.includes(vidId)) {
        const newHistory = [...history, vidId].slice(-50);
        threadVideoHistory.set(threadId, newHistory);
    }

    const isImageMode = item.images && item.images.length > 0;
    const typeLabel = isImageMode ? "PHOTO" : "VIDEO";
    const descText = item.desc ? (item.desc.length > 80 ? item.desc.slice(0, 80) + "..." : item.desc) : "Không có nội dung";
    const msg = `🎵 TIKTOK ${typeLabel}\n👤 @${item.author?.uniqueId || "N/A"} (${item.author?.nickname || "N/A"})\n❤️ ${localeStr(item.stat?.diggCount || 0)} Tym | ${isImageMode ? `📸 ${item.images.length} Ảnh` : `⏱ ${Math.round((item.video?.duration || 0) / 1000)}s`}\n\n📝 ${descText}\n──────────────────\n💡 Thả tim (❤️) vào đây để lướt tiếp video của Idol này!`;

    if (isImageMode) {
        log.info(`[TIKTOK] Đang xử lý Photo Mode với ${item.images.length} ảnh...`);
        const tempPaths = [];
        try {
            // Tải ảnh về
            for (let i = 0; i < Math.min(item.images.length, 20); i++) {
                const imgPath = path.join(process.cwd(), `src/modules/cache/tk_img_${Date.now()}_${i}.jpg`);
                await downloadFile(item.images[i], imgPath);
                if (fs.existsSync(imgPath)) tempPaths.push(imgPath);
            }

            // Gửi ảnh kèm caption
            const sentImg = await api.sendMessage({ msg, attachments: tempPaths }, threadId, threadType);
            
            // Xử lý nhạc nền nếu có
            if (item.music?.url) {
                const musicPath = path.join(process.cwd(), `src/modules/cache/tk_mp3_${Date.now()}.mp3`);
                await downloadFile(item.music.url, musicPath);
                if (fs.existsSync(musicPath)) {
                    await api.sendVoiceUnified({ filePath: musicPath, threadId, threadType });
                    fs.unlinkSync(musicPath);
                }
            }

            // Lưu ID để hỗ trợ reaction
            if (sentImg) {
                const mId = String(sentImg.msgId || sentImg.data?.msgId || "");
                const cId = String(sentImg.cliMsgId || sentImg.data?.cliMsgId || "");
                const info = { id: item.id, uniqueId: String(item.author?.uniqueId || ""), senderId, threadId, threadType };
                if (mId) sentTikTokVideos.set(mId, info);
                if (cId) sentTikTokVideos.set(cId, info);
            }
        } catch (e) {
            log.error("TikTok Photo Mode Error:", e.message);
            api.sendMessage({ msg: "⚠️ Lỗi khi tải slideshow ảnh." }, threadId, threadType);
        } finally {
            tempPaths.forEach(p => { if (fs.existsSync(p)) fs.unlinkSync(p); });
        }
        return;
    }

    // Xử lý Video Mode
    try {
        let finalUrl = item.video.url;
        const tempPath = path.join(process.cwd(), `src/modules/cache/tiktok_dl_${Date.now()}.mp4`);

        // CDN link trực tiếp (từ TikWM search hoặc yt-dlp fallback) → tải luôn bằng axios
        if (finalUrl && (finalUrl.includes(".mp4") || finalUrl.includes("tikwm.com") || finalUrl.includes("tiktokcdn"))) {
            log.info("[TIKTOK] Tải CDN link trực tiếp...");
            await downloadFile(finalUrl, tempPath);
        } else {
            // yt-dlp download (nhanh nhất, tự handle cookies)
            const videoPageUrl = finalUrl || `https://www.tiktok.com/@${item.author?.uniqueId || "tiktok"}/video/${item.id}`;
            log.info(`[TIKTOK] yt-dlp tải: ${videoPageUrl}`);
            await youtubedl(videoPageUrl, {
                output: tempPath,
                noWarnings: true,
                format: "best",
                mergeOutputFormat: "mp4",
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            });
        }

        // Upload thẳng lên Zalo CDN (bỏ tmpfiles)
        log.info("[TIKTOK] Upload thẳng lên Zalo CDN...");
        const sentRes = await api.sendVideoUnified({
            videoPath: tempPath,
            thumbnailUrl: item.video.cover,
            msg,
            threadId,
            threadType
        });

        if (sentRes) {
            const mId = String(sentRes.msgId || sentRes.id || sentRes.data?.msgId || "");
            const cId = String(sentRes.cliMsgId || sentRes.data?.cliMsgId || "");
            const videoInfo = { id: item.id, uniqueId: String(item.author?.uniqueId || ""), senderId, threadId, threadType };
            if (mId) sentTikTokVideos.set(mId, videoInfo);
            if (cId) sentTikTokVideos.set(cId, videoInfo);
        }
        
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (e) {
        log.error("TikTok Video Mode Error:", e.message);
        api.sendMessage({ msg: "⚠️ Lỗi khi gửi video." }, threadId, threadType);
    }
}

export async function handleReaction(ctx) {
    const { event, threadId, log, reaction, api, threadType } = ctx;
    const reactorId = String(reaction?.data?.uidFrom || event?.uidFrom || event?.userId || "");
    
    // Đảm bảo ctx có senderId của người thả tim để showList lưu đúng key
    ctx.senderId = reactorId;

    const content = event?.content || {};
    
    // CHỈ XỬ LÝ NẾU LÀ THẢ TIM (heart reaction)
    const icon = String(content.rIcon || "");
    if (icon !== "/-heart" && icon !== "❤️") return;

    const tgtMsg = content?.rMsg?.[0] || {};
    const possibleIds = [
        String(tgtMsg.gMsgID || ""),
        String(tgtMsg.cMsgID || ""),
        String(content.msgId || ""),
        String(content.cliMsgId || "")
    ].filter(Boolean);

    for (const rId of possibleIds) {
        if (sentTikTokVideos.has(rId)) {
            const data = sentTikTokVideos.get(rId);

            // Ghi đè thông tin thread từ dữ liệu đã lưu để gửi lại đúng nhóm
            if (data.threadId) ctx.threadId = data.threadId;
            if (data.threadType !== undefined) ctx.threadType = data.threadType;

            // Chặn spam reaction
            const cooldownKey = `${rId}-${reactorId}`;
            if (reactionCooldown.has(cooldownKey)) return;
            reactionCooldown.set(cooldownKey, true);
            setTimeout(() => reactionCooldown.delete(cooldownKey), 5000);

            log.info(`[TIKTOK] Bắt được thả tim trên video: ${rId} -> user: ${data.uniqueId} | itemId: ${data.id}`);
            
            try {
                // Lấy từ cache hoặc fetch mới bằng TikWM API (nhanh ~1-2s)
                let userPosts = [];
                if (userVideoCache.has(data.uniqueId)) {
                    userPosts = userVideoCache.get(data.uniqueId);
                    log.info(`[TIKTOK] Dùng cache ${userPosts.length} video của @${data.uniqueId}`);
                } else {
                    // Dùng TikWM search @username (nhanh ~1.3s, đã test OK)
                    log.info(`[TIKTOK] Fetch video @${data.uniqueId} bằng TikWM search...`);
                    try {
                        // Request 50 kết quả để sau khi lọc đúng user vẫn còn nhiều video
                        const searchResults = await searchTiktok(`@${data.uniqueId}`, 50);
                        // Lọc chỉ lấy video của ĐÚNG user đó
                        userPosts = searchResults.filter(v => 
                            v.author?.uniqueId === data.uniqueId || v.author?.unique_id === data.uniqueId
                        );
                        if (userPosts.length > 0) {
                            log.info(`[TIKTOK] TikWM search lấy được ${userPosts.length} video đúng @${data.uniqueId}`);
                        }
                    } catch (searchErr) {
                        log.warn(`[TIKTOK] TikWM search lỗi: ${searchErr.message}`);
                    }

                    // Fallback nhanh nếu TikWM search rỗng (chỉ lấy 3 bài để gửi luôn)
                    if (userPosts.length === 0) {
                        log.info(`[TIKTOK] TikWM search rỗng, fallback yt-dlp nhanh (3 video) cho @${data.uniqueId}...`);
                        const userPostsRes = await fetchVideosByYtDlp(data.uniqueId, 3).catch(err => {
                            log.error(`[TIKTOK] Profile error: ${err.message}`);
                            return { success: false, videos: [] };
                        });
                        userPosts = userPostsRes.success ? userPostsRes.videos : [];
                    }

                    if (userPosts.length > 0) {
                        userVideoCache.set(data.uniqueId, userPosts);
                        setTimeout(() => userVideoCache.delete(data.uniqueId), 30 * 60 * 1000); // TTL 30 phút
                    }
                    log.info(`[TIKTOK] Lấy nhanh xong: ${userPosts.length} video.`);

                    // CHẠY NGẦM yt-dlp để thu thập thêm bài cho cache
                    log.info(`[TIKTOK] Đang chạy ngầm yt-dlp lấy thêm 20 video cho @${data.uniqueId} để chống lặp...`);
                    fetchVideosByYtDlp(data.uniqueId, 20).then(moreRes => {
                        if (moreRes.success && moreRes.videos.length > 0) {
                            const cached = userVideoCache.get(data.uniqueId) || [];
                            const newIds = new Set(cached.map(v => v.id || v.video_id));
                            let added = 0;
                            for (const v of moreRes.videos) {
                                if (!newIds.has(v.video_id)) {
                                    cached.push(v);
                                    newIds.add(v.video_id);
                                    added++;
                                }
                            }
                            userVideoCache.set(data.uniqueId, cached);
                            log.info(`[TIKTOK] Chạy ngầm xong: Thêm ${added} video vào cache cho @${data.uniqueId} (Tổng: ${cached.length})`);
                        }
                    }).catch(e => log.warn(`[TIKTOK] Chạy ngầm yt-dlp lỗi: ${e.message}`));
                }

                // Lọc bỏ chính video đang được thả tim VÀ các video đã gửi gần đây trong nhóm
                const currentVideoId = String(data.id);
                const history = threadVideoHistory.get(threadId) || [];
                
                let finalPosts = userPosts.filter(v => {
                    const vid = String(v.id || v.video_id);
                    return vid !== currentVideoId && !history.includes(vid);
                });

                // Nếu sau khi lọc lịch sử mà hết video, reset lịch sử và lọc lại (trừ video hiện tại)
                if (finalPosts.length === 0 && userPosts.length > 1) {
                    log.info(`[TIKTOK] Reset lịch sử cho @${data.uniqueId} để có thêm video chọn.`);
                    threadVideoHistory.set(threadId, []); 
                    finalPosts = userPosts.filter(v => String(v.id || v.video_id) !== currentVideoId);
                }

                // Nếu cào profile thất bại hoặc không có video nào, chuyển sang cào ngẫu nhiên theo ID tác giả
                if (finalPosts.length === 0) {
                    log.info(`[TIKTOK] Profile không có thêm video, thử search ngẫu nhiên với từ khóa @${data.uniqueId}...`);
                    const relatedRes = await searchTiktok(`@${data.uniqueId}`, 15).catch(() => []);
                    finalPosts = relatedRes.filter(v => String(v.id || v.video_id) !== currentVideoId);
                    log.info(`[TIKTOK] Tìm thấy ${finalPosts.length} video tương tự qua search.`);
                }

                if (finalPosts.length === 0) {
                    log.warn(`[TIKTOK] Không tìm thấy thêm bất kỳ video nào cho @${data.uniqueId}`);
                    return api.sendMessage({ msg: `⚠️ Không tìm thấy thêm video nào khác từ @${data.uniqueId} hoặc video tương tự.` }, threadId, threadType);
                }

                log.info(`[TIKTOK] Tổng cộng có ${finalPosts.length} video hợp lệ để chọn ngẫu nhiên.`);

                // Chọn ngẫu nhiên 1 video từ danh sách đã lọc
                const randomItem = finalPosts[Math.floor(Math.random() * finalPosts.length)];
                if (randomItem) {
                    const vidId = randomItem.id || randomItem.video_id;
                    log.info(`[TIKTOK] Gửi ngẫu nhiên video: ${vidId}`);
                    
                    // Lưu vào history để tránh lặp
                    const sentVid = String(vidId);
                    const hist = threadVideoHistory.get(threadId) || [];
                    hist.push(sentVid);
                    if (hist.length > 50) hist.shift();
                    threadVideoHistory.set(threadId, hist);

                    // Ghép link TikTok từ ID → dùng downloadTikTok (TikWM API) cho nhanh như autodown
                    const tiktokUrl = `https://www.tiktok.com/@${data.uniqueId}/video/${vidId}`;
                    log.info(`[TIKTOK] Dùng TikWM API tải nhanh: ${tiktokUrl}`);
                    const dlData = await downloadTikTok(tiktokUrl);
                    
                    if (dlData && dlData.videoUrl) {
                        // TikWM trả CDN link trực tiếp → tải nhanh bằng axios như autodown
                        const videoData = {
                            id: dlData.id || vidId,
                            desc: dlData.title || randomItem.title,
                            author: {
                                uniqueId: dlData.uniqueId || data.uniqueId,
                                nickname: dlData.author || data.uniqueId
                            },
                            video: {
                                url: dlData.videoUrl,  // CDN link nhanh từ TikWM
                                cover: dlData.cover || randomItem.cover,
                                duration: randomItem.video?.duration ?? randomItem.duration ?? 0
                            },
                            images: dlData.images || [],
                            music: { url: dlData.audioUrl || null, title: "Original Sound" },
                            stat: {
                                diggCount: dlData.stats?.likes || randomItem.stat?.diggCount || 0
                            }
                        };
                        await sendVideo(ctx, videoData);
                    } else {
                        // Fallback: dùng URL gốc từ yt-dlp nếu TikWM fail
                        log.warn(`[TIKTOK] TikWM fail, fallback yt-dlp download cho video ${vidId}`);
                        const videoUrl = randomItem.url || randomItem.video?.url || randomItem.play || randomItem.playUrl;
                        const videoData = {
                            id: randomItem.id || randomItem.video_id,
                            desc: randomItem.desc || randomItem.title,
                            author: randomItem.author || { uniqueId: data.uniqueId, nickname: data.uniqueId },
                            video: {
                                url: videoUrl,
                                cover: randomItem.video?.cover || randomItem.cover,
                                duration: randomItem.video?.duration ?? randomItem.duration ?? 0
                            },
                            stat: {
                                diggCount: randomItem.stat?.diggCount || randomItem.stats?.likes || 0
                            }
                        };
                        await sendVideo(ctx, videoData);
                    }
                }
            } catch (err) {
                log.error("Lỗi khi xử lý reaction TikTok:", err.stack || err.message);
                api.sendMessage({ msg: `⚠️ Lỗi khi gợi ý video: ${err.message}` }, threadId, threadType);
            }
            return;
        }
    }
}

function localeStr(num) {
    if (num === undefined || num === null) return "0";
    return Number(num).toLocaleString("vi-VN");
}
