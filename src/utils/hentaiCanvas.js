import { createCanvas, loadImage } from "canvas";
import axios from "axios";
import sharp from "sharp";
import "./canvasHelper.js"; // Để đảm bảo font đã được register

export async function splitLongImage(buffer, maxHeight = 3000) {
    const metadata = await sharp(buffer).metadata();
    
    // Nếu ảnh ngắn hơn mức giới hạn, trả về nguyên bản để giữ nguyên chất lượng
    if (metadata.height <= maxHeight) {
        // Zalo thường hỗ trợ webp nhưng an toàn nhất là chuyển sang jpeg cho độ tương thích cao
        if (metadata.format === 'webp') {
            return [await sharp(buffer).jpeg({ quality: 90 }).toBuffer()];
        }
        return [buffer];
    }

    const chunks = [];
    const width = metadata.width;
    const height = metadata.height;
    
    let currentY = 0;
    const overlap = 150; // Tạo vùng gối đầu 150px giữa các ảnh để không bị đứt đoạn chữ khi lướt

    while (currentY < height) {
        const cropHeight = Math.min(maxHeight, height - currentY);
        const chunk = await sharp(buffer)
            .extract({ left: 0, top: currentY, width: width, height: cropHeight })
            .jpeg({ quality: 90 }) // Chuyển sang Jpeg chất lượng cao để chống nhòe
            .toBuffer();
        chunks.push(chunk);
        
        currentY += cropHeight;
        // Nếu vẫn còn ảnh để cắt, lùi currentY lại 1 chút để tạo overlap
        if (currentY < height) {
            currentY -= overlap;
        }
    }
    
    return chunks;
}

