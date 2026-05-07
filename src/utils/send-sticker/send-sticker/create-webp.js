// create-webp.js

import ffmpeg from 'fluent-ffmpeg';
import path from "path";
import { tempDir } from "../../io-json.js";
import { getVideoMetadata } from "../../../api-zalo/api-zalo/utils.js";
import { checkExstentionFileRemote, deleteFile, downloadFile, execAsync } from "../../util.js";
import fs from 'fs';
import sharp from 'sharp';
import { Worker } from 'worker_threads';
import os from 'os';
// import { trackStickerCreation } from "../../../../web-service/web-server.js"; // Removed
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const DEFAULT_MAX_STICKER_SIZE = 512;

function normalizeMaxSize(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
        throw new Error('max sticker size must be a positive number');
    }
    return Math.min(Math.floor(numericValue), 1024);
}

function buildWebpFilterChain(maxSize = DEFAULT_MAX_STICKER_SIZE) {
    const safeSize = normalizeMaxSize(maxSize);
    const scaleFilter = "scale='if(gt(iw,ih),min(" + safeSize + ",iw),-2)':'if(gt(iw,ih),-2,min(" + safeSize + ",ih))':force_original_aspect_ratio=decrease:flags=fast_bilinear";
    const padFilter = "pad=ceil(iw/2)*2:ceil(ih/2)*2:(ow-iw)/2:(oh-ih)/2:color=0x00000000";
    return `${scaleFilter},${padFilter}`;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function safeDeleteFile(filePath) {
    try {
        await fs.promises.unlink(filePath).catch(() => { });
        return true;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`⚠️ Không thể xóa file ${filePath}:`, error.message);
        }
        return false;
    }
}

async function convertJxlToPngIfNeeded(inputPath) {
    const ext = path.extname(inputPath).toLowerCase();
    if (ext !== '.jxl') {
        return inputPath;
    }

    const outputPath = inputPath.replace(/\.jxl$/i, '.png');

    try {
        await new Promise((resolve, reject) => {
            const ffmpegProcess = ffmpeg(inputPath)
                .outputOptions(['-pix_fmt rgba', '-f image2pipe'])
                .output(outputPath)
                .on('start', (cmd) => console.log('FFmpeg command:', cmd))
                .on('progress', (progress) => console.log('Đang xử lý:', progress.frames + ' frames'))
                .on('end', () => {
                    console.log('✅ Chuyển đổi JXL sang PNG thành công');
                    resolve();
                })
                .on('error', (err, stdout, stderr) => {
                    console.error('⚠️ Lỗi FFmpeg:', err);
                    console.error('FFmpeg stdout:', stdout);
                    console.error('FFmpeg stderr:', stderr);
                    reject(new Error(`Lỗi FFmpeg: ${err.message}`));
                });

            const process = ffmpegProcess.run();

            process.on('exit', (code) => {
                if (code !== 0) {
                    console.error(`FFmpeg process exited with code ${code}`);
                }
            });
        });

        await new Promise(resolve => setTimeout(resolve, 500));

        if (!await safeDeleteFile(inputPath)) {
            console.warn(`⚠️ Không thể xóa file gốc: ${inputPath}`);
        }

        return outputPath;
    } catch (error) {
        console.error('⚠️ Lỗi trong quá trình chuyển đổi JXL:', error);
        await safeDeleteFile(outputPath).catch(() => { });
        throw new Error('Không thể xử lý file JXL. Vui lòng thử lại với định dạng ảnh khác.');
    }
}

// =========================================================================
// HÀM MỚI - CHUYÊN DÙNG ĐỂ GHÉP FRAME BẰNG IMAGEMAGICK
// =========================================================================
/**
 * Ghép một chuỗi ảnh thành file WebP động bằng ImageMagick, chống bóng ma.
 * @param {string} inputPath Pattern của các frame đầu vào (vd: 'frames/frame-%04d.png')
 * @param {string} outputPath Đường dẫn file WebP đầu ra
 * @param {number} framerate Tốc độ của animation
 * @param {number} quality Chất lượng (0-100)
 */
async function assembleFramesWithImageMagick(inputPath, outputPath, framerate = 20, quality = 80) {
    // ImageMagick dùng "delay" giữa các frame, tính bằng 1/100 giây.
    const delay = Math.round(100 / framerate);

    // Tùy chọn "-dispose background" là CHÌA KHÓA VÀNG để chống bóng ma.
    // Nó yêu cầu xóa sạch frame cũ trước khi vẽ frame mới.
    const command = `magick -delay ${delay} -loop 0 -dispose background -quality ${quality} "${inputPath}" "${outputPath}"`;

    console.log(`[Ghép WebP] Dùng ImageMagick: ${command}`);
    try {
        await execAsync(command);
        return true;
    } catch (error) {
        console.error('Lỗi khi ghép frame bằng ImageMagick:', error);
        throw error;
    }
}
/**
 * SỬA LẠI HÀM NÀY
 * Sử dụng ffprobe để lấy metadata của video/animation (width, height, framerate)
 * @param {string} inputPath Đường dẫn đến file
 * @returns {Promise<{width: number, height: number, framerate: number}>}
 */
