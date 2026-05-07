import { statsManager } from "../utils/statsManager.js";
import { groupAdminManager } from "../utils/groupAdminManager.js";
import { log } from "../logger.js";

export const name = "kick";
export const description = "Module quản lý thành viên và phân quyền Key Vàng/Bạc";

const ROLES = {
    "Admin": 100,
    "Vàng": 50,
    "Bạc": 20,
    "Thành viên": 0
};

async function reply(ctx, text) {
    const { api, threadId, threadType, message } = ctx;
    const quote = message.data?.quote || message.data?.content?.quote || message.data;
    const targetUid = String(quote?.uidFrom || quote?.ownerId || "");
    
    let mentions = [];
    if (text.includes("@tag") && targetUid) {
        const name = "@Thành viên"; 
        const pos = text.indexOf("@tag");
        text = text.replace("@tag", name);
        mentions.push({ uid: targetUid, pos, len: name.length });
    }

    await api.sendMessage(
        { msg: text, quote: message, mentions },
        threadId,
        threadType
    );
}

function getLevel(uid, threadId, adminIds) {
    if (adminIds.includes(String(uid))) return ROLES["Admin"];
    const stats = statsManager.getStats(threadId, uid);
    return ROLES[stats?.role] || 0;
}

// Helper lấy tên nhanh từ cache hoặc API
async function getTargetName(api, threadId, uid) {
    const stats = statsManager.getStats(threadId, uid);
    if (stats?.name && stats.name !== "Người dùng") return stats.name;
    try {
        const userInfo = await api.getUserInfo(uid);
        return userInfo?.displayName || userInfo?.name || uid;
    } catch {
        return uid;
    }
}

