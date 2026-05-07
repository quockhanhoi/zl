import axios from "axios";
import FormData from "form-data";
import fs from "node:fs";
import { log } from "../logger.js";

/**
 * Upload file lên các dịch vụ lưu trữ (Uguu, Catbox, Tmpfiles)
 */
export async function uploadToTmpFiles(filePath, api = null, threadId = null, threadType = null) {
    try {
        if (!fs.existsSync(filePath)) return null;

        const isWebp = filePath.toLowerCase().endsWith(".webp");

        // --- 1. ZALO CDN (Ưu tiên hàng đầu) ---
        if (api && threadId) {
            try {
                log.info(`◈ Đang upload file lên Zalo CDN...`);
                const results = await api.uploadAttachment([filePath], threadId, threadType);
                if (results && results.length > 0) {
                    let url = results[0].fileUrl || results[0].url || results[0].hdUrl;
                    if (url) {
                        // Fix: Thay đổi định danh thành DGK.SEX và ép host f37 theo yêu cầu sếp
                        url = url.replace(/(createby|stickerCreatedBy)=[^&]+/g, "$1=DGK.SEX");
                        if (!url.includes("stickerCreatedBy=")) {
                            url += (url.includes("?") ? "&" : "?") + "stickerCreatedBy=DGK.SEX";
                        }
                        if (url.includes("zfcloud.zdn.vn")) {
                            url = url.replace(/(f\d+|b\d+|g\d+|fg\d+|bg\d+)[.-](zfcloud\.zdn\.vn|dlfl\.vn)/g, "f37-zfcloud.zdn.vn");
                        }
                        log.info(`✅ [ZaloCDN] Upload thành công: ${url}`);
                        return url;
                    }
                }
            } catch (e) {
                log.warn(`⚠️ [ZaloCDN] Lỗi: ${e.message}`);
            }
        }

        // --- 2. UGUU.SE (Mạnh mẽ & Mượt mà) ---
        try {
            log.info(`◈ Đang upload file lên uguu.se...`);
            const formUguu = new FormData();
            formUguu.append("files[]", fs.createReadStream(filePath));

            const responseUguu = await axios.post("https://uguu.se/upload?output=text", formUguu, {
                headers: formUguu.getHeaders(),
                timeout: 25000
            });

            if (typeof responseUguu.data === "string" && responseUguu.data.startsWith("http")) {
                const url = responseUguu.data.trim();
                log.info(`✅ [uguu.se] Upload thành công: ${url}`);
                return url;
            }
        } catch (e) {
            log.warn(`⚠️ [uguu.se] Lỗi: ${e.message}`);
        }

        // --- 3. CATBOX.MOE ---
        try {
            log.info(`◈ Đang upload file lên catbox.moe...`);
            const formCat = new FormData();
            formCat.append("reqtype", "fileupload");
            formCat.append("fileToUpload", fs.createReadStream(filePath));

            const responseCat = await axios.post("https://catbox.moe/user/api.php", formCat, {
                headers: formCat.getHeaders(),
                timeout: 30000
            });

            if (typeof responseCat.data === "string" && responseCat.data.startsWith("http")) {
                const url = responseCat.data.trim();
                log.info(`✅ [Catbox] Upload thành công: ${url}`);
                return url;
            }
        } catch (e) {
            log.warn(`⚠️ [Catbox] Lỗi: ${e.message}`);
        }

        // --- 4. TMPFILES.ORG ---
        try {
            log.info(`◈ Đang upload file lên tmpfiles.org...`);
            const formTmp = new FormData();
            formTmp.append("file", fs.createReadStream(filePath));

            const responseTmp = await axios.post("https://tmpfiles.org/api/v1/upload", formTmp, {
                headers: formTmp.getHeaders(),
                timeout: 20000
            });

            if (responseTmp.data?.data?.url) {
                const rawUrl = responseTmp.data.data.url.replace("tmpfiles.org/", "tmpfiles.org/dl/");
                log.info(`✅ [tmpfiles.org] Upload thành công: ${rawUrl}`);
                return rawUrl;
            }
        } catch (e) {
            log.warn(`⚠️ [tmpfiles.org] Lỗi: ${e.message}`);
        }

        throw new Error("Tất cả các máy chủ lưu trữ đều thất bại.");
    } catch (e) {
        log.error("[Upload] Error: ➔ Thất bại toàn tập.", e.message);
        return null;
    }
}
