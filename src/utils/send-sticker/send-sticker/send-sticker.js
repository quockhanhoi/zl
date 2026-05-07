import axios from "axios";
import fs from "fs";
import path from "path";
import { loadConfig } from "../../../utils/config.js";
const getGlobalPrefix = () => loadConfig().bot?.prefix || "-";
import { checkExstentionFileRemote, deleteFile, downloadFile, execAsync } from "../../util.js";
import { MessageMention, MessageType } from "../../../api-zalo/index.js";
import { tempDir } from "../../io-json.js";
import { removeMention } from "../../format-util.js";
import { getVideoMetadata } from "../../../api-zalo/api-zalo/utils.js";
import { isAdmin } from "../../config.js";
import { convertToWebp, createRoundedCornerWebp, createSpinWebp } from "./create-webp.js";
import { appContext } from "../../../api-zalo/api-zalo/context.js";

/**
 * Kiểm tra URL có phải là media hợp lệ Không
 */
async function isValidMediaUrl(url) {
  try {
    const ext = await checkExstentionFileRemote(url);
    if (!ext) {
      console.log("⚠️ Không detect được extension từ URL, sẽ kiểm tra magic bytes sau...");
      return {
        isValid: true,
        isVideo: false, // Mặc định là ảnh, sẽ được xác định lại sau
      };
    }
    if (ext === "mp4" || ext === "mov" || ext === "webm" || ext === "zxl") {
      return {
        isValid: true,
        isVideo: true,
      };
    } else if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp") {
      return {
        isValid: true,
        isVideo: false,
      };
    } else if (ext === "jxl") {
      return {
        isValid: true,
        isVideo: false,
      };
    } else {
      return {
        isValid: false,
        isVideo: false,
      };
    }
  } catch (error) {
    console.error("Lỗi khi kiểm tra URL:", error);
    return {
      isValid: false,
      isVideo: false,
    };
  }
}

/**
 * Xử lý tạo và gửi sticker từ URL hoặc local path
 * @param {boolean} [noAI=false] Nếu true, không gửi thuộc tính jcp
 */
export async function processAndSendSticker(api, message, mediaSource, noAI = false) {
  const senderName = message.data.dName;
  const senderId = message.data.uidFrom;
  let pathSticker = path.join(tempDir, `sticker_${Date.now()}.templink`);
  let pathWebp = path.join(tempDir, `sticker_${Date.now()}.webp`);
  let isLocalFile = false;

  try {
    try {
      await fs.promises.access(mediaSource);
      isLocalFile = true;
    } catch {
      isLocalFile = false;
    }

    if (!isLocalFile) {
      let ext = await checkExstentionFileRemote(mediaSource);

      // Nếu không detect được extension, tải file tạm để kiểm tra magic bytes
      if (!ext) {
        console.log(`⚠️ Không detect được extension từ URL, tải file để kiểm tra...`);
        const tempPath = path.join(tempDir, `temp_${Date.now()}.unknown`);
        await downloadFile(mediaSource, tempPath);

        // Kiểm tra magic bytes để detect JXL
        const buffer = await fs.promises.readFile(tempPath, { encoding: null });
        if (buffer.length >= 12) {
          // JXL magic bytes: 0xFF 0x0A hoặc 0x00 0x00 0x00 0x0C 0x4A 0x58 0x4C 0x20 0x0D 0x0A 0x87 0x0A
          if ((buffer[0] === 0xFF && buffer[1] === 0x0A) ||
            (buffer[4] === 0x4A && buffer[5] === 0x58 && buffer[6] === 0x4C && buffer[7] === 0x20)) {
            ext = 'jxl';
            console.log(`🔍 Phát hiện file JXL qua magic bytes`);
          }
        }

        if (!ext) {
          ext = 'unknown';
          console.log(`⚠️ Không thể xác định định dạng file`);
        }

        // Đổi tên file tạm với extension đúng
        pathSticker = path.join(tempDir, `sticker_${Date.now()}.${ext}`);
        await fs.promises.rename(tempPath, pathSticker);
      } else {
        pathSticker = path.join(tempDir, `sticker_${Date.now()}.${ext}`);
        console.log(`📥 Đang tải file từ URL: ${mediaSource}`);
        console.log(`📁 Đường dẫn lưu file: ${pathSticker}`);
        await downloadFile(mediaSource, pathSticker);
      }

      console.log(`✅ Tải file thành công: ${pathSticker} (${ext})`);
    } else {
      pathSticker = mediaSource;
      console.log(`📁 Sử dụng file local: ${pathSticker}`);
    }

    await convertToWebp(pathSticker, pathWebp);
    const linkUploadZalo = await api.uploadAttachment([pathWebp], appContext.send2meId, MessageType.DirectMessage, false, true);
    const stickerData = await getVideoMetadata(pathSticker);
    const stickerCreatedBy = process.env.STICKER_CREATED_BY || `${process.env.AUTHOR_NAME || 'DGK'}.${process.env.BOT_NAME_SHORT || 'SEX'}`;
    const baseUrl = linkUploadZalo[0].fileUrl || linkUploadZalo[0].normalUrl;
    const finalUrl = baseUrl + (baseUrl.includes('?') ? '&' : '?') + `stickerCreatedBy=${stickerCreatedBy}`;
    // Bỏ gửi tin nhắn văn bản phiền phức theo yêu cầu sếp
    /*
    await api.sendMessage(
      {
        msg: `${senderName} Sticker của bạn đây!`,
        quote: message,
        mentions: [MessageMention(senderId, senderName.length, 0)],
        ttl: 300000,
      },
      message.threadId,
      message.type
    );
    */

    await api.sendCustomSticker(
      message,
      finalUrl,
      finalUrl,
      stickerData.width,
      stickerData.height,
      3600000,
      noAI
    );

    return true;
  } catch (error) {
    console.error("Lỗi khi xử lý sticker:", error);
    throw error;
  } finally {
    // Xóa file tạm, sử dụng deleteFile an toàn
    if (pathSticker && pathSticker !== mediaSource) await deleteFile(pathSticker);
    if (pathWebp) await deleteFile(pathWebp);
  }
}

