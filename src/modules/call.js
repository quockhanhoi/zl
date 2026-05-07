
import { ThreadType } from "../utils/zca-js-shim.js";

export const name = "call";
export const description = "Spam cuộc gọi Zalo ảo đến mục tiêu";

function taoIdCall() {
    let result = "";
    for (let i = 0; i < 9; i++) {
        result += Math.floor(Math.random() * 10).toString();
    }
    return result;
}

export const commands = {
    call: async (ctx) => {
        const { args, message, api, isOwner, threadId, threadType } = ctx;

        if (!isOwner) {
            return ctx.reply("⚠️ Bạn không có quyền sử dụng lệnh này!");
        }

        if (args.length < 1) {
            return ctx.reply("⚠️ Cú pháp: call [số lần] + tag người dùng\nVí dụ: call 5 @User");
        }

        const count = parseInt(args[0]);
        if (isNaN(count) || count <= 0 || count > 50) {
            return ctx.reply("⚠️ Số lần gọi phải từ 1 đến 50.");
        }

        const mentions = message.mentions;
        if (!mentions || mentions.length === 0) {
            return ctx.reply("⚠️ Vui lòng tag ít nhất một người dùng!");
        }

        const targetIds = mentions.map(m => String(m.uid));
        
        ctx.reply(`📞 Bắt đầu thực hiện ${count} cuộc gọi đến ${targetIds.length} người dùng...`);

        for (const targetId of targetIds) {
            for (let i = 0; i < count; i++) {
                try {
                    const callId = taoIdCall();
                    await api.sendCall({ targetId, callId });
                    // Chờ một chút giữa các cuộc gọi để tránh bị Zalo chặn
                    await new Promise(r => setTimeout(r, 2000));
                } catch (e) {
                    console.error(`[CALL] Lỗi gọi ${targetId}:`, e.message);
                }
            }
        }

        return ctx.reply("✅ Đã hoàn thành tiến trình gọi spam.");
    }
};
