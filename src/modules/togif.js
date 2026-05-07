import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { log } from "../logger.js";
import ffmpegPkg from "ffmpeg-static";

const ffmpegPath = (typeof ffmpegPkg === "object" && ffmpegPkg.path) ? ffmpegPkg.path : ffmpegPkg;
const CACHE_DIR = path.join(process.cwd(), "src/modules/cache");

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

export const name = "togif";
export const description = "Biến đổi ảnh thành GIF với các hiệu ứng (spin, zoom, shake)";

export const commands = {
    togif: async (ctx) => {
        const { api, threadId, threadType, message, args, prefix } = ctx;
        
        let imageUrl = "";
        
        // Lấy URL ảnh từ reply hoặc bản thân tin nhắn
        const quote = message.data.quote || message.data.content?.quote;
        if (quote && quote.attach) {
            try {
                const attach = typeof quote.attach === "string" ? JSON.parse(quote.attach) : quote.attach;
                imageUrl = (attach.href || attach.originalUrl || "").replace(/\/jxl\//g, '/jpg/').replace(/\.jxl/g, '.jpg');
            } catch (e) {
                log.error("Parse quote attach error:", e.message);
            }
        }

        if (!imageUrl && message.data.attach) {
            try {
                const attach = typeof message.data.attach === "string" ? JSON.parse(message.data.attach) : message.data.attach;
                imageUrl = (attach.href || attach.originalUrl || "").replace(/\/jxl\//g, '/jpg/').replace(/\.jxl/g, '.jpg');
            } catch (e) {
                log.error("Parse message attach error:", e.message);
            }
        }

        if (!imageUrl) {
            let guide = `[ 🎞️ IMAGE TO GIF ]\n`;
            guide += `─────────────────\n`;
            guide += `💡 Cách dùng: Reply hoặc gửi kèm 1 ảnh với lệnh:\n`;
            guide += `👉 ${prefix}togif <hiệu ứng>\n\n`;
            guide += `✨ Các hiệu ứng:\n`;
            guide += `• spin: Xoay tròn đĩa nhạc\n`;
            guide += `• zoom: Thu phóng mượt mà\n`;
            guide += `• shake: Rung lắc mạnh\n`;
            guide += `• bounce: Nảy lên nảy xuống\n`;
            guide += `─────────────────`;
            return api.sendMessage({ msg: guide }, threadId, threadType);
        }

        const effect = args[0]?.toLowerCase() || "spin";
        const tempIn = path.join(CACHE_DIR, `togif_in_${Date.now()}_${Math.random().toString(36).substring(7)}.png`);
        const tempOut = path.join(CACHE_DIR, `togif_out_${Date.now()}.gif`);

        try {
            await api.sendMessage({ msg: `⏳ Hệ thống đang xử lý hiệu ứng "${effect}"...` }, threadId, threadType);

            // Tải ảnh về
            const response = await axios({
                url: imageUrl,
                method: "GET",
                responseType: "arraybuffer",
                timeout: 30000
            });
            fs.writeFileSync(tempIn, Buffer.from(response.data));

            let filter = "";
            let duration = 3;
            let fps = 15;

            switch (effect) {
                case "spin":
                    filter = `scale=400:400:force_original_aspect_ratio=decrease,pad=400:400:(ow-iw)/2:(oh-ih)/2:color=black@0,rotate=2*PI*t/3:c=none`;
                    break;
                case "zoom":
                    filter = `scale=800:800,zoompan=z='if(lte(mod(it,2),1),zoom+0.005,zoom-0.005)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=400x400`;
                    duration = 4;
                    break;
                case "shake":
                    filter = `scale=400:400:force_original_aspect_ratio=decrease,pad=450:450:(ow-iw)/2:(oh-ih)/2:color=black@0,crop=400:400:'(450-400)/2+15*sin(2*PI*t*8)':'(450-400)/2+15*cos(2*PI*t*10)'`;
                    break;
                case "bounce":
                    filter = `scale=400:400:force_original_aspect_ratio=decrease,pad=400:500:(ow-iw)/2:(oh-ih)/2:color=black@0,crop=400:400:'(400-400)/2':'(500-400)/2+40*abs(sin(2*PI*t*1.5))'`;
                    break;
                default:
                    filter = `scale=400:400:force_original_aspect_ratio=decrease,pad=400:400:(ow-iw)/2:(oh-ih)/2:color=black@0,rotate=2*PI*t/3:c=none`;
            }

            // Dùng split + palettegen + paletteuse để tạo GIF chất lượng tốt nhất, dung lượng nhẹ
            // Output GIF để Zalo nhận diện là 'image' và gửi ngay không cần chờ WebSocket
            const filterWithPalette = `[0:v]${filter},fps=${fps},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`;

            const cmd = `"${ffmpegPath}" -y -loop 1 -i "${tempIn}" -vf "${filterWithPalette}" -t ${duration} "${tempOut}"`;

            await new Promise((resolve, reject) => {
                exec(cmd, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            if (fs.existsSync(tempOut)) {
                await api.sendMessage({
                    msg: `✅ Hiệu ứng: ${effect}`,
                    attachments: [tempOut]
                }, threadId, threadType);
            } else {
                throw new Error("Không tạo được file đầu ra.");
            }

        } catch (e) {
            log.error("TOGIF Error:", e.message);
            api.sendMessage({ msg: `⚠️ Đã xảy ra lỗi: ${e.message}` }, threadId, threadType);
        } finally {
            if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn);
            if (fs.existsSync(tempOut)) setTimeout(() => { if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut); }, 15000);
        }
    }
};
