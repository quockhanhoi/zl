import fs from "node:fs";
import path from "node:path";
import moment from "moment-timezone";
import axios from "axios";
import { log } from "../logger.js";
import { rentalManager } from "../utils/rentalManager.js";
import { threadSettingsManager } from "../utils/threadSettingsManager.js";
import { statsManager } from "../utils/statsManager.js";
import { tempDir } from "../utils/io-json.js";
import { searchNCT } from "../utils/nhaccuatui.js";
import { autoSendHotMusic } from "./hotMusic.js";

const HISTORY_PATH = path.join(process.cwd(), "src/modules/cache/autosend_history.json");
const CUSTOM_MSG_PATH = path.join(process.cwd(), "src/modules/cache/autosend_custom.json");

const MEDIA_PATHS = {
    video_gai: path.join(process.cwd(), "src/modules/cache/vdgai.json"),
    anime: path.join(process.cwd(), "src/modules/cache/vdanime.json"),
    anh_gai: path.join(process.cwd(), "src/modules/cache/gai.json")
};

const sysBrand = "[ 🔔 SYSTEM NOTIFICATION ] : ";

// --- THIẾT LẬP THÔNG BÁO THEO GIỜ ---
const notificationSetting = {
    "6": ['Chúc mọi người buổi sáng vui vẻ😉', 'Buổi sáng đầy năng lượng nhaa các bạn😙', 'Dậy đi học và đi làm nào mọi người ơi😁'],
    "8": ['Dậy đê ngủ như heo😒', 'Tính nướng tới bao giờ đây😠', 'Dậy sớm thành công rước lộc vào nhà nào mọi người!💪'],
    "11": ['Chúc mọi người buổi trưa vui vẻ😋', 'Cả sáng mệt mỏi rùi nghỉ ngơi nạp năng lượng nào!!😴', 'Đến giờ ăn trưa rồi nè🍱'],
    "13": ['Chúc mọi người buổi chiều vui vẻ🙌', 'Chúc mọi người buổi chiều đầy năng lượng😼'],
    "17": ['Hết giờ làm rồi về nhà thôi mọi người 😎', 'Chiều rồi, xả stress thôi nào 🎉'],
    "19": ['Tối rồi, nghỉ ngơi đi mọi người 🥱', 'Chào buổi tối tốt lành nhé cả nhà! 🌙'],
    "22": ['Khuya ròi ngủ đuy😴', 'Tới giờ lên giường ngủ rùi😇'],
    "23": ['Chúc mọi người ngủ ngon😴', 'Tắt điện thoại và đi ngủ thôi 📴🛌'],
    "0": ['Bot ngủ đây tạm biệt mọi người😘', 'Chúc ai còn thức một đêm an yên nhé🌙']
};

