import axios from "axios";
import path from "node:path";
import fs from "node:fs";
import { exec } from "node:child_process";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPkg from "ffmpeg-static";
const ffmpegPath = (typeof ffmpegPkg === "object" && ffmpegPkg.path) ? ffmpegPkg.path : ffmpegPkg;
import ffprobePath from "ffprobe-static";
import { pipeline } from "node:stream/promises";
import { log } from "../logger.js";

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath.path || ffprobePath);

const tempDir = path.resolve(process.cwd(), "Downloads", "zl");
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });


export async function getFileSize(filePath) {
    try { return fs.statSync(filePath).size; } catch { return 0; }
}

export async function uploadAudioFile(filePath, api, threadId, threadType) {
    let aacPath = null;
    try {
        const fileSize = await getFileSize(filePath);
        const ext = path.extname(filePath).toLowerCase();
        let finalPath = filePath;

        // Zalo uploadAttachment already supports uploading non-AAC to AAC by modifying endpoint
        // finalPath is already set to filePath

        const results = await api.uploadAttachment([finalPath], threadId, threadType);
        if (!results || results.length === 0) throw new Error("Upload Zalo thất bại.");

        const voiceUrl = results[0].fileUrl || results[0].url;

        const metadata = await new Promise((resolve) => {
            ffmpeg.ffprobe(finalPath, (err, meta) => {
                if (err) resolve({ format: { duration: 0 } });
                else resolve(meta);
            });
        });
        const duration = Math.round((metadata.format?.duration || 0) * 1000);

        return {
            voiceUrl,
            fileSize: await getFileSize(finalPath),
            duration,
            filePath: finalPath
        };
    } catch (error) {
        log.error("Lỗi upload Audio:", error.message);
        throw error;
    } finally {
        if (aacPath && fs.existsSync(aacPath)) fs.unlinkSync(aacPath);
    }
}

export async function extractAudioFromVideo(input, api, threadId, threadType) {
    const vPath = path.join(tempDir, `v_${Date.now()}.mp4`);
    const aPath = path.join(tempDir, `a_${Date.now()}.aac`);

    try {
        if (typeof input === 'string' && input.startsWith('http')) {
            const res = await axios({ url: input, method: 'GET', responseType: 'stream' });
            await pipeline(res.data, fs.createWriteStream(vPath));
        } else if (Buffer.isBuffer(input)) {
            fs.writeFileSync(vPath, input);
        } else {
            fs.copyFileSync(input, vPath);
        }

        await new Promise((resolve, reject) => {
            ffmpeg(vPath).vn().audioCodec('aac').audioBitrate('128k')
                .on('end', resolve).on('error', reject).save(aPath);
        });

        return await uploadAudioFile(aPath, api, threadId, threadType);
    } finally {
        [vPath, aPath].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    }
}