// Helper function
function drawRoundRect(ctx, x, y, width, height, radius) {
    if (radius === undefined) radius = 0;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

export async function drawHentaiSearch(results, query) {
    const width = 1200;
    const paddingX = 50;
    const paddingY = 160;
    const itemW = 530;
    const itemH = 140;
    const gapX = 40;
    const gapY = 25;
    
    const columns = 2;
    const itemsCount = Math.min(results.length, 10);
    const rows = Math.ceil(itemsCount / columns);
    const height = paddingY + (rows * (itemH + gapY)) + 80;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // 1. Dark Premium Theme Background
    const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
    bgGrad.addColorStop(0, "#0f0c29"); // Deep purple/black
    bgGrad.addColorStop(0.5, "#302b63");
    bgGrad.addColorStop(1, "#24243e");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // Decorative glowing orbs
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = "#ff416c";
    ctx.beginPath(); ctx.arc(100, 100, 300, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ff4b2b";
    ctx.beginPath(); ctx.arc(1100, height - 100, 400, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1.0;

    // Add noise or glass effect overlay
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    ctx.fillRect(0, 0, width, height);

    // 2. Header
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 60px SVNTransformer, BeVietnamProBold, Arial";
    ctx.fillText("HENTAI ZONE", 50, 90);

    ctx.fillStyle = "#ff758c";
    ctx.font = "bold 24px BeVietnamProBold, Arial";
    ctx.fillText(`KẾT QUẢ TÌM KIẾM: "${query.toUpperCase()}"`, 50, 130);

    // Instruction Badge
    const instrText = "➜ REPLY STT (1-10) ĐỂ XEM CHI TIẾT";
    ctx.font = "bold 20px BeVietnamProBold";
    const tw = ctx.measureText(instrText).width;
    const badgeW = tw + 40;
    const badgeX = width - badgeW - 50;
    
    ctx.shadowColor = "rgba(255, 65, 108, 0.6)";
    ctx.shadowBlur = 20;
    const btnGrad = ctx.createLinearGradient(badgeX, 50, badgeX + badgeW, 100);
    btnGrad.addColorStop(0, "#ff416c");
    btnGrad.addColorStop(1, "#ff4b2b");
    ctx.fillStyle = btnGrad;
    drawRoundRect(ctx, badgeX, 60, badgeW, 50, 25);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.fillText(instrText, badgeX + (badgeW / 2), 92);

    // Load thumbnails
    const thumbPromises = results.slice(0, 10).map(async (item) => {
        if (!item.thumbnail) return null;
        try {
            const res = await axios.get(item.thumbnail, { responseType: 'arraybuffer', timeout: 5000 });
            return await loadImage(Buffer.from(res.data));
        } catch (e) { return null; }
    });
    const thumbImages = await Promise.all(thumbPromises);

    // 3. Draw Grid
    for (let i = 0; i < itemsCount; i++) {
        const item = results[i];
        const col = i % columns;
        const row = Math.floor(i / columns);
        const x = paddingX + (col * (itemW + gapX));
        const y = paddingY + (row * (itemH + gapY));

        // Glassmorphism Card
        ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
        ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
        ctx.lineWidth = 1;
        drawRoundRect(ctx, x, y, itemW, itemH, 20);
        ctx.fill();
        ctx.stroke();

        // Thumbnail
        const thumbSize = 120;
        const img = thumbImages[i];
        if (img) {
            ctx.save();
            drawRoundRect(ctx, x + 10, y + 10, thumbSize, thumbSize, 15);
            ctx.clip();
            const imgRatio = img.width / img.height;
            let sWidth = img.width, sHeight = img.height, sx = 0, sy = 0;
            if (imgRatio > 1) {
                sWidth = img.height;
                sx = (img.width - sWidth) / 2;
            } else {
                sHeight = img.width;
                sy = (img.height - sHeight) / 2;
            }
            ctx.drawImage(img, sx, sy, sWidth, sHeight, x + 10, y + 10, thumbSize, thumbSize);
            ctx.restore();
        } else {
            ctx.fillStyle = "rgba(0,0,0,0.3)";
            drawRoundRect(ctx, x + 10, y + 10, thumbSize, thumbSize, 15);
            ctx.fill();
        }

        // STT Badge
        ctx.shadowColor = "rgba(0,0,0,0.5)";
        ctx.shadowBlur = 10;
        ctx.fillStyle = "#ff416c";
        ctx.beginPath();
        ctx.arc(x + 25, y + 25, 20, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = "#fff";
        ctx.font = "bold 20px BeVietnamProBold";
        ctx.textAlign = "center";
        ctx.fillText(i + 1, x + 25, y + 32);

        // Title text
        const textX = x + thumbSize + 25;
        const textW = itemW - thumbSize - 35;
        ctx.textAlign = "left";
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 22px BeVietnamProBold, NotoEmojiBold, Arial";
        
        // Word wrap for title
        const words = item.title.split(' ');
        let line1 = "", line2 = "", line3 = "";
        let l1Full = false, l2Full = false;
        
        for (const word of words) {
            if (!l1Full) {
                if (ctx.measureText(line1 + word).width < textW) line1 += word + " ";
                else l1Full = true;
            }
            if (l1Full && !l2Full) {
                if (ctx.measureText(line2 + word).width < textW) line2 += word + " ";
                else l2Full = true;
            }
            if (l2Full) {
                if (ctx.measureText(line3 + word).width < textW - 30) line3 += word + " ";
                else { line3 += "..."; break; }
            }
        }
        
        ctx.fillText(line1.trim(), textX, y + 45);
        if (line2) ctx.fillText(line2.trim(), textX, y + 75);
        if (line3) {
            ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
            ctx.fillText(line3.trim(), textX, y + 105);
        }
    }

    // Footer
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
    ctx.font = "bold 16px BeVietnamProBold";
    ctx.fillText("POWERED BY DGK SYSTEM • DESIGNED EXCLUSIVELY FOR ZALO BOT", width / 2, height - 30);

    return canvas.toBuffer("image/jpeg", { quality: 0.85 });
}

export async function drawHentaiDetail(detail) {
    const width = 1000;
    const height = 760;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // Background gradient (Dark premium similar to phim)
    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, "#1a0b12"); // Dark red/black
    bg.addColorStop(1, "#111827"); // Dark gray
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    // Decorative Glass Box
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    drawRoundRect(ctx, 30, 30, 940, 700, 24);
    ctx.fill();

    const posterX = 60;
    const posterY = 60;
    const posterW = 250;
    const posterH = 360;

    // Draw Poster
    try {
        if (detail.thumbnail) {
            const res = await axios.get(detail.thumbnail, { responseType: "arraybuffer", timeout: 5000 });
            const img = await loadImage(Buffer.from(res.data));
            ctx.save();
            drawRoundRect(ctx, posterX, posterY, posterW, posterH, 18);
            ctx.clip();
            const imgRatio = img.width / img.height;
            const targetRatio = posterW / posterH;
            let sWidth = img.width, sHeight = img.height, sx = 0, sy = 0;
            if (imgRatio > targetRatio) {
                sWidth = img.height * targetRatio;
                sx = (img.width - sWidth) / 2;
            } else {
                sHeight = img.width / targetRatio;
                sy = (img.height - sHeight) / 2;
            }
            ctx.drawImage(img, sx, sy, sWidth, sHeight, posterX, posterY, posterW, posterH);
            ctx.restore();
        } else {
            ctx.fillStyle = "#222";
            drawRoundRect(ctx, posterX, posterY, posterW, posterH, 18);
            ctx.fill();
        }
    } catch {}

    // Title
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 34px BeVietnamProBold, NotoEmojiBold, Sans";
    let title = detail.title || "Truyện Tranh";
    if (ctx.measureText(title).width > 600) {
        while (title.length > 0 && ctx.measureText(`${title}...`).width > 600) title = title.slice(0, -1);
        title += "...";
    }
    ctx.fillText(title, 340, 95);

    // Information lines
    ctx.fillStyle = "rgba(255,255,255,0.78)";
    ctx.font = "20px BeVietnamPro, Sans";
    const infoLines = [
        `Tác giả: ${detail.author || "Đang cập nhật"}`,
        `Tổng số chương: ${detail.chapters ? detail.chapters.length : 0}`,
    ];
    infoLines.forEach((line, index) => ctx.fillText(line, 340, 145 + index * 34));

    // Genres (with wrapping if too long)
    const genres = `Thể loại: ${detail.genres || "Đang cập nhật"}`;
    const wordsGenres = genres.split(' ');
    let linesGenres = [];
    let currentG = "";
    for (const word of wordsGenres) {
        const test = currentG ? `${currentG} ${word}` : word;
        if (ctx.measureText(test).width <= 580) currentG = test;
        else {
            if (currentG) linesGenres.push(currentG);
            currentG = word;
        }
    }
    if (currentG) linesGenres.push(currentG);

    linesGenres.slice(0, 3).forEach((line, index) => {
        ctx.fillText(line, 340, 145 + infoLines.length * 34 + index * 34);
    });

    // Danh sách chương Header
    ctx.fillStyle = "#ff416c";
    ctx.font = "bold 24px BeVietnamProBold, Sans";
    ctx.fillText(`Danh sách chương (${detail.chapters.length})`, 60, 470);

    // Render Chapters as continuous text wrapping
    const episodes = detail.chapters || [];
    const episodeText = episodes
        .slice(0, 30) // Tăng giới hạn số lượng chương có thể hiển thị
        .map((ep, i) => `${i + 1}. ${ep.name || `Chương ${i + 1}`}`)
        .join("   ");

    ctx.fillStyle = "rgba(255,255,255,0.86)";
    ctx.font = "20px BeVietnamPro, Sans";
    const maxWidth = 880;
    const words = episodeText.split(/\s+/);
    const lines = [];
    let current = "";
    for (const word of words) {
        const test = current ? `${current} ${word}` : word;
        if (ctx.measureText(test).width <= maxWidth) current = test;
        else {
            if (current) lines.push(current);
            current = word;
        }
    }
    if (current) lines.push(current);

    lines.slice(0, 6).forEach((line, index) => {
        ctx.fillText(line, 60, 520 + index * 34);
    });

    if (episodes.length > 30 || lines.length > 6) {
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.fillText(`...và còn các chương khác`, 60, 520 + Math.min(lines.length, 6) * 34);
    }

    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.textAlign = "center";
    ctx.font = "16px BeVietnamPro, Sans";
    ctx.fillText("Reply số chương để bot tải và gửi ảnh đọc", width / 2, height - 28);

    return canvas.toBuffer("image/png");
}
