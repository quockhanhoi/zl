import { ffApi } from "../utils/ff.js";
import { drawFFCard } from "../utils/canvasHelper.js";
import { uploadToTmpFiles } from "../utils/tmpFiles.js";
import fs from "node:fs";
import path from "node:path";
import { log } from "../logger.js";

export const name = "ff";
export const description = "Tra cứu thông tin và chỉ số người chơi Free Fire (Đa server, pure JS)";

// ── Rank table ──────────────────────────────────────────────────
const BR_RANKS = [
    { name: "🥉 Đồng",         min: 0    },
    { name: "🥈 Bạc",          min: 1000 },
    { name: "🥇 Vàng",         min: 2000 },
    { name: "💎 Bạch Kim",      min: 3000 },
    { name: "💠 Kim Cương",     min: 4000 },
    { name: "🔴 Heroic",        min: 5500 },
    { name: "🏅 Grand Master",  min: 6000 },
];
const CS_RANKS = [
    { name: "🥉 Đồng",     min: 0    },
    { name: "🥈 Bạc",      min: 1000 },
    { name: "🥇 Vàng",     min: 2000 },
    { name: "💎 Bạch Kim",  min: 3000 },
    { name: "💠 Kim Cương", min: 4000 },
    { name: "🔴 Heroic",    min: 5500 },
];

function getRank(pts, table) {
    pts = Number(pts) || 0;
    for (let i = table.length - 1; i >= 0; i--) {
        if (pts >= table[i].min) return `${table[i].name} (${pts}đ)`;
    }
    return 'Chưa có rank';
}

function fmt(n) { return (Number(n) || 0).toLocaleString('vi-VN'); }
function pct(a, b) { return b > 0 ? ((a / b) * 100).toFixed(1) + '%' : 'N/A'; }

const SERVERS = ['VN','IND','SG','ID','TH','US','BR','RU','PK','BD','ME','CIS','TW'];