async function getAnimationMetadata(inputPath) {
    const ext = path.extname(inputPath).toLowerCase();

    // Ưu tiên dùng Sharp cho WebP vì nó đọc frame delay chính xác hơn
    if (ext === '.webp') {
        try {
            const sharpMeta = await sharp(inputPath, { animated: true }).metadata();
            // Kiểm tra xem có thông tin delay của các frame không
            if (sharpMeta.delay && sharpMeta.delay.length > 0) {
                // Tính toán delay trung bình (tính bằng mili-giây)
                const totalDelay = sharpMeta.delay.reduce((sum, d) => sum + d, 0);
                const avgDelay = totalDelay / sharpMeta.delay.length;

                if (avgDelay > 0) {
                    // Chuyển đổi từ delay (ms) sang framerate (fps)
                    // FPS = 1000 / delay_in_ms
                    let framerate = 1000 / avgDelay;
                    // Làm tròn và giới hạn trong khoảng an toàn (10-30 fps)
                    framerate = Math.round(Math.min(Math.max(framerate, 10), 30));

                    console.log(`[Metadata WebP] Framerate tính từ Sharp delays: ${framerate} fps`);
                    return {
                        width: sharpMeta.width,
                        height: sharpMeta.pageHeight || sharpMeta.height, // pageHeight cho file động
                        framerate: framerate
                    };
                }
            }
        } catch (e) {
            console.warn(`[Metadata WebP] Lỗi khi dùng Sharp, thử fallback sang ffprobe: ${e.message}`);
            // Nếu Sharp lỗi, chúng ta sẽ để nó chạy tiếp và dùng ffprobe bên dưới
        }
    }

    // Dùng FFprobe cho các định dạng khác hoặc khi Sharp lỗi với WebP
    console.log(`[Metadata] Dùng FFprobe cho file ${ext}`);
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            if (err) {
                return reject(new Error(`FFprobe không thể đọc file: ${err.message}`));
            }

            const stream = metadata.streams.find(s => s.codec_type === 'video');
            if (!stream) {
                return reject(new Error('Không tìm thấy video stream trong file.'));
            }

            let framerate = 20; // Framerate mặc định
            if (stream.avg_frame_rate && stream.avg_frame_rate !== '0/0') {
                const parts = stream.avg_frame_rate.split('/');
                framerate = parseFloat(parts[0]) / parseFloat(parts[1]);
            } else if (stream.r_frame_rate && stream.r_frame_rate !== '0/0') {
                const parts = stream.r_frame_rate.split('/');
                framerate = parseFloat(parts[0]) / parseFloat(parts[1]);
            }

            framerate = Math.round(Math.min(Math.max(framerate, 10), 30));

            resolve({
                width: stream.width,
                height: stream.height,
                framerate: framerate
            });
        });
    });
}

/**
 * ====================================================================
 * PHẦN CẬP NHẬT CHÍNH - BẮT ĐẦU
 * ====================================================================
 */

// create-webp.js

/**
 * Hàm chuyên xử lý bo góc cho file động (GIF, aWebP) - PHIÊN BẢN CẢI TIẾN
 * Sử dụng ImageMagick để "trải phẳng" frame và ffprobe để lấy framerate gốc.
 * @param {string} inputPath - Đường dẫn file GIF/WebP động đầu vào.
 * @param {string} outputPath - Đường dẫn file WebP đầu ra.
 * @param {number} radius - Bán kính bo góc.
 * @param {number} maxSize - Kích thước tối đa của sticker.
 */
/**
 * THAY THẾ TOÀN BỘ HÀM CŨ BẰNG HÀM NÀY (PHIÊN BẢN HOÀN CHỈNH)
 * Hàm chuyên xử lý bo góc cho file động (GIF, aWebP).
 * Quy trình vàng: ffprobe (lấy tốc độ) -> ImageMagick -coalesce (chống bóng ma) -> sharp (bo góc) -> ffmpeg (ghép file)
 * @param {string} inputPath - Đường dẫn file GIF/WebP động đầu vào.
 * @param {string} outputPath - Đường dẫn file WebP đầu ra.
 * @param {number} radius - Bán kính bo góc.
 * @param {number} maxSize - Kích thước tối đa của sticker.
 */