export const commands = {
    kick: async (ctx) => {
        const { api, threadId, threadType, senderId, adminIds, args, message, prefix } = ctx;
        if (!ctx.isGroup) return reply(ctx, "⚠️ Lệnh này chỉ dùng trong nhóm!");

        const senderLevel = getLevel(senderId, threadId, adminIds);
        let hasPermission = senderLevel >= ROLES["Bạc"];
        let isBoxAdmin = false;

        if (!hasPermission) {
            try {
                const groupInfo = await api.getGroupInfo(threadId);
                const groupData = groupInfo.gridInfoMap?.[threadId] || groupInfo[threadId] || groupInfo;
                if (groupData?.adminIds?.includes(String(senderId)) || groupData?.creatorId === String(senderId)) {
                    isBoxAdmin = true;
                    hasPermission = true;
                }
            } catch (e) { console.error("[DEBUG KICK] Lỗi check quyền QTV:", e.message); }
        }

        if (!hasPermission) return reply(ctx, "⚠️ Bạn cần ít nhất Key Bạc hoặc là Quản trị viên nhóm để dùng lệnh này!");

        const quote = message.data?.quote || message.data?.content?.quote;
        let targetIds = [];
        const hasMentions = message.data?.mentions?.length > 0;

        if (hasMentions) {
            message.data.mentions.forEach(m => {
                const uid = String(m.uid);
                if (!targetIds.includes(uid)) targetIds.push(uid);
            });
        } else if (quote?.uidFrom || quote?.ownerId) {
            targetIds.push(String(quote.uidFrom || quote.ownerId));
        }
        args.forEach(arg => { if (/^\d+$/.test(arg) && !targetIds.includes(arg)) targetIds.push(arg); });

        const finalTargets = targetIds.filter(tid => {
            if (tid === senderId) return false;
            const targetLevel = getLevel(tid, threadId, adminIds);
            if (isBoxAdmin) return targetLevel < ROLES["Admin"]; 
            return targetLevel < senderLevel;
        });

        if (finalTargets.length === 0) {
            if (targetIds.length > 0) return reply(ctx, "⚠️ Không thể kick người có chức vụ bằng/cao hơn!");
            return reply(ctx, `◈ Cú pháp: ${prefix}kick [@tag / reply / ID]`);
        }

        try {
            await api.removeUserFromGroup(String(threadId), finalTargets);
            const tagString = finalTargets.map(() => "@tag").join(", ");
            await ctx.reply(`⚔️ [ TRỤC XUẤT ] ⚔️\n━━━━━━━━━━━━━━━━━━\n✅ Đã tiễn ${tagString} lên đường!\n━━━━━━━━━━━━━━━━━━\n📌 Tổng cộng: ${finalTargets.length} đối tượng.`, finalTargets);
        } catch (e) {
            await ctx.reply(`⚠️ Không thể kick: ${e.message}. Bot cần quyền phó/trưởng nhóm!`);
        }
    },

    setkey: async (ctx) => {
        const { api, threadId, senderId, adminIds, args, message, prefix } = ctx;
        if (!ctx.isGroup) return reply(ctx, "⚠️ Lệnh này chỉ dùng trong nhóm!");

        const isBotAdmin = adminIds.includes(String(senderId));
        const senderLevel = getLevel(senderId, threadId, adminIds);

        if (senderLevel < ROLES["Vàng"]) return reply(ctx, "⚠️ Chỉ những người có Key Vàng mới được quyền cấp Key.");

        const roleKeywords = {
            "Vàng": ["vàng", "vàng", "v", "gold", "vang"],
            "Bạc": ["bạc", "bạc", "b", "silver", "bac"],
            "Owner": ["owner", "trưởng nhóm", "truong nhom"],
            "Thành viên": ["xoa", "xóa", "xóa", "del", "huy", "hủy", "hủy", "remove"]
        };

        let resolvedRole = null;
        let idArgs = [];

        args.forEach(arg => {
            const norm = arg.toLowerCase().normalize("NFC");
            const normNFD = arg.toLowerCase().normalize("NFD");
            let isRole = false;
            for (const [roleName, keywords] of Object.entries(roleKeywords)) {
                if (keywords.includes(norm) || keywords.includes(normNFD)) {
                    resolvedRole = roleName;
                    isRole = true;
                    break;
                }
            }
            if (!isRole && /^\d+$/.test(arg)) if (!idArgs.includes(arg)) idArgs.push(arg);
        });

        let targetIds = [];
        const quote = message.data?.quote || message.data?.content?.quote;
        const hasMentions = message.data?.mentions?.length > 0;

        // Nếu có @mention thì dùng mentions (tránh trùng với quote khi reply+tag cùng lúc)
        if (hasMentions) {
            message.data.mentions.forEach(m => {
                const uid = String(m.uid);
                if (!targetIds.includes(uid)) targetIds.push(uid);
            });
        } else if (quote?.uidFrom || quote?.ownerId) {
            // Chỉ lấy quote khi không có mention
            targetIds.push(String(quote.uidFrom || quote.ownerId));
        }
        idArgs.forEach(id => { if (!targetIds.includes(id)) targetIds.push(id); });

        if (targetIds.length === 0) {
            let help = `[ 🔑 HƯỚNG DẪN SETKEY ]\n`;
            help += `─────────────────\n`;
            help += `◈ Cú pháp: ${prefix}setkey [@tag / reply] [loại key]\n\n`;
            help += `⭐ Các loại key:\n`;
            help += ` ❯ vàng (v/gold): Quyền tối cao, thay đổi chủ nhóm.\n`;
            help += ` ❯ bạc (b/silver): Quyền quản lý, kick thành viên.\n`;
            help += ` ❯ xóa (del/remove): Gỡ bỏ toàn bộ quyền hạn.\n`;
            help += `─────────────────\n`;
            help += `💡 Ví dụ: !setkey @tag vàng\n`;
            help += `💡 Mặc định nếu không nhập loại là cấp Key Bạc.`;
            return reply(ctx, help);
        }

        if (!resolvedRole) resolvedRole = "Bạc";

        // Key Vàng không phải Bot Admin không được cấp Key Vàng
        if ((resolvedRole === "Owner" || resolvedRole === "Vàng") && !isBotAdmin) {
            return reply(ctx, "⚠️ Chỉ Admin Bot mới có quyền cấp Key Vàng / Trưởng nhóm!");
        }

        try {
            const targetNames = await Promise.all(targetIds.map(id => getTargetName(api, threadId, id)));
            const nameStr = targetNames.map(n => `• ${n}`).join("\n");
            
            const isVang = resolvedRole === "Owner" || resolvedRole === "Vàng";
            const standardizedRole = isVang ? "Vàng" : resolvedRole;
            targetIds.forEach(tid => statsManager.setRole(threadId, tid, standardizedRole));

            try {
                if (isVang) {
                    log.info(`[SETKEY] Nhường Group Owner cho ${targetIds[0]}`);
                    await api.changeGroupOwner(threadId, targetIds[0]);
                    if (targetIds.length > 1) await api.addGroupAdmins(threadId, targetIds.slice(1));
                } else if (resolvedRole === "Bạc") {
                    log.info(`[SETKEY] Cấp Phó nhóm cho ${targetIds.join(", ")}`);
                    await api.addGroupAdmins(threadId, targetIds);
                } else {
                    log.info(`[SETKEY] Tước quyền ${targetIds.join(", ")}`);
                    await api.removeGroupAdmins(threadId, targetIds);
                }
                log.info(`[SETKEY] Gọi Zalo API thành công!`);
            } catch (e) {
                log.error(`[SETKEY] Lỗi Zalo API: ${e.message}`);
                if (isVang) await api.addGroupAdmins(threadId, targetIds).catch(() => {});
            }

            const isRemove = resolvedRole === "Thành viên";
            targetIds.forEach(uid => isRemove ? groupAdminManager.removeFromCache(threadId, uid) : groupAdminManager.addToCache(threadId, uid));

            const texts = {
                "Vàng":   { i: "👑", t: "KEY VÀNG - TRƯỞNG NHÓM", d: "Thăng chức thành công", n: `Trưởng nhóm Zalo đã được trao cho ${targetNames[0]}.` },
                "Bạc":    { i: "🥈", t: "KEY BẠC - PHÓ NHÓM", d: "Thăng chức thành công", n: "Đã được thăng chức Quản lý trên Zalo." },
                "Thành viên": { i: "🗑️", t: "TƯỚC QUYỀN HẠN", d: "Đã giáng chức", n: "Đã bị gỡ quyền Quản trị trên Zalo." }
            };
            
            const msg = `${texts[standardizedRole].i} [ ${texts[standardizedRole].t} ] ${texts[standardizedRole].i}\n━━━━━━━━━━━━━━━━━━\n✅ ${texts[standardizedRole].d}:\n${nameStr}\n━━━━━━━━━━━━━━━━━━\n📌 Trạng thái: ${texts[standardizedRole].n}`;
            return ctx.reply({ msg, hidden: true }, targetIds);

        } catch (e) { await reply(ctx, `⚠️ Lỗi: ${e.message}`); }
    },

    kickall: async (ctx) => {
        const { api, threadId, senderId, adminIds } = ctx;
        if (!ctx.isGroup) return reply(ctx, "⚠️ Lệnh này chỉ dùng trong nhóm!");
        const senderLevel = getLevel(senderId, threadId, adminIds);
        if (senderLevel < ROLES["Vàng"]) return reply(ctx, "⚠️ Chỉ Key Vàng mới có quyền dùng !kickall!");

        try {
            const res = await api.getGroupInfo(threadId);
            const info = res.gridInfoMap?.[threadId] || res[threadId];
            const members = info?.memVerList || [];
            await reply(ctx, `🚀 Đang dọn dẹp nhóm...`);
            let count = 0;
            for (const mem of members) {
                const uid = String(mem.uid || mem);
                if (uid === senderId) continue;
                if (getLevel(uid, threadId, adminIds) < senderLevel) {
                    try { await api.removeUserFromGroup(threadId, uid); count++; await new Promise(r => setTimeout(r, 600)); } catch { }
                }
            }
            await reply(ctx, `✅ Đã tiễn ${count} thành viên lên đường.`);
        } catch (e) { await reply(ctx, `⚠️ Lỗi: ${e.message}`); }
    }
};
