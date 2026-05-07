import { getGeniusLyrics } from "../utils/genius.js";

export const name = "lyric";
export const description = "Tìm lời bài hát siêu cấp từ Genius";

export const commands = {
    lyric: async (ctx) => {
        const { api, threadId, threadType, args, message } = ctx;
        const query = args.join(" ").trim();

        if (!query) return api.sendMessage({ msg: "⚠️ Nhập tên bài hát cần tìm lời!" }, threadId, threadType);

        await api.addReaction("🔍", message).catch(() => {});
        // Vì Zalo không hỗ trợ sửa tin nhắn (edit), mình sẽ không gửi tin nhắn "Đang tìm..." để tránh rác box.
        // Thay vào đó chỉ dùng Reaction làm tín hiệu đang xử lý.

        try {
            const lyrics = await getGeniusLyrics(query);
            
            if (!lyrics) {
                await api.addReaction("⚠️", message).catch(() => {});
                return api.sendMessage({ msg: `⚠️ Rất tiếc, không tìm thấy lời cho bài "${query}" trên Genius.` }, threadId, threadType);
            }

            await api.addReaction("✅", message).catch(() => {});
            
            const header = `[ 📝 LỜI BÀI HÁT: ${query.toUpperCase()} ]\n─────────────────\n`;
            const fullMsg = header + lyrics;

            if (fullMsg.length > 2000) {
                await api.sendMessage({ msg: fullMsg.slice(0, 2000) + "..." }, threadId, threadType);
                await api.sendMessage({ msg: "...Phần tiếp theo:\n" + fullMsg.slice(2000) }, threadId, threadType);
            } else {
                await api.sendMessage({ msg: fullMsg }, threadId, threadType);
            }

        } catch (e) {
            await api.addReaction("⚠️", message).catch(() => {});
            api.sendMessage({ msg: `⚠️ Lỗi: ${e.message}` }, threadId, threadType);
        }
    }
};