// ────────────────────────────────────────────────────────────────
export const commands = {
    ff: async (ctx) => {
        const { api, message, args, threadId, threadType, prefix } = ctx;
        const sub = args[0]?.toLowerCase();

        // ── Help ──
        if (!sub || !['info','rank','stats','search'].includes(sub)) {
            let g = ` [ 🔫 FREE FIRE TOOLS ] \n─────────────────────\n`;
            g += `1️⃣  ${prefix}ff info [ID] [Server]\n     ↳ Hồ sơ người chơi\n\n`;
            g += `2️⃣  ${prefix}ff rank [ID] [Server]\n     ↳ BR & CS rank hiện tại\n\n`;
            g += `3️⃣  ${prefix}ff stats [ID] [Server] [br|cs]\n     ↳ Thống kê chi tiết\n\n`;
            g += `4️⃣  ${prefix}ff search [Tên] [Server]\n     ↳ Tìm người chơi theo tên\n`;
            g += `─────────────────────\n`;
            g += `🌐 Server: ${SERVERS.slice(0,5).join(' · ')}...\n`;
            g += `💡 VD: ${prefix}ff info 11959685790 vn`;
            return api.sendMessage({ msg: g }, threadId, threadType);
        }

        const target = args[1];
        if (!target) {
            const hint = sub === 'search'
                ? `⚠️ Nhập tên cần tìm!\n💡 ${prefix}ff search Garena vn`
                : `⚠️ Nhập ID người chơi!\n💡 ${prefix}ff ${sub} 11959685790 vn`;
            return api.sendMessage({ msg: hint }, threadId, threadType);
        }

        const server = (args[2] || 'VN').toUpperCase();
        if (!SERVERS.includes(server)) {
            return api.sendMessage({
                msg: `⚠️ Server "${server}" không hợp lệ!\n🌐 Hỗ trợ: ${SERVERS.join(' · ')}`
            }, threadId, threadType);
        }

        const wait = await api.sendMessage({ msg: `⏳ Đang kết nối server ${server}...` }, threadId, threadType);
        const del = () => api.deleteMessage(wait.messageId, threadId).catch(() => {});

        try {
            // ════════════════ INFO ════════════════
            if (sub === 'info') {
                const data = await ffApi.getProfile(target, server);
                if (data?.status === 'error' || data?.error) throw new Error(data?.error || data?.message);

                // keepCase=true → proto field names (lowercase in AccountInfoBasic)
                const basic  = data?.basicinfo  || {};
                const clan   = data?.clanbasicinfo;
                const social = data?.socialinfo || data?.social_basic_info || {};
                const pet    = data?.petinfo;

                const uid  = basic.accountid || target;
                const nick = basic.nickname  || 'N/A';
                const lv   = basic.level     || 0;
                const exp  = basic.exp       || 0;
                const reg  = basic.region    || server;

                let msg = ` [ 👤 FF PROFILE ] \n─────────────────────\n`;
                msg += `👤 ${nick}\n`;
                msg += `🆔 ID: ${uid}\n`;
                msg += `🌎 Server: ${reg}\n`;
                msg += `🆙 Lv.${fmt(lv)} (${fmt(exp)} EXP)\n`;
                msg += `❤️ Lượt thích: ${fmt(basic.liked)}\n`;

                if (data.profileinfo?.avatarid) msg += `🖼️ Avatar ID: ${data.profileinfo.avatarid}\n`;
                if (social.gender)   msg += `🚻 Giới tính: ${social.gender}\n`;
                if (social.language) msg += `🌐 Ngôn ngữ: ${social.language}\n`;

                if (basic.createat)    msg += `📅 Tạo: ${new Date(Number(basic.createat) * 1000).toLocaleDateString('vi-VN')}\n`;
                if (basic.lastloginat) msg += `🕐 Login: ${new Date(Number(basic.lastloginat) * 1000).toLocaleDateString('vi-VN')}\n`;

                if (clan?.clanname) msg += `🛡️ Guild: ${clan.clanname} (Lv.${clan.clanlevel || 1})\n`;
                if (pet?.name)      msg += `🐾 Pet: ${pet.name} (Lv.${pet.level || 1})\n`;
                if (social.signature) msg += `✨ ${social.signature}\n`;

                if (data.creditscoreinfo?.creditscore) msg += `🛡️ Uy tín: ${data.creditscoreinfo.creditscore}\n`;
                if (data.diamondcostres?.diamondcost)  msg += `💎 Giá trị KC: ${fmt(data.diamondcostres.diamondcost)}\n`;

                const brPts = Number(basic.rankingpoints)   || 0;
                const csPts = Number(basic.csrankingpoints) || 0;
                if (brPts || csPts) {
                    msg += `─────────────────────\n`;
                    if (brPts) msg += `🎯 BR: ${getRank(brPts, BR_RANKS)}\n`;
                    if (csPts) msg += `⚔️ CS: ${getRank(csPts, CS_RANKS)}\n`;
                }
                msg += `─────────────────────`;
                
                // ── Canvas Generation ──
                try {
                    const buffer = await drawFFCard(data);
                    const cacheDir = path.join(process.cwd(), 'src/modules/cache');
                    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
                    const tempPath = path.join(cacheDir, `ff_${uid}_${Date.now()}.png`);
                    fs.writeFileSync(tempPath, buffer);

                    const remoteUrl = await uploadToTmpFiles(tempPath, api, threadId, threadType);
                    if (remoteUrl) {
                        await del();
                        return await api.sendImageEnhanced({
                            imageUrl: remoteUrl,
                            threadId, threadType,
                            width: 1200, height: 800,
                            msg: msg
                        });
                    }
                } catch (err) {
                    log.error("[ff] Canvas error:", err.message);
                }

                await del();
                return api.sendMessage({ msg }, threadId, threadType);

            // ════════════════ RANK ════════════════
            } else if (sub === 'rank') {
                const data = await ffApi.getProfile(target, server);
                if (data?.status === 'error' || data?.error) throw new Error(data?.error || data?.message);

                const basic = data?.basicinfo || {};
                const brPts    = Number(basic.rankingpoints)   || 0;
                const csPts    = Number(basic.csrankingpoints) || 0;
                const brMaxPts = Number(basic.maxrankingpoints) || 0;
                const csMaxPts = Number(basic.csmaxrank)        || 0;

                let msg = ` [ 🏆 FF RANK ] \n─────────────────────\n`;
                msg += `👤 ${basic.nickname || 'N/A'} | 🌎 ${basic.region || server}\n`;
                msg += `─────────────────────\n`;

                msg += `🎮 BATTLE ROYALE\n`;
                msg += `  Rank: ${getRank(brPts, BR_RANKS)}\n`;
                if (brMaxPts) msg += `  Đỉnh cao: ${getRank(brMaxPts, BR_RANKS)}\n`;

                msg += `─────────────────────\n`;
                msg += `⚔️ CLASH SQUAD\n`;
                msg += `  Rank: ${getRank(csPts, CS_RANKS)}\n`;
                if (csMaxPts) msg += `  Đỉnh cao: ${getRank(csMaxPts, CS_RANKS)}\n`;
                msg += `─────────────────────`;

                await del();
                return api.sendMessage({ msg }, threadId, threadType);

            // ════════════════ STATS ════════════════
            } else if (sub === 'stats') {
                const mode = args[3]?.toLowerCase() === 'cs' ? 'cs' : 'br';
                const res  = await ffApi.getStats(target, server, mode);
                if (!res?.success) throw new Error(res?.error || 'Lỗi lấy thống kê');

                let msg = ` [ 📊 FF STATS – ${mode.toUpperCase()} ] \n─────────────────────\n`;
                msg += `🆔 ${target} | 🌎 ${server}\n`;
                msg += `─────────────────────\n`;

                if (mode === 'br') {
                    // fields: quadstats (squad), duostats (duo), solostats (solo)
                    const modes = [
                        { label: '👥 Squad', data: res.data?.quadstats },
                        { label: '👫 Duo',   data: res.data?.duostats  },
                        { label: '🧍 Solo',  data: res.data?.solostats },
                    ].filter(m => m.data && Number(m.data.gamesplayed) > 0);

                    if (!modes.length) {
                        msg += '⚠️ Không có dữ liệu thống kê BR\n';
                    } else {
                        for (const { label, data: s } of modes) {
                            const g  = Number(s.gamesplayed) || 0;
                            const w  = Number(s.wins)  || 0;
                            const k  = Number(s.kills) || 0;
                            const hs = Number(s.detailedstats?.headshots || s.detailedstats?.headshot_kills) || 0;
                            const dmg= Number(s.detailedstats?.damage)   || 0;
                            msg += `${label}\n`;
                            msg += `  Trận: ${fmt(g)} | Thắng: ${fmt(w)} (${pct(w,g)})\n`;
                            msg += `  Kill: ${fmt(k)} | K/D: ${(k / Math.max(g-w,1)).toFixed(2)}\n`;
                            if (hs && k) msg += `  Headshot: ${pct(hs,k)}\n`;
                            if (dmg && g) msg += `  Damage/trận: ${fmt(Math.round(dmg/g))}\n`;
                        }
                    }
                } else {
                    // CS: csstats field
                    const s = res.data?.csstats;
                    if (!s || !Number(s.gamesplayed)) {
                        msg += '⚠️ Không có dữ liệu thống kê CS\n';
                    } else {
                        const g   = Number(s.gamesplayed) || 0;
                        const w   = Number(s.wins)  || 0;
                        const k   = Number(s.kills) || 0;
                        const d   = s.detailedstats;
                        const hs  = Number(d?.head_shot_kills || d?.headshot_count) || 0;
                        const dmg = Number(d?.damage) || 0;
                        const mvp = Number(d?.mvp_count) || 0;
                        msg += `⚔️ Clash Squad\n`;
                        msg += `  Trận: ${fmt(g)} | Thắng: ${fmt(w)} (${pct(w,g)})\n`;
                        msg += `  Kill: ${fmt(k)} | K/D: ${(k / Math.max(g-w,1)).toFixed(2)}\n`;
                        if (hs && k) msg += `  Headshot: ${pct(hs,k)}\n`;
                        if (dmg && g) msg += `  Damage/trận: ${fmt(Math.round(dmg/g))}\n`;
                        if (mvp)     msg += `  MVP: ${fmt(mvp)}\n`;
                    }
                }
                msg += `─────────────────────`;
                await del();
                return api.sendMessage({ msg }, threadId, threadType);

            // ════════════════ SEARCH ════════════════
            } else if (sub === 'search') {
                if (target.length < 3) {
                    await del();
                    return api.sendMessage({ msg: `⚠️ Tên cần ít nhất 3 ký tự!` }, threadId, threadType);
                }

                const res = await ffApi.searchPlayer(target, server);
                if (res?.error) throw new Error(res.error);

                // keepCase=true → field is "infos" (from proto)
                const list = res?.infos || [];
                let msg = ` [ 🔍 TÌM KIẾM FF ] \n─────────────────────\n`;
                msg += `🔑 "${target}" | 🌎 ${server}\n`;
                msg += `─────────────────────\n`;

                if (!list.length) {
                    msg += `⚠️ Không tìm thấy người chơi nào!`;
                } else {
                    list.slice(0, 10).forEach((acc, i) => {
                        // AccountInfoBasic fields (all lowercase in proto)
                        const id   = acc.accountid || '?';
                        const name = acc.nickname  || 'Unknown';
                        const lv   = acc.level     || 0;
                        msg += `${i + 1}. ${name}  🆙Lv.${lv}\n`;
                        msg += `   🆔 ${id}\n`;
                    });
                    msg += `─────────────────────\n`;
                    msg += `📌 ${prefix}ff info [ID] ${server.toLowerCase()}`;
                }

                await del();
                return api.sendMessage({ msg }, threadId, threadType);
            }

        } catch (e) {
            await del();
            let errMsg = e.message || 'Lỗi không xác định';
            // Dịch lỗi API phổ biến sang tiếng Việt
            if (errMsg.includes('ACCOUNT_NOT_FOUND') || errMsg.includes('4143434f554e545f4e4f545f464f554e44'))
                errMsg = 'Không tìm thấy ID này! Kiểm tra lại ID hoặc thử server khác.';
            else if (errMsg.includes('PLATFORM_INVALID'))
                errMsg = 'Server không hợp lệ. Thử server khác!';
            else if (errMsg.includes('timeout') || errMsg.includes('ECONNREFUSED'))
                errMsg = 'Server FF không phản hồi. Thử lại sau!';
            return api.sendMessage({ msg: `⚠️ ${errMsg}` }, threadId, threadType);
        }
    }
};
