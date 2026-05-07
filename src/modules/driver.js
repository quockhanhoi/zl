import { listFiles, deleteFile } from "../utils/googleDrive.js";
import { log } from "../logger.js";

export const name = "driver";
export const description = "Quản lý Google Drive: Liệt kê, tải về (reply STT), xóa (reply del STT)";

// Cache lưu danh sách file theo nhóm để STT chính xác
const sessionCache = new Map(); // threadId -> { files, lastUpdate }

export const commands = {
    driver: async (ctx) => {
        const { api, threadId, threadType, args } = ctx;
        const page = parseInt(args[0]) || 1;
        const pageSize = 10;

        try {
            const files = await listFiles(100);

            if (!files || files.length === 0) {
                return api.sendMessage({ msg: "📂 Hiện tại không có file nào trong thư mục Google Drive." }, threadId, threadType);
            }

            sessionCache.set(threadId, { files, lastUpdate: Date.now() });

            const totalPages = Math.ceil(files.length / pageSize);
            if (page > totalPages) {
                return api.sendMessage({ msg: `⚠️ Trang ${page} không tồn tại. Tổng cộng có ${totalPages} trang.` }, threadId, threadType);
            }

            const startIdx = (page - 1) * pageSize;
            const endIdx = startIdx + pageSize;
            const paginatedFiles = files.slice(startIdx, endIdx);

            let msg = `📂 [ GOOGLE DRIVE - TRANG ${page}/${totalPages} ]\n`;
            msg += "──────────────────\n";

            paginatedFiles.forEach((file, index) => {
                const stt = startIdx + index + 1;
                const size = file.size ? (file.size / (1024 * 1024)).toFixed(2) + " MB" : "N/A";
                msg += `${stt}. 📄 ${file.name}\n`;
                msg += `   ⚖️ ${size} | 🆔 ${file.id.slice(-6)}\n`;
                msg += "──────────────────\n";
            });

            msg += "💡 Reply số thứ tự (STT) để tải về.\n";
            msg += "💡 Reply 'del [STT]' để xóa file.\n";
            msg += `💡 Dùng '!driver [số trang]' để xem trang khác.`;

            return api.sendMessage({ msg }, threadId, threadType);

        } catch (e) {
            return api.sendMessage({ msg: `⚠️ Đã xảy ra lỗi: ${e.message}` }, threadId, threadType);
        }
    }
};

/**
 * Xử lý khi người dùng reply vào danh sách
 */
export async function handle(ctx) {
    const { api, threadId, threadType, message, content } = ctx;

    // Chỉ xử lý nếu tin nhắn là một reply (quote)
    const quote = message.data?.quote || message.data?.content?.quote;
    if (!quote) return false;

    // Kiểm tra xem tin nhắn bị quote có phải là danh sách Drive không
    const quoteDesc = quote.msg || quote.content || "";
    if (!quoteDesc.includes("GOOGLE DRIVE")) return false;

    const session = sessionCache.get(threadId);
    if (!session) return false;

    const body = content.trim().toLowerCase();
    const files = session.files;

    // 1. Trường hợp XÓA: del 1, del 2, del 3 4...
    if (body.startsWith("del")) {
        const parts = body.split(/[\s+]+/).filter(p => p !== "del" && p !== "");
        if (parts.length === 0) return false;

        const results = [];
        const toDeleteIds = [];

        for (const part of parts) {
            const stt = parseInt(part);
            if (!isNaN(stt) && stt >= 1 && stt <= files.length) {
                toDeleteIds.push({ stt, file: files[stt - 1] });
            }
        }

        if (toDeleteIds.length === 0) return false;

        for (const item of toDeleteIds) {
            try {
                await deleteFile(item.file.id);
                results.push(`✅ Đã xóa STT ${item.stt}: ${item.file.name}`);
            } catch (err) {
                results.push(` Lỗi xóa STT ${item.stt}: ${err.message}`);
            }
        }

        await api.sendMessage({ msg: results.join("\n") }, threadId, threadType);
        return true;
    }

    // 2. Trường hợp TẢI VỀ: reply 1, 2, 3...
    const stt = parseInt(body);
    if (!isNaN(stt) && stt >= 1 && stt <= files.length) {
        const file = files[stt - 1];
        const downloadUrl = `https://drive.google.com/uc?id=${file.id}&export=download`;

        await api.sendMessage({ msg: `⏳ Đang lấy file "${file.name}" cho cậu...` }, threadId, threadType);

        if (file.mimeType.includes("video")) {
            try {
                if (api.sendVideoDirect) {
                    await api.sendVideoDirect({
                        videoUrl: downloadUrl,
                        msg: `📄 File: ${file.name}\n🔗 Link: ${downloadUrl}`,
                        threadId,
                        threadType
                    });
                    return true;
                }
            } catch (err) {
                log.warn("[Driver] sendVideoDirect failed, falling back to link");
            }
        }

        await api.sendMessage({
            msg: `📂 [ KẾT QUẢ TẢI VỀ ]\n📄 Tên: ${file.name}\n🔗 Link trực tiếp: ${downloadUrl}\n💡 Bạn có thể dán link này vào trình duyệt để tải về.`
        }, threadId, threadType);
        return true;
    }

    return false;
}
