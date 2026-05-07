/**
 * Xóa tag mention khỏi tin nhắn
 * @param {Object} message Đối tượng tin nhắn từ Zalo API
 * @returns {string} Nội dung tin nhắn đã xóa tag
 */
export function removeMention(message) {
    let msg = message.data?.msg || "";
    if (message.data?.mentions && Array.isArray(message.data.mentions)) {
        // Sắp xếp mention từ dưới lên để không làm lệch index khi xóa
        const mentions = [...message.data.mentions].sort((a, b) => b.pos - a.pos);
        for (const m of mentions) {
            const before = msg.slice(0, m.pos);
            const after = msg.slice(m.pos + (m.len || m.length || 0));
            msg = before + after;
        }
    }
    // Xóa bớt khoảng trắng thừa
    return msg.replace(/\s+/g, " ").trim();
}