export async function createSpinningSticker(imageUrl, outputPath) {
    try {
        const { createCanvas, loadImage } = await import("canvas");
        const { spawn } = await import("child_process");

        const bg_image = await loadImage(imageUrl);

        // --- Parameters (match Python scale=2 supersampling) ---
        const base_size = 512;
        const scale = 2;
        const work_size = base_size * scale; // 1024

        const square_size = 340 * scale;   // 680
        const square_x = 20 * scale;       // 40
        const square_y = (work_size - square_size) / 2; // 172
        const square_radius = 40 * scale;  // 80
        const border_width = 8 * scale;    // 16

        const R_outer = 147 * scale;       // 294
        const R_black = R_outer - border_width; // 278
        const R_inner = 73 * scale;        // 146

        const cx = square_x + square_size; // 720
        const cy = square_y + square_size / 2; // 172 + 340 = 512

        const randCh = () => Math.random() * 255 | 0;
        const [cr, cg, cb] = [randCh(), randCh(), randCh()];
        const [dr, dg, db] = [randCh(), randCh(), randCh()];
        const color_square_border = `rgb(${cr},${cg},${cb})`;
        const color_disc_border = `rgb(${dr},${dg},${db})`;

        // --- Crop bg to square (same as Python) ---
        const bw = bg_image.width, bh = bg_image.height;
        const min_dim = Math.min(bw, bh);
        const crop_sx = (bw - min_dim) / 2;
        const crop_sy = (bh - min_dim) / 2;

        // Helper: draw cropped square bg scaled to target size
        function drawBgSquare(canvas, dx, dy, dw, dh, clipFn) {
            const ctx = canvas.getContext("2d");
            ctx.save();
            if (clipFn) clipFn(ctx);
            ctx.drawImage(bg_image, crop_sx, crop_sy, min_dim, min_dim, dx, dy, dw, dh);
            ctx.restore();
        }

        // --- Pre-render disc_base (static, built once) ---
        const disc_size = 2 * R_outer;
        const discCanvas = createCanvas(disc_size, disc_size);
        const dctx = discCanvas.getContext("2d");
        // Outer border circle
        dctx.beginPath();
        dctx.arc(R_outer, R_outer, R_outer, 0, Math.PI * 2);
        dctx.fillStyle = color_disc_border;
        dctx.fill();
        // Black ring (inner)
        const black_size = 2 * R_black;
        const offset_black = (disc_size - black_size) / 2;
        dctx.beginPath();
        dctx.arc(R_outer, R_outer, R_black, 0, Math.PI * 2);
        dctx.fillStyle = "black";
        dctx.fill();

        // --- Pre-render rounded square cover (static) ---
        const sqCanvas = createCanvas(square_size, square_size);
        const sqCtx = sqCanvas.getContext("2d");
        sqCtx.beginPath();
        sqCtx.roundRect(0, 0, square_size, square_size, square_radius);
        sqCtx.clip();
        sqCtx.drawImage(bg_image, crop_sx, crop_sy, min_dim, min_dim, 0, 0, square_size, square_size);

        // --- Pre-render core image (will be rotated per-frame) ---
        const core_size = 2 * R_inner;
        const coreCanvas = createCanvas(core_size, core_size);
        const coreCtx = coreCanvas.getContext("2d");
        coreCtx.drawImage(bg_image, crop_sx, crop_sy, min_dim, min_dim, 0, 0, core_size, core_size);

        // --- Frame rendering ---
        const duration = 8;
        const fps = 30;
        const num_frames = duration * fps;

        const ffmpegProcess = spawn(ffmpegPath, [
            '-y',
            '-f', 'rawvideo',
            '-vcodec', 'rawvideo',
            '-s', `${work_size}x${work_size}`,
            '-pix_fmt', 'bgra',  // canvas.toBuffer('raw') outputs BGRA on Windows
            '-r', `${fps}`,
            '-i', '-',
            '-vf', `scale=${base_size}:${base_size}:flags=lanczos`,
            '-vcodec', 'libwebp',
            '-lossless', '0',
            '-q:v', '85',
            '-loop', '0',
            outputPath
        ]);

        // Prevent unhandled error crash when ffmpeg exits early
        ffmpegProcess.stdin.on('error', () => { });
        ffmpegProcess.stderr.on('data', () => { });

        const frameCanvas = createCanvas(work_size, work_size);
        const fctx = frameCanvas.getContext("2d");

        for (let i = 0; i < num_frames; i++) {
            fctx.clearRect(0, 0, work_size, work_size);

            // 1. Draw disc_base at (cx - R_outer, cy - R_outer)
            fctx.drawImage(discCanvas, cx - R_outer, cy - R_outer);

            // 2. Rotate core and composite with circular mask at disc center
            const angle = (i / num_frames) * Math.PI * 2;
            fctx.save();
            fctx.translate(cx, cy);
            fctx.rotate(angle);
            fctx.beginPath();
            fctx.arc(0, 0, R_inner, 0, Math.PI * 2);
            fctx.clip();
            fctx.drawImage(coreCanvas, -R_inner, -R_inner, core_size, core_size);
            fctx.restore();

            // 3. Draw rounded square cover on top
            fctx.drawImage(sqCanvas, square_x, square_y);

            // Write raw RGBA frame buffer to ffmpeg
            ffmpegProcess.stdin.write(frameCanvas.toBuffer('raw'));
        }

        ffmpegProcess.stdin.end();

        await new Promise((resolve, reject) => {
            ffmpegProcess.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`FFmpeg exited with code ${code}`));
            });
        });

        return true;
    } catch (e) {
        log.error("Lỗi tạo sticker đĩa nhạc quay:", e.message);
        return false;
    }
}


export async function downloadHLS(url, outputPath, headers = {}) {
    return new Promise((resolve, reject) => {
        // Tự động đổi đuôi file sang .m4a nếu đang là .mp3 để dùng mode copy cực nhanh
        const finalPath = outputPath.replace(/\.mp3$/, '.m4a');
        let command = ffmpeg(url).audioCodec('copy');

        if (Object.keys(headers).length > 0) {
            const headerStr = Object.entries(headers)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\r\n');
            command.inputOptions(['-headers', headerStr]);
        }

        command
            .on('start', () => log.info(`[FFmpeg] Đang nối luồng HLS (Chế độ Copy Siêu tốc)...`))
            .on('end', () => {
                log.success(`[FFmpeg] Hoàn tất: ${path.basename(finalPath)}`);
                resolve(finalPath);
            })
            .on('error', (err) => {
                log.error(`[FFmpeg] Lỗi: ${err.message}`);
                reject(err);
            })
            .save(finalPath);
    });
}

export default { getFileSize, uploadAudioFile, extractAudioFromVideo, createSpinningSticker, downloadHLS };