function loadJson(p, def = []) { try { if (!fs.existsSync(p)) return def; return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return def; } }
function saveJson(p, data) { try { fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8"); } catch { } }

async function getMediaUrl(type) {
    try {
        if (type === "hotmusic" || type === "nct") return "music";
        const filePath = MEDIA_PATHS[type] || MEDIA_PATHS.video_gai;
        if (!fs.existsSync(filePath)) return null;
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        const list = Array.isArray(data) ? data : (data.urls || data.data || []);
        if (list.length === 0) return null;
        
        const history = loadJson(HISTORY_PATH);
        const filtered = list.filter(url => !history.includes(url));
        const targetList = filtered.length > 0 ? filtered : list;
        if (filtered.length === 0) saveJson(HISTORY_PATH, []);
        
        const selected = targetList[Math.floor(Math.random() * targetList.length)];
        const finalUrl = typeof selected === 'string' ? selected : (selected.url || selected.urls?.[0]);
        
        if (filtered.length > 0) { 
            history.push(finalUrl); 
            if (history.length > 500) history.shift(); 
            saveJson(HISTORY_PATH, history); 
        }
        return finalUrl;
    } catch (e) { return null; }
}

// --- TICKER CHÍNH (Đã tối ưu chạy 1 dạng duy nhất) ---
export async function startAutosendTicker(api) {
    let lastHourProcessed = -1;

    setInterval(async () => {
        const nowMoment = moment().tz("Asia/Ho_Chi_Minh");
        const hour = nowMoment.hour();
        const minute = nowMoment.minute();
        const second = nowMoment.second();

        // Chỉ chạy duy nhất khi sang giây đầu tiên của giờ mới
        if (hour !== lastHourProcessed && minute === 0 && second === 0) {
            lastHourProcessed = hour;
            log.info(`[Autosend] Kích hoạt tiến trình giờ mới: ${hour}:00`);
            
            const threads = statsManager.getAllThreads();
            const typesInUse = new Set();
            
            // Tìm tất cả các loại media đang được dùng trong các nhóm
            for (const tid of threads) {
                const config = threadSettingsManager.get(tid, "autosend", { enabled: false, type: "video_gai" });
                if (config.enabled && rentalManager.isRented(tid)) {
                    typesInUse.add(config.type);
                }
            }

            // Tải trước các media cần dùng để gửi nhanh cho tất cả các nhóm (Tiết kiệm băng thông)
            const mediaCaches = {};
            for (const type of typesInUse) {
                if (type === "hotmusic" || type === "nct") continue;
                const url = await getMediaUrl(type);
                if (url) {
                    try {
                        const ext = type === "anh_gai" ? "jpg" : "mp4";
                        const tempFile = path.join(tempDir, `auto_${type}_${Date.now()}.${ext}`);
                        const res = await axios({ method: 'get', url, responseType: 'stream', timeout: 45000 });
                        const writer = fs.createWriteStream(tempFile);
                        res.data.pipe(writer);
                        await new Promise((resolve, reject) => {
                            writer.on('finish', resolve);
                            writer.on('error', reject);
                        });
                        if (fs.existsSync(tempFile)) mediaCaches[type] = tempFile;
                    } catch (e) { log.error(`[Autosend] Tải media ${type} thất bại:`, e.message); }
                }
            }

            // Gửi tin nhắn cho từng nhóm
            for (const tid of threads) {
                const config = threadSettingsManager.get(tid, "autosend", { enabled: false, type: "video_gai" });
                if (!config.enabled || !rentalManager.isRented(tid)) continue;

                // Lấy nội dung thông báo
                const customMsgs = loadJson(CUSTOM_MSG_PATH, {});
                const hStr = hour.toString();
                let content = "";
                
                if (customMsgs[hStr + "h"]) {
                    content = customMsgs[hStr + "h"];
                } else if (notificationSetting[hStr]) {
                    const list = notificationSetting[hStr];
                    content = list[Math.floor(Math.random() * list.length)];
                } else {
                    content = `Chúc nhóm mình một giờ mới tốt lành và tràn đầy năng lượng! 🚀`;
                }

                const msgCaption = `[ 🔔 SYSTEM NOTIFICATION ]\n─────────────────\n💎 Bây giờ là: ${hour}:00\n✨ ${content}\n─────────────────`;

                // Xử lý gửi theo loại
                try {
                    if (config.type === "hotmusic") {
                        await api.sendMessage({ msg: msgCaption + "\n🔥 Đang chọn bài hát Hot nhất gửi các bạn..." }, tid, 1);
                        await autoSendHotMusic(api, log);
                    } else if (config.type === "nct") {
                        // Nhạc NCT lấy link trực tiếp nên không cần tải trước
                        const song = await searchNCT("top nhạc trẻ");
                        if (song && song[0]) {
                            const target = song[Math.floor(Math.random() * song.length)];
                            const stream = target.streamURL?.find(s => s.type === "320") || target.streamURL?.[0];
                            if (stream?.stream) {
                                await api.sendMessage({ msg: msgCaption + `\n🎼 Gợi ý nhạc: ${target.name}` }, tid, 1);
                                await api.sendVoiceNative({ voiceUrl: stream.stream, duration: target.duration || 0, threadId: tid, threadType: 1 });
                            }
                        }
                    } else {
                        const localPath = mediaCaches[config.type];
                        if (localPath && fs.existsSync(localPath)) {
                            if (config.type !== "anh_gai") {
                                // Gửi Video (Bỏ FFmpeg chèn chữ để tránh lỗi Windows)
                                await api.sendVideoUnified({ videoPath: localPath, msg: msgCaption, threadId: tid, threadType: 1 });
                            } else {
                                // Gửi Ảnh
                                await api.sendMessage({ msg: msgCaption, attachments: [localPath] }, tid, 1);
                            }
                        } else {
                            // Link fail thì gửi text chống cháy
                            await api.sendMessage({ msg: msgCaption }, tid, 1);
                        }
                    }
                } catch (err) {
                    log.error(`[Autosend] Lỗi gửi tin cho ${tid}:`, err.message);
                }
            }

            // Dọn dẹp cache sau khi gửi xong
            setTimeout(() => {
                for (const p of Object.values(mediaCaches)) {
                    if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch(e){}
                }
            }, 30000);
        }
    }, 1000); 
}

export const commands = {
    autosend: async (ctx) => {
        const { api, threadId, threadType, args, senderId, adminIds } = ctx;
        if (!adminIds.includes(String(senderId))) return;
        const action = args[0]?.toLowerCase();
        let config = threadSettingsManager.get(threadId, "autosend", { enabled: false, type: "video_gai" });
        
        if (action === "on") {
            config.enabled = true; threadSettingsManager.set(threadId, "autosend", config);
            const res = await api.sendMessage({ msg: `${sysBrand}✅ Đã BẬT Autosend! Mỗi giờ bot sẽ gửi Media 1 lần duy nhất.` }, threadId, threadType);
            setTimeout(() => { if (res && res.data) api.undoMessage(res.data, threadId, threadType).catch(() => {}); }, 5000);
            return;
        } else if (action === "off") {
            config.enabled = false; threadSettingsManager.set(threadId, "autosend", config);
            const res = await api.sendMessage({ msg: `${sysBrand}🚨 Đã TẮT Autosend.` }, threadId, threadType);
            setTimeout(() => { if (res && res.data) api.undoMessage(res.data, threadId, threadType).catch(() => {}); }, 5000);
            return;
        } else if (action === "set") {
            if (args.length < 3) return api.sendMessage({ msg: `${sysBrand}⚠️ Dùng: !autosend set <Giờ: 6/8/11/13/17/19/22/23/0> <Nội dung>` }, threadId, threadType);
            const rawHour = args[1].replace('h', '');
            const content = args.slice(2).join(" ");
            const customMsgs = loadJson(CUSTOM_MSG_PATH, {});
            customMsgs[rawHour + "h"] = content;
            saveJson(CUSTOM_MSG_PATH, customMsgs);
            const res = await api.sendMessage({ msg: `${sysBrand}✅ Đã lưu lời chúc cho lúc ${rawHour}:00!` }, threadId, threadType);
            setTimeout(() => { if (res && res.data) api.undoMessage(res.data, threadId, threadType).catch(() => {}); }, 5000);
            return;
        } else if (["video", "anime", "anh", "nct", "hotmusic"].includes(action)) {
            const typeMap = { "video": "video_gai", "anime": "anime", "anh": "anh_gai", "nct": "nct", "hotmusic": "hotmusic" };
            config.enabled = true; config.type = typeMap[action]; threadSettingsManager.set(threadId, "autosend", config);
            const res = await api.sendMessage({ msg: `${sysBrand}🎯 Đã đổi loại Media: ${action.toUpperCase()}!` }, threadId, threadType);
            setTimeout(() => { if (res && res.data) api.undoMessage(res.data, threadId, threadType).catch(() => {}); }, 5000);
            return;
        } else {
            const status = config.enabled ? "ĐANG BẬT ✅" : "ĐANG TẮT ⚠️";
            let msg = `${sysBrand}[ ⚙️ CÀI ĐẶT AUTOSEND ]\n─────────────────\n💡 !autosend on/off | video | anime | anh | nct | hotmusic\n💡 !autosend set <giờ> <nội dung>\n─────────────────\n📊 Trạng thái: ${status}\n🎁 Loại: ${config.type}\n🕒 Schedule: Mỗi khi sang giờ mới.`;
            return api.sendMessage({ msg }, threadId, threadType);
        }
    }
};
