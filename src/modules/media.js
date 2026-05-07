/**
 * Module: Media
 * Minh họa gửi file, hình ảnh, sticker
 */

import { log } from "../logger.js";

export const name = "media";
export const description = "Lệnh gửi sticker, ảnh, video...";

async function reply(ctx, text) {
    await ctx.api.sendMessage(
        { msg: text, quote: ctx.message },
        ctx.threadId,
        ctx.threadType
    );
}

export const commands = {
    // !sticker [từ khóa] - Gửi 1 sticker ngẫu nhiên theo từ khoá
    // !sticker [từ khóa] hoặc !stk [từ khóa] - Gửi 1 sticker xịn theo từ khoá
    sticker: async (ctx) => {
        const { api, args, threadId, threadType, prefix, message } = ctx;
        const keyword = args.join(" ").trim() || "hello";

        try {
            // Ưu tiên getStickersEnhanced (trả về full object) trước, fallback getStickers
            let res;
            if (api.getStickersEnhanced) {
                res = await api.getStickersEnhanced({ keyword });
            } else if (api.getStickers) {
                const ids = await api.getStickers(keyword);
                if (ids && ids.length) res = ids.map(id => ({ id, cateId: 1, type: 1 }));
            }

            if (!res || !res.length) {
                return api.sendMessage({ msg: `⚠️ Không tìm thấy sticker nào phù hợp cho "${keyword}".` }, threadId, threadType);
            }

            // Gửi sticker đầu tiên tìm thấy
            const st = res[0];
            await api.sendSticker({
                id: String(st.id || st), 
                cateId: Number(st.cateId || 1),
                type: Number(st.type || 1)
            }, threadId, threadType);

        } catch (e) {
            log.error(`Lỗi lệnh sticker: ${e.message}`);
            api.sendMessage({ msg: `⚠️ Lỗi khi lấy sticker: ${e.message}` }, threadId, threadType);
        }
    },
    stksearch: async (ctx) => {
        return commands.sticker(ctx);
    },

    // !undo - Bot thu hồi tất cả tin nhắn gần nhất của bot (nếu có message id đang quote)
    undo: async (ctx) => {
        // Nếu người dùng reply (quote) một tin nhắn của bot xong gõ !undo
        if (ctx.message.data.quote && ctx.message.data.quote.ownerId) {
            const q = ctx.message.data.quote;
            try {
                await ctx.api.undoMessage({
                    msgId: q.globalMsgId,
                    cliMsgId: q.cliMsgId
                }, ctx.threadId, ctx.threadType);
                await reply(ctx, "✅ Đã thu hồi tin nhắn thành công.");
            } catch (e) {
                await reply(ctx, "⚠️ Lỗi: Tin nhắn này không phải của Bot hoặc đã quá hạn thu hồi.");
            }
        } else {
            let guide = `[ ↩️ THU HỒI TIN NHẮN ]\n`;
            guide += `─────────────────\n`;
            guide += `◈ Hãy phản hồi (reply) vào tin nhắn của Bot gõ !undo để thu hồi.\n`;
            guide += `─────────────────\n`;
            guide += `✨ Chỉ thu hồi được tin nhắn do chính Bot gửi!`;
            await reply(ctx, guide);
        }
    }
};