async function createAnimatedRoundedCornerWebp(inputPath, outputPath, radius = 50, maxSize = 512) {
    const tempFramesDir = path.join(tempDir, `frames_rounded_${Date.now()}`);
    const processedFramesDir = path.join(tempFramesDir, 'processed');

    try {
        await fs.promises.mkdir(processedFramesDir, { recursive: true });
        console.log(`[Bo góc động] Đã tạo thư mục tạm: ${tempFramesDir}`);

        // BƯỚC 1: Lấy framerate gốc
        const metadata = await getAnimationMetadata(inputPath);
        const originalFramerate = metadata.framerate;
        console.log(`[Bo góc động] Framerate gốc: ${originalFramerate} fps`);

        // BƯỚC 2: Dùng ImageMagick -coalesce để tách frame, chống bóng ma
        const framePattern = path.join(tempFramesDir, 'frame-%04d.png');
        const coalesceCommand = `magick "${inputPath}" -coalesce "${framePattern}"`;
        console.log(`[Bo góc động] Tách frame: ${coalesceCommand}`);
        await execAsync(coalesceCommand);

        console.log('[Bo góc động] Đã tách file thành các frame PNG hoàn chỉnh.');

        const frameFiles = await fs.promises.readdir(tempFramesDir);
        const pngFrames = frameFiles.filter(f => f.endsWith('.png'));

        if (pngFrames.length === 0) throw new Error('Không thể tách được frame nào.');

        // BƯỚC 3: Dùng Sharp để bo góc từng frame
        for (const frameFile of pngFrames) {
            const framePath = path.join(tempFramesDir, frameFile);
            const processedFramePath = path.join(processedFramesDir, frameFile);

            const frameMeta = await sharp(framePath).metadata();
            let newWidth, newHeight;
            if (frameMeta.width > frameMeta.height) {
                newWidth = maxSize;
                newHeight = Math.round((frameMeta.height / frameMeta.width) * maxSize);
            } else {
                newHeight = maxSize;
                newWidth = Math.round((frameMeta.width / frameMeta.height) * maxSize);
            }

            const roundedCorners = Buffer.from(`<svg><rect x="0" y="0" width="${newWidth}" height="${newHeight}" rx="${radius}" ry="${radius}"/></svg>`);

            await sharp(framePath)
                .resize(newWidth, newHeight, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .composite([{ input: roundedCorners, blend: 'dest-in' }])
                .toFile(processedFramePath);
        }
        console.log(`[Bo góc động] Đã xử lý bo góc cho ${pngFrames.length} frames.`);

        // BƯỚC 4: Dùng ImageMagick để ghép các frame thành WebP, chống bóng ma
        const processedFramePattern = path.join(processedFramesDir, 'frame-*.png');
        await assembleFramesWithImageMagick(processedFramePattern, outputPath, originalFramerate, 85); // Nâng chất lượng lên 85

        console.log(`[Bo góc động] Đã ghép các frame thành công -> ${outputPath}`);
        return outputPath;
    } catch (error) {
        console.error('Lỗi khi tạo sticker động bo góc:', error);
        throw error;
    } finally {
        await fs.promises.rm(tempFramesDir, { recursive: true, force: true }).catch(err => {
            console.warn(`Không thể xóa thư mục tạm ${tempFramesDir}:`, err.message);
        });
    }
}


/**
 * Tạo sticker với góc bo tròn, giữ nguyên tỷ lệ khung hình gốc.
 * Đã được cập nhật để tự động xử lý cả ảnh tĩnh và ảnh động (GIF).
 */
export async function createRoundedCornerWebp(api, message, imageUrl, idImage, radius = 50) {
    const tempDownloadPath = path.join(tempDir, `original_${idImage}.tmp`);
    let finalDownloadedPath = '';
    let processableImagePath = ''; // Đường dẫn file có thể xử lý được (PNG, GIF, etc.)
    let tempPngPath = null; // Để theo dõi file PNG tạm được tạo từ JXL

    try {
        // BƯỚC 1: Tải file về với tên tạm
        await downloadFile(imageUrl, tempDownloadPath);

        // BƯỚC 2: Nhận dạng định dạng file từ nội dung
        const type = await fileTypeFromFile(tempDownloadPath);
        if (!type) {
            throw new Error('Không thể xác định định dạng file. File có thể bị hỏng.');
        }
        console.log(`[File Identify] Phát hiện định dạng: ${type.ext} (${type.mime})`);

        // BƯỚC 3: Đổi tên file tạm thành file có đuôi đúng
        finalDownloadedPath = tempDownloadPath.replace('.tmp', `.${type.ext}`);
        await fs.promises.rename(tempDownloadPath, finalDownloadedPath);
        console.log(`[File Rename] Đã đổi tên file thành: ${finalDownloadedPath}`);

        // Mặc định, file có thể xử lý là file vừa tải về
        processableImagePath = finalDownloadedPath;
        const outputWebp = path.join(tempDir, `rounded_${idImage}.webp`);

        // BƯỚC 4: Phân luồng xử lý dựa trên loại file

        // LUỒNG 1: Nếu là VIDEO, nó luôn là file động. Xử lý animation ngay.
        if (type.mime.startsWith('video/')) {
            console.log(`[Bo góc] Phát hiện file VIDEO. Sử dụng quy trình xử lý animation.`);
            return await createAnimatedRoundedCornerWebp(processableImagePath, outputWebp, radius);
        }

        // LUỒNG 2: Nếu là ẢNH
        if (type.mime.startsWith('image/')) {
            // ================== XỬ LÝ RIÊNG CHO JXL ==================
            // Nếu là JXL, phải chuyển sang PNG trước vì Sharp không đọc được JXL trực tiếp.
            if (type.ext === 'jxl') {
                console.log(`[Bo góc] Phát hiện JXL, cần chuyển đổi sang PNG...`);
                tempPngPath = await convertJxlToPngIfNeeded(finalDownloadedPath);
                processableImagePath = tempPngPath; // Cập nhật đường dẫn để các bước sau dùng file PNG
                console.log(`[Bo góc] Đã chuyển đổi JXL sang PNG: ${processableImagePath}`);
            }
            // ============================================================

            // Bây giờ, processableImagePath là file mà Sharp chắc chắn đọc được (PNG, GIF, JPG...)
            const metadata = await sharp(processableImagePath, { animated: true }).metadata();

            // Nếu là ảnh động (GIF, aWebP, hoặc JXL động đã thành PNG)
            if (metadata.pages && metadata.pages > 1) {
                console.log(`[Bo góc] Phát hiện file ẢNH ĐỘNG (${metadata.pages} frames). Sử dụng quy trình xử lý animation.`);
                return await createAnimatedRoundedCornerWebp(processableImagePath, outputWebp, radius);
            }

            // Nếu là ảnh tĩnh
            console.log('[Bo góc] Phát hiện file ẢNH TĨNH. Sử dụng quy trình xử lý ảnh đơn.');
            // ... (logic xử lý ảnh tĩnh giữ nguyên)
            const { width, height } = metadata;
            const maxSize = 512;
            let newWidth, newHeight;
            if (width > height) { newWidth = maxSize; newHeight = Math.round((height / width) * maxSize); }
            else { newHeight = maxSize; newWidth = Math.round((width / height) * maxSize); }

            const roundedCorners = Buffer.from(`<svg><rect x="0" y="0" width="${newWidth}" height="${newHeight}" rx="${radius}" ry="${radius}"/></svg>`);

            await sharp(processableImagePath)
                .resize(newWidth, newHeight, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .composite([{ input: roundedCorners, blend: 'dest-in' }])
                .webp({ quality: 90, lossless: false, alphaQuality: 100, effort: 6 })
                .toFile(outputWebp);

            return outputWebp;
        }

        throw new Error(`Định dạng file '${type.ext}' không được hỗ trợ để làm sticker.`);

    } catch (error) {
        console.error('Lỗi khi tạo sticker bo góc:', error);
        throw error;
    } finally {
        await safeDeleteFile(tempDownloadPath);

        if (finalDownloadedPath && finalDownloadedPath !== tempDownloadPath) {
            await safeDeleteFile(finalDownloadedPath);
        }

        if (tempPngPath) {
            await safeDeleteFile(tempPngPath);
        }
    }
}
/**
 * ====================================================================
 * PHẦN CẬP NHẬT CHÍNH - KẾT THÚC
 * ====================================================================
 */


export async function createCircleWebp(api, message, imageUrl, idImage) {
    const ext = await checkExstentionFileRemote(imageUrl);
    const downloadedImage = path.join(tempDir, `original_${idImage}.${ext}`);
    const framesDir = path.join(tempDir, `frames_${idImage}`);
    const outputWebp = path.join(tempDir, `circle_${idImage}.webp`);
    try {
        await downloadFile(imageUrl, downloadedImage);

        const size = 512;
        const totalFrames = 160;
        const numWorkers = Math.min(os.cpus().length, totalFrames);
        const framesPerWorker = Math.ceil(totalFrames / numWorkers);

        const resizedImageBuffer = await sharp(downloadedImage)
            .resize(size, size, {
                fit: 'cover',
                position: 'center'
            })
            .toBuffer();

        if (!fs.existsSync(framesDir)) {
            await fs.promises.mkdir(framesDir, { recursive: true });
        }

        const circleMask = Buffer.from(`
    <svg width="${size}" height="${size}">
        <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/>
    </svg>
`);

        const workers = [];
        const workerPath = path.join(__dirname, 'frame-worker.js');

        for (let i = 0; i < numWorkers; i++) {
            const startFrame = i * framesPerWorker;
            const endFrame = Math.min(startFrame + framesPerWorker, totalFrames);

            const worker = new Worker(workerPath, {
                workerData: {
                    startFrame,
                    endFrame,
                    size,
                    totalFrames,
                    framesDir,
                    imageBuffer: resizedImageBuffer,
                    circleMask
                }
            });

            workers.push(new Promise((resolve, reject) => {
                worker.on('message', resolve);
                worker.on('error', reject);
                worker.on('exit', (code) => {
                    if (code !== 0) {
                        reject(new Error(`Worker stopped with exit code ${code}`));
                    }
                });
            }));
        }

        await Promise.all(workers);

        const framePattern = path.join(framesDir, 'frame_%03d.png');
        await convertToWebpMulti(framePattern, outputWebp);

        const [linkUploadZalo, stickerData] = await Promise.all([
            api.uploadAttachment([outputWebp], message.threadId, message.type),
            getVideoMetadata(outputWebp)
        ]);

        const finalUrl = linkUploadZalo[0].fileUrl || linkUploadZalo[0].normalUrl;

        return {
            path: outputWebp,
            url: finalUrl,
            stickerData: stickerData
        };

    } catch (error) {
        console.error("Lỗi khi tạo Webp:", error);
        throw error;
    } finally {
        await deleteFile(downloadedImage);
        await fs.promises.rm(framesDir, { recursive: true, force: true });
        // Giữ lại outputWebp để hàm gọi có thể sử dụng
        // await deleteFile(outputWebp); // Dòng này nên được comment hoặc xóa
    }
}

export async function createSpinWebp(api, message, imageUrl, idImage, isCrop = false, cropRatio = 1, isAnimated = false, direction = 1) {
    const ext = await checkExstentionFileRemote(imageUrl);
    const downloadedImage = path.join(tempDir, `original_${idImage}.${ext}`);
    const framesDir = path.join(tempDir, `frames_spin_${idImage}`);
    const outputWebp = path.join(tempDir, `spin_${idImage}.webp`);

    try {
        await downloadFile(imageUrl, downloadedImage);

        const size = 512;
        const totalFrames = 60; // 60 frames @ 15fps = 4 giây/vòng

        // 1. Xử lý ảnh gốc:
        // - Resize về 512x512 (Cover hoặc Contain tùy isCrop)
        // - Thêm nền trắng (nếu trong suốt)
        // Mask để cắt tròn (dùng với dest-in)
        // 1. Chuẩn bị các layer SVG (Mask, Background, Border)
        const circleMask = Buffer.from(`
            <svg width="${size}" height="${size}">
                 <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/>
            </svg>
        `);

        const whiteCircleBg = Buffer.from(`
            <svg width="${size}" height="${size}">
                 <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/>
            </svg>
        `);

        const borderOverlay = Buffer.from(`
            <svg width="${size}" height="${size}">
                <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 5}" stroke="#000" stroke-width="10" fill="none" />
            </svg>
        `);

        // Tính toán kích thước innerSize
        // isCrop = true: Crop hình tròn (fit: cover)
        // isCrop = false: Nén ảnh vào vòng tròn (fit: contain)
        const baseInnerSize = isCrop ? size : Math.round(size / Math.sqrt(2));
        const innerSize = Math.round(baseInnerSize * cropRatio);

        // Helper function: Tạo đĩa cơ sở từ một input (Buffer hoặc Path)
        // Hàm này bọc logic resize/crop/extend/composite hiện tại
        const createBaseDiskFromInput = async (input) => {
            let sharpInstance;

            // Xử lý Input
            if (Buffer.isBuffer(input) || typeof input === 'string') {
                sharpInstance = sharp(input);
            } else {
                throw new Error("Invalid input for createBaseDiskFromInput");
            }

            // Resize & Flatten
            sharpInstance = sharpInstance
                .resize(innerSize, innerSize, { fit: isCrop ? 'cover' : 'contain', background: { r: 255, g: 255, b: 255 } })
                .flatten({ background: { r: 255, g: 255, b: 255 } });

            // Extend hoặc Extract để về đúng kích thước 512x512
            if (innerSize > size) {
                const offset = Math.round((innerSize - size) / 2);
                sharpInstance = sharpInstance.extract({ left: offset, top: offset, width: size, height: size });
            } else if (innerSize < size) {
                const padding = Math.round((size - innerSize) / 2);
                sharpInstance = sharpInstance.extend({
                    top: padding, bottom: padding, left: padding, right: padding,
                    background: { r: 0, g: 0, b: 0, alpha: 0 }
                });
            }

            // Composite với Mask và Border
            return await sharpInstance
                .composite([
                    { input: circleMask, blend: 'dest-in' },
                    { input: whiteCircleBg, blend: 'dest-over' },
                    { input: borderOverlay, blend: 'over' }
                ])
                .png()
                .toBuffer();
        };

        // --- LOGIC XỬ LÝ (ANIMATED vs STATIC) ---

        let sourceFrames = []; // Danh sách đường dẫn frame nguồn (nếu animated)
        let staticBaseDiskBuffer; // Buffer đĩa tĩnh (nếu static)

        // Folder tạm chứa frame nguồn tách ra từ VIDEO/GIF/WEBP động
        const sourceFramesDir = path.join(tempDir, `source_frames_${idImage}`);

        let originalFramerate = 15; // Mặc định 15fps nếu không lấy được meta

        if (isAnimated) {
            console.log(`[Sticker Spin] Chế độ ANIMATION (GIF/Video/WebP). Đang tách frame bằng ImageMagick...`);
            await fs.promises.mkdir(sourceFramesDir, { recursive: true });

            // 1. Lấy Framerate gốc (để dùng lại khi ghép, nếu cần đồng bộ)
            // Tuy nhiên, Spin effect set cứng 60 frames vòng xoay.
            // Nếu muốn giữ speed gốc của GIF, ta cần sync:
            // - GIF gốc: N frames, S seconds.
            // - Spin: Xoay 360 độ trong bao lâu?
            // Hiện tại Spin đang fix cứng: totalFrames = 60.
            // Nếu dùng assembleFramesWithImageMagick, ta set delay bao nhiêu?
            // "15 fps" -> delay ~6-7cs.

            // Để đơn giản và hiệu quả như lệnh 'bo':
            // Dùng ImageMagick tách frame: magick input -coalesce output_%04d.png
            // Điều này tách TOÀN BỘ frame của ảnh động gốc.
            // Số lượng frame tách ra có thể KHÁC 60.
            // - Nếu sourceFrames < 60: Loop lại source frames để fill 60 frames xoay.
            // - Nếu sourceFrames > 60: Lấy 60 frames đầu hoặc chia mẫu?

            // Cách tốt nhất: Tách frame bằng ImageMagick COALESCE để đảm bảo không lỗi hiển thị
            const framePatternSource = path.join(sourceFramesDir, 'source_%04d.png');
            // Dùng -coalesce để "trải phẳng" các frame, loại bỏ tối ưu hóa frame chồng lớp
            await execAsync(`magick "${downloadedImage}" -coalesce "${framePatternSource}"`);

            const files = await fs.promises.readdir(sourceFramesDir);
            sourceFrames = files.filter(f => f.endsWith('.png')).sort().map(f => path.join(sourceFramesDir, f));
            console.log(`[Sticker Spin] Đã tách được ${sourceFrames.length} source frames bằng ImageMagick.`);

            if (sourceFrames.length === 0) {
                // Fallback: Thử FFmpeg nếu ImageMagick fail (cho video MP4 chẳng hạn, vì IM có thể không support video tốt bằng FFmpeg)
                console.warn("[Sticker Spin] ImageMagick không tách được frame. Thử fallback FFmpeg...");
                await execAsync(`ffmpeg -i "${downloadedImage}" -vf "fps=15" "${framePatternSource}"`);
                const filesFallback = await fs.promises.readdir(sourceFramesDir);
                sourceFrames = filesFallback.filter(f => f.endsWith('.png')).sort().map(f => path.join(sourceFramesDir, f));
                console.log(`[Sticker Spin] Fallback FFmpeg tách được ${sourceFrames.length} frames.`);
            }

            if (sourceFrames.length === 0) {
                console.warn("[Sticker Spin] Không tách được frame nào. Chuyển về chế độ tĩnh.");
                isAnimated = false;
            }
        }

        if (!isAnimated) {
            // Chế độ tĩnh: Tạo baseDiskBuffer 1 lần duy nhất
            staticBaseDiskBuffer = await createBaseDiskFromInput(downloadedImage).catch(async (err) => {
                // Fallback FFmpeg logic cũ nếu Sharp fail input trực tiếp (VD: lỗi định dạng lạ)
                console.log(`[Sticker Spin] Sharp direct fail (${err.message}). Trying FFmpeg pre-process...`);
                const tempPng = path.join(tempDir, `spin_temp_${idImage}.png`);
                await execAsync(`ffmpeg -i "${downloadedImage}" -y "${tempPng}"`);
                const buf = await createBaseDiskFromInput(tempPng);
                await deleteFile(tempPng);
                return buf;
            });
        }

        if (!fs.existsSync(framesDir)) {
            await fs.promises.mkdir(framesDir, { recursive: true });
        }

        console.log(`[Sticker Spin] Generating ${totalFrames} frames (parallel)... Direction: ${direction}`);

        // Hàm tạo một frame final
        const generateFrame = async (frameIndex) => {
            const frameFile = path.join(framesDir, `frame_${String(frameIndex).padStart(3, '0')}.png`);
            // Áp dụng chiều xoay: nhân với direction (1 hoặc -1)
            const rotationAngle = (frameIndex * 360 * direction) / totalFrames;

            let diskBufferToRotate;

            if (isAnimated) {
                // Chọn frame nguồn tương ứng (Loop đè)
                const sourceIndex = frameIndex % sourceFrames.length;
                const sourcePath = sourceFrames[sourceIndex];

                // Mõi frame phải process resize/crop lại -> Hơi nặng nhưng cần thiết cho animation
                diskBufferToRotate = await createBaseDiskFromInput(sourcePath);
            } else {
                diskBufferToRotate = staticBaseDiskBuffer;
            }

            const buffer = await sharp(diskBufferToRotate)
                .rotate(rotationAngle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .png()
                .toBuffer();

            const metadata = await sharp(buffer).metadata();
            const left = Math.round((metadata.width - size) / 2);
            const top = Math.round((metadata.height - size) / 2);

            await sharp(buffer)
                .extract({ left: left, top: top, width: size, height: size })
                .png()
                .toFile(frameFile);
        };

        // Xử lý song song với batch (8 frames/batch)
        const BATCH_SIZE = 8;
        for (let batchStart = 0; batchStart < totalFrames; batchStart += BATCH_SIZE) {
            const batchEnd = Math.min(batchStart + BATCH_SIZE, totalFrames);
            const batchPromises = [];

            for (let i = batchStart; i < batchEnd; i++) {
                batchPromises.push(generateFrame(i));
            }

            await Promise.all(batchPromises);
        }

        // Cleanup source frames
        if (isAnimated) {
            await fs.promises.rm(sourceFramesDir, { recursive: true, force: true }).catch(() => { });
        }

        // DEBUG: Check files
        const generatedFiles = await fs.promises.readdir(framesDir);
        if (generatedFiles.length === 0) {
            throw new Error("No frames generated!");
        }

        // Ghép frame thành WebP (10 fps -> 15 fps cho mượt hơn với spin)
        // Ưu tiên dùng FFmpeg để ghép frame vì tốc độ nhanh hơn và hiệu năng tốt hơn
        const framePattern = path.join(framesDir, 'frame_%03d.png');
        await convertToWebpMulti(framePattern, outputWebp, 15, 60);

        const [linkUploadZalo, stickerData] = await Promise.all([
            api.uploadAttachment([outputWebp], message.threadId, message.type),
            getVideoMetadata(outputWebp)
        ]);

        const finalUrl = linkUploadZalo[0].fileUrl || linkUploadZalo[0].normalUrl;

        return {
            path: outputWebp,
            url: finalUrl,
            stickerData: stickerData
        };

    } catch (error) {
        console.error("Lỗi khi tạo Spin Webp:", error);
        throw error;
    } finally {
        if (downloadedImage && fs.existsSync(downloadedImage)) {
            await deleteFile(downloadedImage).catch(() => { });
        }
        await fs.promises.rm(framesDir, { recursive: true, force: true }).catch(() => { });
        // Clean up source frames directory if it exists
        const sourceFramesDir = path.join(tempDir, `source_frames_${idImage}`);
        await fs.promises.rm(sourceFramesDir, { recursive: true, force: true }).catch(() => { });
    }
}

export async function convertToWebpMulti(inputPath, outputPath, framerate = 20, quality = 60) {
    const normalizedInputPath = path.resolve(inputPath);
    const normalizedOutputPath = path.resolve(outputPath);
    await fs.promises.mkdir(path.dirname(normalizedOutputPath), { recursive: true });
    const ffmpegInputPath = normalizedInputPath.replace(/\\/g, '/');
    const ffmpegOutputPath = normalizedOutputPath.replace(/\\/g, '/');

    console.log(`[Ghép WebP qua FFmpeg] Framerate: ${framerate}, Quality: ${quality}`);
    return new Promise((resolve, reject) => {
        ffmpeg(ffmpegInputPath)
            .inputOptions([`-framerate`, `${framerate}`])
            .outputOptions([
                '-c:v', 'libwebp',
                '-lossless', '0',
                '-compression_level', '4',
                '-q:v', `${quality}`,
                '-loop', '0',
                '-preset', 'default',
                '-an',
                '-vsync', '0',
                '-pix_fmt', 'yuva420p'
            ])
            .save(ffmpegOutputPath)
            .on('end', () => resolve(true))
            .on('error', (err) => {
                console.error('Lỗi khi chuyển đổi sang WebP động:', err.message);
                reject(err);
            });
    });
}

export async function createImageWebp(api, message, imageUrl, idImage) {
    const ext = await checkExstentionFileRemote(imageUrl);
    const downloadedImage = path.join(tempDir, `original_${idImage}.${ext}`);
    const outputWebp = path.join(tempDir, `circle_${idImage}.webp`);
    try {
        await downloadFile(imageUrl, downloadedImage);

        const fileStats = await fs.promises.stat(downloadedImage);
        if (fileStats.size === 0) {
            throw new Error("File tải về có kích thước 0 bytes");
        }

        const size = 512;
        const circleMask = Buffer.from(`
            <svg width="${size}" height="${size}">
                <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/>
            </svg>
        `);

        const imageBuffer = await fs.promises.readFile(downloadedImage);

        try {
            await sharp(imageBuffer)
                .resize(size, size, {
                    fit: 'cover',
                    position: 'center'
                })
                .composite([{
                    input: circleMask,
                    blend: 'dest-in'
                }])
                .toFile(outputWebp);
        } catch (sharpError) {
            console.log("Sharp không thể xử lý, thử FFmpeg...");
            const tempPng = path.join(tempDir, `temp_${idImage}.png`);
            try {
                await execAsync(`ffmpeg -i "${downloadedImage}" -vf "scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}" "${tempPng}"`);
                const processedBuffer = await fs.promises.readFile(tempPng);
                await sharp(processedBuffer)
                    .webp({ quality: 80 })
                    .toFile(outputWebp);
                await deleteFile(tempPng);
            } catch (ffmpegError) {
                throw new Error(`Không thể xử lý file: ${ffmpegError.message}`);
            }
        }

        const [linkUploadZalo, stickerData] = await Promise.all([
            api.uploadAttachment([outputWebp], message.threadId, message.type),
            getVideoMetadata(outputWebp)
        ]);

        const finalUrl = linkUploadZalo[0].fileUrl || linkUploadZalo[0].normalUrl;

        // trackStickerCreation('image'); // Removed

        return {
            path: outputWebp,
            url: finalUrl,
            stickerData: stickerData
        };
    } catch (error) {
        console.error("Lỗi khi tạo Webp:", error);
        const object = {
            caption: `⚠️ Đã xảy ra lỗi khi xử lý hình ảnh!\n\nLỗi: ${error.message}\n\nVui lòng thử với file khác hoặc kiểm tra định dạng file.`,
        };
        await sendMessageWarningRequest(api, message, object, 30000);
        return null;
    } finally {
        await deleteFile(downloadedImage);
        // await deleteFile(outputWebp); // Dòng này nên được comment hoặc xóa
    }
}


async function convertGifToWebpWithSharp(inputPath, outputPath, maxSize = DEFAULT_MAX_STICKER_SIZE) {
    const safeSize = normalizeMaxSize(maxSize);
    try {
        await sharp(inputPath, { animated: true })
            .resize({
                width: safeSize,
                height: safeSize,
                fit: 'inside',
                withoutEnlargement: true
            })
            .webp({
                quality: 80,
                effort: 4
            })
            .toFile(outputPath);
        return true;
    } catch (error) {
        console.error('Lỗi khi chuyển đổi GIF sang WebP bằng Sharp:', error);
        throw error;
    }
}

async function convertImageToWebpWithSharp(inputPath, outputPath, maxStickerSize = DEFAULT_MAX_STICKER_SIZE) {
    try {
        const safeSize = normalizeMaxSize(maxStickerSize);

        await sharp(inputPath)
            .resize(safeSize, safeSize, {
                fit: 'inside',
                withoutEnlargement: true
            })
            .webp({
                quality: 80,
                effort: 4
            })
            .toFile(outputPath);

        console.log('✅ Chuyển đổi ảnh sang WebP thành công bằng Sharp');
        return true;
    } catch (error) {
        console.error('⚠️ Lỗi khi chuyển đổi ảnh bằng Sharp:', error.message);

        if (error.message.includes('unsupported image format') || error.message.includes('Input file contains unsupported image format')) {
            console.log('🔄 Sharp không hỗ trợ định dạng này, thử dùng ImageMagick...');
            return await convertJxlWithImageMagick(inputPath, outputPath, maxStickerSize);
        }

        throw error;
    }
}

async function convertJxlWithImageMagick(inputPath, outputPath, maxStickerSize = DEFAULT_MAX_STICKER_SIZE) {
    try {
        const safeSize = normalizeMaxSize(maxStickerSize);
        const command = `magick "${inputPath}" -resize ${safeSize}x${safeSize}> "${outputPath}"`;
        await execAsync(command);
        console.log('✅ Chuyển đổi JXL sang WebP thành công bằng ImageMagick');
        return true;
    } catch (error) {
        console.error('⚠️ Lỗi khi chuyển đổi JXL bằng ImageMagick:', error.message);
        console.log('🔄 ImageMagick không hoạt động, thử dùng FFmpeg...');
        throw new Error('UNSUPPORTED_FORMAT_USE_FFMPEG');
    }
}

export async function convertToWebp(inputPath, outputPath, maxStickerSize = DEFAULT_MAX_STICKER_SIZE) {
    console.log(`🔄 convertToWebp: Input = ${inputPath}, Output = ${outputPath}`);
    const normalizedInputPath = path.resolve(inputPath);
    const normalizedOutputPath = path.resolve(outputPath);
    console.log(`🔄 Normalized paths: Input = ${normalizedInputPath}, Output = ${normalizedOutputPath}`);

    try {
        await fs.promises.access(normalizedInputPath);
        console.log(`✅ File input tồn tại: ${normalizedInputPath}`);
    } catch (error) {
        console.error(`⚠️ File input không tồn tại: ${normalizedInputPath}`);
        throw new Error(`File input không tồn tại: ${normalizedInputPath}`);
    }

    await fs.promises.mkdir(path.dirname(normalizedOutputPath), { recursive: true });

    const extension = path.extname(normalizedInputPath).toLowerCase();
    console.log(`🔍 Phát hiện extension: ${extension}`);

    if (extension === '.webp') {
        console.log('✅ Input đã là file WebP. Bỏ qua chuyển đổi, sao chép trực tiếp.');
        try {
            await fs.promises.copyFile(normalizedInputPath, normalizedOutputPath);
            return true;
        } catch (error) {
            console.error('⚠️ Lỗi khi sao chép file WebP:', error);
            throw error;
        }
    }

    if (extension === '.gif') {
        console.log('Phát hiện file GIF, đang xử lý bằng Sharp...');
        return convertGifToWebpWithSharp(normalizedInputPath, normalizedOutputPath, maxStickerSize);
    }

    if (extension === '.jxl') {
        console.log('Phát hiện file JXL, thử sử dụng ImageMagick...');
        try {
            return await convertJxlWithImageMagick(normalizedInputPath, normalizedOutputPath, maxStickerSize);
        } catch (imageMagickError) {
            console.log('🔄 ImageMagick thất bại, thử chuyển đổi JXL sang PNG rồi sang WebP...');
            const tempPngPath = normalizedInputPath.replace(/\.jxl$/i, '_temp.png');
            try {
                const ffmpegInputPath = normalizedInputPath.replace(/\\/g, '/');
                const ffmpegTempPath = tempPngPath.replace(/\\/g, '/');
                await execAsync(`ffmpeg -i "${ffmpegInputPath}" "${ffmpegTempPath}"`);
                console.log('✅ JXL -> PNG thành công, đang convert PNG -> WebP...');
                const result = await convertImageToWebpWithSharp(tempPngPath, normalizedOutputPath, maxStickerSize);
                await deleteFile(tempPngPath).catch(console.error);
                return result;
            } catch (error) {
                await deleteFile(tempPngPath).catch(console.error);
                console.error('⚠️ Tất cả các phương pháp chuyển đổi JXL đều thất bại');
                throw new Error('Không thể chuyển đổi file JXL. Vui lòng cài đặt ImageMagick với hỗ trợ JXL hoặc sử dụng định dạng khác (PNG, JPG, GIF, WebP).');
            }
        }
    }

    console.log(`Phát hiện file ${extension}, đang xử lý bằng FFmpeg...`);
    const filterChain = buildWebpFilterChain(maxStickerSize);

    return new Promise((resolve, reject) => {
        const ffmpegInputPath = normalizedInputPath.replace(/\\/g, '/');
        const ffmpegOutputPath = normalizedOutputPath.replace(/\\/g, '/');
        console.log(`🔄 FFmpeg paths: Input = ${ffmpegInputPath}, Output = ${ffmpegOutputPath}`);

        const ffmpegCommand = ffmpeg(ffmpegInputPath)
            .outputOptions([
                '-vf', filterChain,
                '-c:v', 'libwebp',
                '-lossless', '0',
                '-compression_level', '6',
                '-q:v', '60',
                '-loop', '0',
                '-preset', 'default',
                '-cpu-used', '4',
                '-deadline', 'realtime',
                '-threads', 'auto',
                '-an',
                '-vsync', '0',
                '-pix_fmt', 'yuva420p'
            ])
            .save(ffmpegOutputPath);

        ffmpegCommand
            .on('end', () => {
                resolve(true);
            })
            .on('error', (err) => {
                console.error('Lỗi khi chuyển đổi sang WebP bằng FFmpeg:', err.message);
                reject(err instanceof Error ? err : new Error(String(err)));
            });
    });
}

export async function fixCorruptedWebp(inputPath, outputPath) {
    try {
        const tempPng = inputPath.replace('.webp', '_temp.png');
        await execAsync(`ffmpeg -i "${inputPath}" -f image2 "${tempPng}"`);
        await execAsync(`ffmpeg -i "${tempPng}" -c:v libwebp -quality 80 "${outputPath}"`);
        await deleteFile(tempPng);
        return true;
    } catch (error) {
        console.error('Không thể sửa WebP bị lỗi:', error.message);
        return false;
    }
}

export async function createSmoothWebpAnimation(inputPath, outputPath) {
    try {
        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .inputOptions(['-framerate', '30'])
                .outputOptions([
                    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
                    '-c:v', 'libwebp',
                    '-lossless', '0',
                    '-compression_level', '3',
                    '-q:v', '70',
                    '-loop', '0',
                    '-preset', 'default',
                    '-cpu-used', '3',
                    '-deadline', 'good',
                    '-threads', 'auto',
                    '-vsync', '0',
                    '-t', '6',
                    '-pix_fmt', 'yuva420p',
                    '-an'
                ])
                .save(outputPath)
                .on('end', () => {
                    console.log('✅ Tạo WebP animation thành công');
                    resolve(true);
                })
                .on('error', (err) => {
                    console.error('⚠️ Lỗi khi tạo WebP animation:', err.message);
                    reject(err instanceof Error ? err : new Error(String(err)));
                });
        });
    } catch (error) {
        console.error('Lỗi trong createSmoothWebpAnimation:', error);
        throw error;
    }
}