/**
 * Xử lý lệnh tạo sticker
 */
export async function handleStickerCommand(api, message) {
  const quote = message.data.quote;
  const senderName = message.data.dName;
  const senderId = message.data.uidFrom;
  const threadId = message.threadId;
  const isAdminLevelHighest = isAdmin(senderId);
  const isAdminBot = isAdmin(senderId, threadId);
  const content = removeMention(message);
  const prefix = getGlobalPrefix();
  const tempPath = path.join(tempDir, `sticker_${Date.now()}.png`);
  let tempPathCreated = false; // Theo dõi xem tempPath đã được tạo chưa

  if (!quote) {
    await api.sendMessage(
      {
        msg: `${senderName} Hãy reply vào tin nhắn chứa ảnh hoặc video cần tạo sticker và dùng lại lệnh ${prefix}sticker.

📌 Từ khóa:
• spin - Tạo sticker xoay tròn
• crop - Crop ảnh đầy vòng tròn (dùng với spin)
• gif - Giữ animation gốc khi tạo sticker spin (dùng cho GIF/Video)
• x{số} - Tỷ lệ zoom (vd: x0.5, x1.5)
• bo - Bo góc sticker
• xp - Xóa phông nền
• noai - Loại bỏ biểu tượng AI góc phải

💡 Ví dụ: ${prefix}sticker spin crop gif x0.8 noai`,
        quote: message,
        mentions: [MessageMention(senderId, senderName.length, 0)],
        ttl: 30000,
      },
      message.threadId,
      message.type
    );
    return;
  }

  const attach = quote.attach;
  if (!attach) {
    await api.sendMessage(
      {
        msg: `${senderName} Không có đính kèm nào trong nội dung reply của bạn.`,
        quote: message,
        mentions: [MessageMention(senderId, senderName.length, 0)],
        ttl: 30000,
      },
      message.threadId,
      message.type
    );
    return;
  }

  try {
    const attachData = JSON.parse(attach);
    const mediaUrl = attachData.hdUrl || attachData.href;

    if (!mediaUrl) {
      await api.sendMessage(
        {
          msg: `${senderName} Không tìm thấy URL trong đính kèm của tin nhắn bạn đã reply.`,
          quote: message,
          mentions: [MessageMention(senderId, senderName.length, 0)],
          ttl: 30000,
        },
        message.threadId,
        message.type
      );
      return;
    }

    const decodedUrl = decodeURIComponent(mediaUrl.replace(/\\\//g, "/"));

    const mediaCheck = await isValidMediaUrl(decodedUrl);
    if (!mediaCheck.isValid) {
      console.error("URL Không hợp lệ:", decodedUrl);
      await api.sendMessage(
        {
          msg: `${senderName} URL trong tin nhắn bạn reply Không phải là ảnh, GIF hoặc video hợp lệ.`,
          quote: message,
          mentions: [MessageMention(senderId, senderName.length, 0)],
          ttl: 30000,
        },
        message.threadId,
        message.type
      );
      return;
    }

    const isVideo = mediaCheck.isVideo;
    const isXoaPhong = content.includes("xp");
    const isBoGoc = content.includes("bo");
    const isSpin = content.includes("spin");
    const isNoAI = content.includes("noai");
    const isCropSpin = content.includes("crop"); // Crop hình tròn thay vì nén
    const isGifMode = content.includes("gif") || content.includes("gift"); // Support 'gift' typo as well
    // Parse tỷ lệ crop từ x{số}, ví dụ: crop x0.5, crop x1.5 (mặc định: 1)
    const cropRatioMatch = content.match(/crop\s*x([\d.]+)/i);
    const cropRatio = cropRatioMatch ? parseFloat(cropRatioMatch[1]) : 1;

    if (isXoaPhong && isVideo) {
      await api.sendMessage(
        {
          msg: `${senderName} Chưa hỗ trợ xóa phong cho sticker video!`,
          quote: message,
          mentions: [MessageMention(senderId, senderName.length, 0)],
          ttl: 6000,
        },
        message.threadId,
        message.type
      );
      return;
    }


    await api.sendMessage(
      {
        msg: `${senderName} Ok, đang tạo sticker, chờ một chút!`,
        quote: message,
        mentions: [MessageMention(senderId, senderName.length, 0)],
        ttl: 6000,
      },
      message.threadId,
      message.type
    );

    if (isXoaPhong) {
      await api.sendMessage(
        {
          msg: `${senderName} Rất tiếc, tính năng xóa phông (xp) hiện chưa được cài đặt trong bộ bot này.`,
          quote: message,
          mentions: [MessageMention(senderId, senderName.length, 0)],
          ttl: 30000,
        },
        message.threadId,
        message.type
      );
      return;
    } else if (isSpin) {
      // Chỉ block video nếu KHÔNG có keyword gif/gift
      if (isVideo && !isGifMode) {
        await api.sendMessage(
          {
            msg: `${senderName} Sticker Spin Video chỉ hỗ trợ nếu dùng kèm từ khóa 'gif'!\nVí dụ: ${prefix}sticker spin gif`,
            quote: message,
            mentions: [MessageMention(senderId, senderName.length, 0)],
            ttl: 6000,
          },
          message.threadId,
          message.type
        );
        return;
      }

      const idImage = `spin_${Date.now()}`;

      // Xác định chiều xoay (1: phải/kim đồng hồ, -1: trái/ngược kim đồng hồ)
      let direction = 1; // Mặc định xoay phải
      const leftKeywords = ['trai', 'trái', 'left'];
      const rightKeywords = ['phai', 'phải', 'right'];

      // Kiểm tra từ khóa trong content (đã xóa prefix và mention)
      const contentLower = content.toLowerCase();
      if (leftKeywords.some(kw => contentLower.includes(kw))) {
        direction = -1;
      } else if (rightKeywords.some(kw => contentLower.includes(kw))) {
        direction = 1;
      }

      // Sử dụng await để đợi kết quả trả về từ createSpinWebp
      // Truyền isCropSpin, cropRatio, isGifMode và direction
      const spinResult = await createSpinWebp(api, message, decodedUrl, idImage, isCropSpin, cropRatio, isGifMode, direction);

      // createSpinWebp đã upload và trả về kết quả, nhưng processAndSendSticker mong đợi đường dẫn file.
      // Tuy nhiên, processAndSendSticker cũng xử lý upload lại.
      // Tốt nhất là ta gửi luôn sticker từ đây hoặc return path để gửi.
      // Xem cấu trúc createSpinWebp: nó trả về { path, url, stickerData } VÀ đã uploadAttachment nhưng CHƯA sendCustomSticker?
      // À hàm processAndSendSticker lo việc upload và sendCustomSticker.
      // createSpinWebp trong create-webp.js dòng 458 có api.uploadAttachment.
      // Để đồng bộ, ta nên để createSpinWebp chỉ TRẢ VỀ PATH, rồi gọi processAndSendSticker?
      // Nhưng createSpinWebp đã được viết để làm nhiều việc (kế thừa createCircleWebp).
      // Hãy check lại processAndSendSticker. Nó nhận mediaSource (path/url), convertToWebp, upload, send.

      // Cách đơn giản nhất:
      // createSpinWebp trả về path file WebP đã tạo.
      // Ta gọi processAndSendSticker với path đó (isLocalFile = true).
      // Nhưng createSpinWebp CŨNG upload luôn?

      // Check lại createSpinWebp tôi vừa viết:
      /*
        const [linkUploadZalo, stickerData] = await Promise.all([
            api.uploadAttachment([outputWebp], message.threadId, message.type),
            getVideoMetadata(outputWebp)
        ]);
        return { path: outputWebp, ... };
      */

      // Nó đã upload một lần rồi. Nếu gọi processAndSendSticker, nó sẽ convert (lại?) và upload (lại).
      // processAndSendSticker gọi `convertToWebp` (convert lại webp -> webp, ok nhanh) -> upload -> send.
      // Hơi thừa thãi nhưng an toàn và tái sử dụng code gửi.
      // Chỉ cần createSpinWebp TRẢ VỀ PATH local là đủ.

      // Tuy nhiên, createSpinWebp tôi copy từ createCircleWebp, nó làm full flow upload.
      // Để tránh duplicate, tôi sẽ gửi luôn ở đây và return.
      // Hoặc sửa createSpinWebp?
      // Thôi, dùng kết quả của createSpinWebp để gửi luôn cho nhanh, bypass processAndSendSticker.

      const stickerData = spinResult.stickerData;
      const finalUrl = spinResult.url + `?stickerCreatedBy=${process.env.STICKER_CREATED_BY || 'DGK.SEX'}`;

      await api.sendMessage(
        {
          msg: `${senderName} Sticker của bạn đây!`,
          quote: message,
          mentions: [MessageMention(senderId, senderName.length, 0)],
          ttl: 300000,
        },
        message.threadId,
        message.type
      );

      await api.sendCustomSticker(
        message,
        finalUrl,
        finalUrl,
        stickerData.width,
        stickerData.height,
        3600000,
        isNoAI
      );

      // Cleanup file handled in createSpinWebp mainly, but outputWebp might remain?
      try { await deleteFile(spinResult.path); } catch { }

    } else if (isBoGoc) {
      const idImage = `rounded_${Date.now()}`;
      const roundedImagePath = await createRoundedCornerWebp(api, message, decodedUrl, idImage);
      try {
        await processAndSendSticker(api, message, roundedImagePath, isNoAI);
      } finally {
        try {
          await deleteFile(roundedImagePath);
        } catch { }
      }
    } else {
      await processAndSendSticker(api, message, decodedUrl, isNoAI);
    }
  } catch (error) {
    console.error("Lỗi khi xử lý lệnh sticker:", error);

    // Kiểm tra nếu lỗi liên quan đến JXL
    let errorMsg = `${senderName} Lỗi Khi Xử Lý Lệnh Sticker -> ${error.message}`;
    if (error.message.includes('jpegxl') || error.message.includes('JXL') || error.message.includes('jxl')) {
      errorMsg = `${senderName} ⚠️ Định dạng JXL chưa được hỗ trợ đầy đủ!\n\n🔧 Để sử dụng JXL, vui lòng cài đặt:\n• ImageMagick với JXL support\n• FFmpeg với JXL decoder\n\n💡 Thay vào đó, hãy thử với PNG, JPG, GIF hoặc WebP!`;
    }

    await api.sendMessage(
      {
        msg: errorMsg,
        quote: message,
        mentions: [MessageMention(senderId, senderName.length, 0)],
        ttl: 30000,
      },
      message.threadId,
      message.type
    );
  } finally {
    // Chỉ xóa tempPath nếu nó được tạo (trong trường hợp xóa phông)
    if (tempPathCreated) {
      await deleteFile(tempPath);
    }
  }
}