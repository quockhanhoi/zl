export const name = "thuhoi";
export const description = "Gỡ / Thu hồi tin nhắn đang reply (Dành cho Admin hoặc tự thu hồi tin của bot)";

export const commands = {
    thuhoi: async (ctx) => {
        const { api, message, threadId, threadType, senderId, adminIds, log, messageCache } = ctx;

        const quote = message.data?.quote;
        if (!quote) {
            return api.sendMessage({ msg: "⚠️ Vui lòng phản hồi (reply) lại tin nhắn bạn muốn thu hồi/xoá." }, threadId, threadType);
        }

        const msgIdToDel = String(quote.globalMsgId || quote.msgId || quote.cliMsgId || "");
        const cliMsgIdToDel = String(quote.cliMsgId || "");
        
        const cachedMsg = messageCache?.get(msgIdToDel) || messageCache?.get(cliMsgIdToDel);
        
        // rawOwnerId bị mất precision do Zalo parse (ví dụ 6507497158633565000)
        let ownerId = cachedMsg ? cachedMsg.senderId : String(quote.ownerId || "");
        
        // Tự phục hồi: Nếu người xóa ĐANG XÓA TIN CỦA CHÍNH HỌ (ownerId hao hao senderId)
        if (!cachedMsg && ownerId && String(senderId).startsWith(ownerId.slice(0, -3))) {
            ownerId = String(senderId);
        }

        const botId = String(api.getOwnId());
        const isBotMessage = ownerId && botId.startsWith(ownerId.slice(0, -2));
        const safeOwnerId = isBotMessage ? botId : (ownerId || String(senderId));

        // Nếu cache trống và không phải tin của bot/người gửi, báo lỗi không có exact ID
        if (!cachedMsg && !isBotMessage && safeOwnerId.endsWith("000")) {
            return api.sendMessage({ msg: "⚠️ Không thể lấy UID chính xác của người này do bot vừa khởi động lại (Mất Cache). Vui lòng dùng tính năng xóa của Zalo." }, threadId, threadType);
        }

        try {
            // Nếu là tin của bot, luôn dùng api.undo
            if (isBotMessage) {
                await api.undoMessage({ msgId: msgIdToDel, cliMsgId: cliMsgIdToDel }, threadId, threadType);
                log.success(`Đã thu hồi tin nhắn thành công (${msgIdToDel})`);
                return;
            }
        } catch (undoErr) {
            log.debug(`Undo failed: ${undoErr.message}`);
            // Nếu là tin của bot nhưng undo lỗi, thì chắc chắn tin đã bị thu hồi hoặc quá hạn
            if (isBotMessage) {
                return api.sendMessage({ msg: "⚠️ Không thể thu hồi tin nhắn này (Có thể đã bị xóa hoặc quá hạn)." }, threadId, threadType);
            }
        }

        // --- XÓA TIN NGƯỜI KHÁC (Cần quyền admin) ---
        if (!adminIds.includes(String(senderId))) {
            return api.sendMessage({ msg: "⚠️ Bot chỉ có thể gỡ tin nhắn người khác nếu người ra lệnh là Admin." }, threadId, threadType);
        }

        try {
            log.debug(`[THUHOI_DEBUG] Executing zDeleteMessage | cliMsgId: ${cliMsgIdToDel} | msgId: ${msgIdToDel} | uidFrom: ${safeOwnerId} | threadId: ${threadId}`);
            await api.zDeleteMessage({
                cliMsgId: cliMsgIdToDel,
                msgId: msgIdToDel,
                uidFrom: safeOwnerId,
                onlyMe: false
            }, threadId, threadType);
            log.success(`Đã xoá tin nhắn của ${safeOwnerId} khỏi nhóm ${threadId}`);
        } catch (delErr) {
            log.error(`Lỗi xoá tin nhắn: ${delErr.message}`);
            await api.sendMessage({ msg: `⚠️ Bot không thể gỡ tin nhắn này. Đảm bảo bot là Trưởng/Phó nhóm (Lỗi: ${delErr.message})` }, threadId, threadType);
        }
    }
};
