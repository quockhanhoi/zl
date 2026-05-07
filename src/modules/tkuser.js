import { getUserPosts } from "../utils/tiktokDownloader.js";
import { log } from "../logger.js";

export const name = "tkuser";
export const description = "Lấy danh sách video mới nhất từ profile TikTok";

export const commands = {
    tkuser: async (ctx) => {
        const { api, threadId, threadType, args } = ctx;
        const username = args[0];
        const action = args[1]?.toLowerCase();

        if (!username) {
            return api.sendMessage({ msg: "⚠️ Vui lòng nhập username TikTok (ví dụ: !tkuser thanhtruc_8686)" }, threadId, threadType);
        }

        try {
            await api.sendMessage({ msg: `⏳ Đang lấy danh sách video của @${username}...` }, threadId, threadType);
            
            const count = (action === "api") ? 20 : (parseInt(args[1]) || 6);
            const result = await getUserPosts(username, count); 

            if (result.error) {
                if (result.error.includes("403")) {
                    return api.sendMessage({ msg: `⚠️ Lỗi: API TikTok đang chặn IP của Bot (403 Forbidden). Bạn có thể thử lại sau hoặc dùng Proxy.` }, threadId, threadType);
                }
                return api.sendMessage({ msg: `⚠️ Lỗi: ${result.error}` }, threadId, threadType);
            }

            const { author, itemList, hasMore } = result;
            
            if (!itemList || itemList.length === 0) {
                return api.sendMessage({ msg: `⚠️ Không tìm thấy video nào công khai trên profile của @${author.uniqueId}` }, threadId, threadType);
            }

            if (action === "api") {
                let apiList = `[ 🔗 LIST API VIDEO - @${author.uniqueId} ]\n─────────────────\n`;
                itemList.forEach((v, i) => {
                    apiList += `${i + 1}. ${v.title.slice(0, 30)}...\n`;
                    apiList += `📂 Link Tải: ${v.playUrl}\n\n`;
                });
                apiList += `💡 Đây là các link trực tiếp không logo bồ nhé!`;
                return api.sendMessage({ msg: apiList }, threadId, threadType);
            }

            let msg = `[ TIKTOK PROFILE ]\n─────────────────\n`;
            msg += `👤 Tên: ${author.nickname}\n`;
            msg += `🆔 ID: @${author.uniqueId}\n`;
            if (author.signature) msg += `📝 Bio: ${author.signature}\n`;
            msg += `─────────────────\n`;
            msg += `🎥 DANH SÁCH VIDEO MỚI NHẤT:\n\n`;

            itemList.forEach((v, i) => {
                const type = v.isImages ? "🖼️ Slideshow" : "📹 Video";
                msg += `${i + 1}. ${v.title.slice(0, 50)}${v.title.length > 50 ? "..." : ""}\n`;
                msg += `   ➤ Loại: ${type} | 👀 ${v.stats.views.toLocaleString()}\n`;
                msg += `   🔗 Link: https://www.tiktok.com/@${author.uniqueId}/video/${v.id}\n\n`;
            });

            if (hasMore) {
                msg += `👉 Dùng !tkuser ${username} 12 để xem nhiều hơn.\n`;
            }
            msg += `💡 Dùng !tkuser ${username} api để lấy danh sách link tải trực tiếp!`;

            if (author.avatar) {
                await api.sendMessage({ msg, attachments: [author.avatar] }, threadId, threadType);
            } else {
                await api.sendMessage({ msg }, threadId, threadType);
            }

        } catch (e) {
            log.error(`[tkuser] Error: ${e.message}`);
            await api.sendMessage({ msg: `⚠️ Có lỗi xảy ra khi lấy thông tin người dùng.` }, threadId, threadType);
        }
    }
};
