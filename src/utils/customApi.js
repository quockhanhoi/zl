import { readFileSync, statSync, existsSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import axios from "axios";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import cryptojs from "crypto-js";

const fPath = (typeof ffmpegStatic === "object" && ffmpegStatic.path) ? ffmpegStatic.path : ffmpegStatic;
const fpPath = (typeof ffprobeStatic === "object" && ffprobeStatic.path) ? ffprobeStatic.path : ffprobeStatic;

ffmpeg.setFfmpegPath(fPath);
ffmpeg.setFfprobePath(fpPath);

function ensureRemoteFileExtension(fileUrl, ext) {
    if (!fileUrl) return fileUrl;
    if (new RegExp(`\\.${ext}(?:\\?|$)`, "i").test(fileUrl)) return fileUrl;
    if (fileUrl.includes("zalo.me") || fileUrl.includes("?")) {
        return `${fileUrl}${fileUrl.includes("?") ? "&" : "?"}ext=.${ext}`;
    }
    return `${fileUrl}/${Date.now()}.${ext}`;
}

// --- Inline crypto utils (tương thích api-zalo pattern) ---
function _encodeAES(secretKey, data, t = 0) {
    try {
        const key = cryptojs.enc.Base64.parse(secretKey);
        return cryptojs.AES.encrypt(data, key, {
            iv: cryptojs.enc.Hex.parse("00000000000000000000000000000000"),
            mode: cryptojs.mode.CBC,
            padding: cryptojs.pad.Pkcs7,
        }).ciphertext.toString(cryptojs.enc.Base64);
    } catch {
        return t < 3 ? _encodeAES(secretKey, data, t + 1) : null;
    }
}

function _decodeAES(secretKey, data, t = 0) {
    try {
        data = decodeURIComponent(data);
        const key = cryptojs.enc.Base64.parse(secretKey);
        return cryptojs.AES.decrypt(
            { ciphertext: cryptojs.enc.Base64.parse(data) },
            key,
            {
                iv: cryptojs.enc.Hex.parse("00000000000000000000000000000000"),
                mode: cryptojs.mode.CBC,
                padding: cryptojs.pad.Pkcs7,
            }
        ).toString(cryptojs.enc.Utf8);
    } catch {
        return t < 3 ? _decodeAES(secretKey, data, t + 1) : null;
    }
}

// Build utils object tương thích api-zalo apiFactory pattern
function buildUtils(api) {
    // Lấy context từ zca-js hoặc api-zalo
    const getCtx = () => {
        const ctx = api.getContext ? api.getContext() : (api.context || api.ctx || {});
        return ctx;
    };

    // Lấy secretKey động (đảm bảo luôn có giá trị mới nhất)
    const getSecretKey = () => {
        const ctx = getCtx();
        return ctx.secretKey || ctx.zpw_enk || api.secretKey;
    };

    // Lấy cookie string từ context
    const getCookieString = async (origin = "https://chat.zalo.me") => {
        const ctx = getCtx();
        if (!ctx.cookie) return "";
        if (typeof ctx.cookie.getCookieStringSync === "function") return ctx.cookie.getCookieStringSync(origin);
        if (typeof ctx.cookie.getCookieString === "function") return await ctx.cookie.getCookieString(origin);
        if (typeof ctx.cookie === "string") return ctx.cookie;
        return "";
    };

    return {
        encodeAES: (data, t) => _encodeAES(getSecretKey(), data, t),

        makeURL: (baseURL, params = {}) => {
            const url = new URL(baseURL);
            for (const [k, v] of Object.entries(params)) {
                url.searchParams.set(k, String(v));
            }
            return url.toString();
        },

        request: async (url, options = {}) => {
            const ctx = getCtx();
            const cookieStr = await getCookieString(new URL(url).origin);
            const headers = {
                "Accept": "application/json, text/plain, */*",
                "Accept-Encoding": "gzip, deflate, br",
                "Content-Type": "application/x-www-form-urlencoded",
                "Cookie": cookieStr,
                "Origin": "https://chat.zalo.me",
                "Referer": "https://chat.zalo.me/",
                "User-Agent": ctx.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
                ...(options.headers || {}),
            };
            return await fetch(url, { ...options, headers });
        },

        resolve: async (response, isEncrypted = true, mapper = null) => {
            const result = { data: null, error: null };
            if (!response.ok) {
                result.error = { message: "Request failed: " + response.status };
                return result;
            }
            try {
                // Nếu tham số thứ 2 là function, nó chính là mapper
                if (typeof isEncrypted === "function") {
                    mapper = isEncrypted;
                    isEncrypted = true;
                }

                const json = await response.json();
                if (json.error_code != 0) {
                    result.error = { message: json.error_message, code: json.error_code };
                    return result;
                }
                const decoded = isEncrypted ? JSON.parse(_decodeAES(getSecretKey(), json.data)) : json;
                if (decoded.error_code != 0) {
                    result.error = { message: decoded.error_message, code: decoded.error_code };
                    return result;
                }
                
                let finalData = decoded.data;
                if (typeof mapper === "function") {
                    finalData = mapper(decoded);
                }
                result.data = finalData;
            } catch (e) {
                result.error = { message: "Failed to parse response: " + e.message };
            }
            return result;
        },
    };
}

export function registerCustomApi(api, log) {
    const utils = buildUtils(api);

    const safeCustom = (name, fn) => {
        const wrapper = async (...args) => {
            const ctx = api.getContext ? api.getContext() : (api.context || api.ctx || {});

            // --- HÀM GIẢI MÃ DỮ LIỆU ĐỆ QUY (LỘT VỎ HÀNH) ---
            const extractProps = (input) => {
                if (!input || typeof input !== "object") return {};
                if (input.imei && input.cookie && !input.staticImgUrl && !input.stickerId && !input.threadId) return {};

                if (input.threadId || input.staticImgUrl || input.userId || input.videoPath || input.stickerId) return input;
                if (input.props && typeof input.props === "object") return extractProps(input.props);
                if (input.ctx && input.props) return extractProps(input.props);
                return input;
            };

            let props = {};
            let userArgs = args;

            // Nếu là call từ api-zalo custom(), args[0] là { ctx, utils, props }
            if (args.length === 1 && args[0] && args[0].ctx && args[0].utils && args[0].props !== undefined) {
                props = args[0].props || {};
                userArgs = [props];
            } else {
                // Call trực tiếp từ module: api.sendXxx({ ... })
                if (args.length > 0 && args[0] && args[0].imei && args[0].cookie) {
                    userArgs = args.slice(1);
                }

                if (userArgs.length === 1) {
                    const arg = userArgs[0];
                    if (typeof arg === "object" && arg !== null) {
                        props = extractProps(arg);
                    } else {
                        // Nếu là string/number, gán vào các key phổ biến để fallback
                        props = { 
                            keyword: arg, 
                            stickerId: arg, 
                            cateId: arg, 
                            userId: arg, 
                            threadId: arg,
                            content: arg,
                            imageUrl: arg,
                            videoPath: arg,
                            filePath: arg,
                            value: arg,
                            id: arg
                        };
                    }
                } else if (userArgs.length > 1) {
                    props = extractProps(userArgs.find(a => a && typeof a === "object" && (a.threadId || a.staticImgUrl || a.stickerId || a.props)) || userArgs[0]);
                }
            }

            try {
                return await fn({ ctx, utils, props, args: userArgs });
            } catch (e) {
                if (log) log.error(`[CustomAPI:${name}] Error: ${e.message}`);
                throw e;
            }
        };

        // Luôn ghi đè trực tiếp — tránh dùng api.custom() vì nó sẽ wrap thêm 1 lần nữa
        api[name] = wrapper;
    };

    // --- HELPER UNDO DATA EXTRACTOR ---
    api.getUndoData = (sentMsg) => {
        const list = [];
        const add = (obj) => {
            if (!obj || typeof obj !== "object") return;
            const mId = obj.msgId || obj.globalMsgId || obj.mid || obj.id;
            const cId = obj.cliMsgId || obj.mid || obj.id;
            if (mId) list.push({ msgId: String(mId), cliMsgId: String(cId || Date.now()) });
        };

        if (Array.isArray(sentMsg)) {
            sentMsg.forEach(add);
        } else if (sentMsg) {
            add(sentMsg);
            add(sentMsg.message);
            add(sentMsg.data);
            if (Array.isArray(sentMsg.attachment)) sentMsg.attachment.forEach(add);
            if (sentMsg.link) add(sentMsg.link);
        }
        return list;
    };

    // --- HELPER APIs ---
    api.reaction = async (icon, message, threadId, threadType) => {
        if (!message) return;
        
        // --- CHUẨN HÓA ĐỐI TƯỢNG MESSAGE (DEST) CHO addReaction ---
        let dest = message;
        
        // 1. Nếu là object từ Zalo trả về (khi gửi tin: { msgId, cliMsgId })
        if (message.msgId && !message.data) {
            dest = {
                data: message,
                threadId: threadId || message.threadId,
                type: threadType !== undefined ? threadType : (message.type !== undefined ? message.type : (message.grid ? 1 : 0))
            };
        }
        // 2. Nếu là object bao bọc (zca-js return: { message: { msgId... }, attachment: [] })
        else if (message.message && message.message.msgId && !message.data) {
            dest = {
                data: message.message,
                threadId: threadId || message.threadId,
                type: threadType !== undefined ? threadType : (message.type !== undefined ? message.type : (message.message.grid ? 1 : 0))
            };
        }
        // 3. Nếu là chuỗi ID (fallback) thì không hỗ trợ trực tiếp, cần object có data.msgId
        
        return api.addReaction(icon, dest).catch(() => {});
    };

    const base = api.zpwServiceMap?.other_contact?.[0] || "https://other-contact-wpa.chat.zalo.me";

    // --- HELPER ROBUST REQUEST ---
    const robustRequest = async (apiTool, endpoints, params, options = {}) => {
        const { zpw_ver = 680, zpw_type = 30, method = "POST", maxRetries = 2, name = "Request" } = options;

        if (!apiTool || typeof apiTool.encodeAES !== "function") {
            throw new Error(`[RobustRequest:${name}] Critical Error: api.encodeAES is missing.`);
        }

        const urls = Array.isArray(endpoints) ? endpoints : [endpoints];
        const enc = apiTool.encodeAES(JSON.stringify(params));

        for (let urlIdx = 0; urlIdx < urls.length; urlIdx++) {
            const baseUrl = urls[urlIdx];
            for (let i = 0; i <= maxRetries; i++) {
                try {
                    const finalUrl = apiTool.makeURL(baseUrl, { zpw_ver, zpw_type });
                    const res = await apiTool.request(finalUrl, {
                        method,
                        body: method === "POST" ? new URLSearchParams({ params: enc }) : undefined,
                        timeout: 15000
                    });
                    const result = await apiTool.resolve(res);

                    if (result && !result.error) return result;
                    if (result?.error?.code === 404) break;
                } catch (e) {
                    if (i < maxRetries) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
                }
            }
        }
        return null;
    };

    // --- VOICE APIs ---
    safeCustom("uploadVoice", async ({ ctx, utils, props }) => {
        const { filePath, threadId, threadType } = props;
        const results = await api.uploadAttachment([filePath], threadId, threadType);
        if (!results || results.length === 0) throw new Error("Upload attachment thất bại.");
        const result = results[0];
        return { voiceId: result.fileId, voiceUrl: result.fileUrl || result.url };
    });

    safeCustom("sendVoiceNative", async ({ ctx, utils, props }) => {
        let { voiceUrl, threadId, threadType, duration = 0, fileSize = 0, ttl = 1800000 } = props;
        const isGroup = String(threadType) === "1" || threadType === 1;
        const clientId = Date.now().toString();
        const msgInfo = { voiceUrl: String(voiceUrl), m4aUrl: String(voiceUrl), fileSize: Number(fileSize) || 0, duration: Number(duration) || 0 };
        const params = isGroup ? { grid: threadId.toString(), visibility: 0, ttl: Number(ttl), zsource: -1, msgType: 3, clientId, msgInfo: JSON.stringify(msgInfo), imei: ctx.imei }
            : { toId: threadId.toString(), ttl: Number(ttl), zsource: -1, msgType: 3, clientId, msgInfo: JSON.stringify(msgInfo), imei: ctx.imei };
        const serviceURL = isGroup ? `${api.zpwServiceMap.file[0]}/api/group/forward` : `${api.zpwServiceMap.file[0]}/api/message/forward`;
        const encryptedParams = utils.encodeAES(JSON.stringify(params));
        const response = await utils.request(utils.makeURL(serviceURL, { zpw_ver: 667, zpw_type: 24 }), { method: "POST", body: new URLSearchParams({ params: encryptedParams }) });
        return await utils.resolve(response);
    });

    safeCustom("sendVoiceUnified", async ({ ctx, utils, props }) => {
        const { filePath, threadId, threadType } = props;
        let finalPath = filePath;
        try {
            const metadata = await new Promise((resolve, reject) => { ffmpeg.ffprobe(finalPath, (err, meta) => err ? reject(err) : resolve(meta)); });
            const duration = Math.round((metadata.format.duration || 0) * 1000);
            const fileSize = metadata.format.size || statSync(finalPath).size;
            const uploadResults = await api.uploadAttachment([finalPath], threadId, threadType);
            if (!uploadResults || uploadResults.length === 0) throw new Error("Upload lên Zalo thất bại.");
            let remoteUrl = uploadResults[0].fileUrl || uploadResults[0].url;
            if (!remoteUrl.endsWith(".aac")) remoteUrl += `/${Date.now()}.aac`;
            try {
                return await api.sendVoiceNative({ voiceUrl: remoteUrl, duration, fileSize, threadId, threadType });
            } catch (err) {
                return await api.sendVoice({ voiceUrl: remoteUrl, ttl: 0 }, threadId, threadType);
            }
        } catch (err) {
            if (log) log.error(`[sendVoiceUnified] Lỗi: ${err.message}`);
            throw err;
        }
    });

    safeCustom("updatePersonalSticker", async ({ ctx, utils, props, args }) => {
        let cateIds, version = 0;
        if (args.length >= 1) {
            cateIds = args[0];
            version = args[1] || 0;
        } else {
            ({ cateIds, version = 0 } = props);
        }

        let ids = [];
        if (Array.isArray(cateIds)) {
            ids = cateIds.map((id) => parseInt(id)).filter((id) => !isNaN(id));
        } else if (cateIds !== undefined && cateIds !== null) {
            const parsed = parseInt(cateIds);
            if (!isNaN(parsed)) ids = [parsed];
        }

        const params = {
            version: Number(version),
            sticker_cates: ids,
            imei: ctx.imei
        };

        const stickerBaseUrl = api.zpwServiceMap?.sticker?.[0] || "https://tt-sticker-wpa.chat.zalo.me";
        const url = `${stickerBaseUrl}/api/message/sticker/personalized/update`;

        return await robustRequest(utils, [url], params, { method: "GET", name: "updatePersonalSticker" });
    });

    // --- PHOTO API ---
    safeCustom("sendImageEnhanced", async ({ ctx, utils, props }) => {
        const { imageUrl, threadId, threadType, width = 720, height = 1280, msg = "", mentions } = props;
        const isGroup = String(threadType) === "1" || threadType === 1;
        const payload = { clientId: Date.now().toString(), desc: msg, oriUrl: String(imageUrl), thumbUrl: String(imageUrl), hdUrl: String(imageUrl), normalUrl: String(imageUrl), url: String(imageUrl), width: Number(width), height: Number(height), zsource: -1, ttl: 0 };
        if (isGroup) { payload.grid = threadId.toString(); payload.visibility = 0; if (mentions) payload.mentionInfo = JSON.stringify(mentions); } else { payload.toId = threadId.toString(); }

        const fileEndpoints = api.zpwServiceMap?.file || ["https://tt-files-wpa.chat.zalo.me"];
        const urls = fileEndpoints.map(u => isGroup ? `${u}/api/group/photo_url` : `${u}/api/message/photo_url`);

        const result = await robustRequest(utils, urls, payload, { zpw_ver: 667, zpw_type: 24 });
        if (result && !result.error) return result;
        throw new Error(`[sendImageEnhanced] Request failed after all retries.`);
    });

    // --- STICKER API (Simplified) ---
    safeCustom("sendSticker", async ({ props, args }) => {
        let sticker, threadId, type, ttl = 0;
        if (args.length >= 2) {
            [sticker, threadId, type, ttl = 0] = args;
        } else {
            const s = props.sticker || props;
            sticker = { id: s.id || s.stickerId, cateId: s.cateId, type: s.type || s.stickerType || 1 };
            threadId = props.threadId;
            type = props.threadType || props.type || 0;
            ttl = props.ttl || 0;
        }
        return await api.sendSticker(sticker, threadId, type, ttl);
    });

    safeCustom("searchSticker", async ({ ctx, utils, props }) => {
        const { keyword, limit = 50 } = props;
        const u = utils || api.utils || ctx?.utils || (api.getContext && api.getContext().utils);
        if (!u) {
            throw new Error("Utils not found in context for searchSticker");
        }
        const params = { keyword: String(keyword), limit: Number(limit), srcType: 0, imei: ctx?.imei || (api.getContext && api.getContext().imei) };
        const encryptedParams = u.encodeAES(JSON.stringify(params));
        const url = "https://tt-sticker-wpa.chat.zalo.me/api/message/sticker/search";
        const res = await u.request(u.makeURL(url, { zpw_ver: 678, zpw_type: 30, params: encryptedParams }));
        return await u.resolve(res);
    });

    safeCustom("findSticker", async ({ ctx, utils, props }) => {
        const { keyword } = props;
        const u = utils;
        if (!u) throw new Error("Utils not found in context");
        const params = { keyword: String(keyword), gif: 1, guggy: 0, imei: ctx?.imei || api.context?.imei };
        const encryptedParams = u.encodeAES(JSON.stringify(params));
        const url = "https://tt-sticker-wpa.chat.zalo.me/api/message/sticker/suggest/stickers";
        const res = await u.request(u.makeURL(url, { zpw_ver: 678, zpw_type: 30, params: encryptedParams }));
        return await u.resolve(res);
    });

    safeCustom("getStickerDetail", async ({ ctx, utils, props }) => {
        const { stickerId } = props;
        const u = utils;
        if (!u) throw new Error("Utils not found in context");
        const params = { sid: Number(stickerId) };
        const encryptedParams = u.encodeAES(JSON.stringify(params));
        const url = "https://tt-sticker-wpa.chat.zalo.me/api/message/sticker/sticker_detail";
        const res = await u.request(u.makeURL(url, { zpw_ver: 645, zpw_type: 30, params: encryptedParams }));
        return await u.resolve(res);
    });

    safeCustom("getStickerCategory", async ({ ctx, utils, props }) => {
        const { cateId } = props;
        const u = utils;
        if (!u) throw new Error("Utils not found in context");
        const params = { cid: Number(cateId) };
        const encryptedParams = u.encodeAES(JSON.stringify(params));
        const url = "https://tt-sticker-wpa.chat.zalo.me/api/message/sticker/category/sticker_detail";
        const res = await u.request(u.makeURL(url, { zpw_ver: 645, zpw_type: 30, params: encryptedParams }));
        return await u.resolve(res);
    });

    safeCustom("sendNativeSticker", async ({ ctx, utils, props, args }) => {
        let { staticImgUrl, rawWebpUrl, threadId, threadType, width, height, ai = false, reply } = props;
        
        // Fallback robust
        if (!threadId) threadId = props.threadId || ctx.threadId;
        if (threadType === undefined || threadType === null) threadType = props.threadType || ctx.type || ctx.threadType || 0;
        if (!staticImgUrl) staticImgUrl = props.staticUrl || props.url;
        if (!rawWebpUrl) rawWebpUrl = props.animationImgUrl || staticImgUrl;

        const mockMessage = { type: threadType, threadId: threadId, data: {} };
        if (reply) mockMessage.data.quote = { cliMsgId: reply };

        return await api.sendCustomSticker(mockMessage, staticImgUrl, rawWebpUrl, width, height, 0, !ai);
    });

    safeCustom("getCloudAIStickers", async ({ ctx, utils, props }) => {
        const { sessionKey, cloudViewerKey } = props;
        const api_key = "3bb9d514148ca6dd16ba88d6bff387bf";
        const url = `https://zcld.chat.zalo.me/zcloud-ai-index/ack/v1/indexed-items?api_key=${api_key}&call_id=${Date.now()}&client_type=2&client_version=704&error_code_fallback=1&session_key=${sessionKey}&v=3.0`;

        const response = await axios.get(url, {
            headers: {
                "Host": "zcld.chat.zalo.me",
                "Cookie": `session_key=${sessionKey}; api_key=${api_key}`,
                "User-Agent": "Zalo/260302 (iPhone; iOS 26.4; Scale/3.00)",
                "cloud-viewer-key": cloudViewerKey,
                "accept": "*/*",
                "accept-encoding": "gzip"
            }
        });

        return response.data;
    });

    // --- HELPER APIs ---
    api.undo = async (undoData, tId, tType) => {
        const results = await api.undoMessage(undoData, tId, tType).catch(e => null);
        const msgId = Array.isArray(undoData) ? undoData[0]?.msgId : undoData?.msgId;
        const res = results?.[0];
        if (res && res.status === 0) {
            console.log(`[UNDO_SUCCESS] msgId: ${msgId} | Result: OK`);
            return results;
        }
        // Throw để cho caller (thuhoi.js) biết mà fallback sang deleteMessage
        throw new Error(`Undo failed for msgId: ${msgId}`);
    };
    safeCustom("markAsRead", async ({ ctx, utils, props }) => {
        const { msgId, cliMsgId, senderId, threadId, threadType, method = "webchat" } = props;
        const isGroup = String(threadType) === "1" || threadType === 1 || String(threadType).toUpperCase() === "GROUP";
        const dest = isGroup ? String(threadId) : "0";
        const entry = { cmi: String(cliMsgId), gmi: String(msgId), si: String(senderId), di: dest, mt: method, st: 3, ts: String(Date.now()) };
        const info = { data: [entry] };
        const payload = { msgInfos: JSON.stringify(info), imei: ctx.imei };
        let url = "https://tt-chat1-wpa.chat.zalo.me/api/message/seenv2";
        if (!isGroup) {
            entry.at = 7;
            entry.cmd = 501;
            payload.senderId = dest;
        } else {
            url = "https://tt-group-wpa.chat.zalo.me/api/group/seenv2";
            entry.at = 0;
            entry.cmd = 511;
            payload.grid = dest;
        }
        const enc = utils.encodeAES(JSON.stringify(payload));
        const res = await utils.request(utils.makeURL(url, { zpw_ver: 645, zpw_type: 30, nretry: 0 }), { method: "POST", body: new URLSearchParams({ params: enc }) });
        return await utils.resolve(res);
    });

    safeCustom("setTyping", async ({ ctx, utils, props }) => {
        const { threadId, threadType } = props;
        const isGroup = String(threadType) === "1" || threadType === 1;
        const payload = { imei: ctx.imei };
        let url = "https://tt-chat1-wpa.chat.zalo.me/api/message/typing";
        if (!isGroup) {
            payload.toid = String(threadId);
            payload.destType = 3;
        } else {
            url = "https://tt-group-wpa.chat.zalo.me/api/group/typing";
            payload.grid = String(threadId);
        }
        const enc = utils.encodeAES(JSON.stringify(payload));
        const res = await utils.request(utils.makeURL(url, { zpw_ver: 645, zpw_type: 30 }), { method: "POST", body: new URLSearchParams({ params: enc }) });
        return await utils.resolve(res);
    });

    safeCustom("blockUser", async ({ ctx, utils, props }) => {
        const { userId } = props;
        const url = "https://tt-friend-wpa.chat.zalo.me/api/friend/block";
        const payload = { fid: String(userId), imei: ctx.imei };
        const enc = utils.encodeAES(JSON.stringify(payload));
        const res = await utils.request(utils.makeURL(url, { zpw_ver: 645, zpw_type: 30 }), { method: "POST", body: new URLSearchParams({ params: enc }) });
        return await utils.resolve(res);
    });

    safeCustom("unblockUser", async ({ ctx, utils, props }) => {
        const { userId } = props;
        const url = "https://tt-friend-wpa.chat.zalo.me/api/friend/unblock";
        const payload = { fid: String(userId), imei: ctx.imei };
        const enc = utils.encodeAES(JSON.stringify(payload));
        const res = await utils.request(utils.makeURL(url, { zpw_ver: 645, zpw_type: 30 }), { method: "POST", body: new URLSearchParams({ params: enc }) });
        return await utils.resolve(res);
    });

    safeCustom("addFriend", async ({ props }) => {
        const { userId, msg = "Hello", language = "vi" } = props;
        return await api.sendFriendRequest(userId, msg, language);
    });

    safeCustom("setAlias", async ({ ctx, utils, props }) => {
        const { userId, alias } = props;
        const payload = { friendId: String(userId), alias, imei: ctx.imei };
        const enc = utils.encodeAES(JSON.stringify(payload));
        const url = "https://tt-alias-wpa.chat.zalo.me/api/alias/update";
        const res = await utils.request(utils.makeURL(url, { zpw_ver: 677, zpw_type: 30, params: enc }));
        return await utils.resolve(res);
    });

    safeCustom("sendReport", async ({ ctx, utils, props }) => {
        const { userId, reason = 0, content = "" } = props;
        const payload = { idTo: String(userId), objId: "person.profile", reason: String(reason) };
        if (content) payload.content = content;
        const enc = utils.encodeAES(JSON.stringify(payload));
        const url = "https://tt-profile-wpa.chat.zalo.me/api/report/abuse-v2";
        const res = await utils.request(utils.makeURL(url, { zpw_ver: 645, zpw_type: 30 }), { method: "POST", body: new URLSearchParams({ params: enc }) });
        return await utils.resolve(res);
    });

    safeCustom("sendBusinessCard", async ({ ctx, utils, props }) => {
        const { userId, qrCodeUrl, threadId, threadType, phone = "", ttl = 0 } = props;
        const isGroup = String(threadType) === "1" || threadType === 1;
        const msgInfo = { contactUid: String(userId), qrCodeUrl: String(qrCodeUrl) };
        if (phone) msgInfo.phone = String(phone);
        const payload = { ttl: Number(ttl), msgType: 6, clientId: String(Date.now()), msgInfo: JSON.stringify(msgInfo) };
        let url = "https://tt-files-wpa.chat.zalo.me/api/message/forward";
        if (isGroup) {
            url = "https://tt-files-wpa.chat.zalo.me/api/group/forward";
            payload.grid = String(threadId);
            payload.visibility = 0;
        } else {
            payload.toId = String(threadId);
            payload.imei = ctx.imei;
        }
        const enc = utils.encodeAES(JSON.stringify(payload));
        const res = await utils.request(utils.makeURL(url, { zpw_ver: 645, zpw_type: 30, nretry: 0 }), { method: "POST", body: new URLSearchParams({ params: enc }) });
        return await utils.resolve(res);
    });

    safeCustom("sendCardBank", async ({ ctx, utils, props }) => {
        const { bankNum, nameAccBank, bankName, threadId, threadType } = props;
        const isGroup = String(threadType) === "1" || threadType === 1;
        const msgInfo = {
            bankNum: String(bankNum),
            nameAccBank: String(nameAccBank),
            bankName: String(bankName),
            type: "bank"
        };
        const payload = {
            clientId: String(Date.now()),
            msgType: 11,
            msgInfo: JSON.stringify(msgInfo)
        };
        let url = isGroup ? "https://tt-files-wpa.chat.zalo.me/api/group/forward" : "https://tt-files-wpa.chat.zalo.me/api/message/forward";
        if (isGroup) {
            payload.grid = String(threadId);
            payload.visibility = 0;
        } else {
            payload.toId = String(threadId);
        }
        const enc = utils.encodeAES(JSON.stringify(payload));
        const res = await utils.request(utils.makeURL(url, { zpw_ver: 645, zpw_type: 30 }), { method: "POST", body: new URLSearchParams({ params: enc }) });
        return await utils.resolve(res);
    });

    safeCustom("sendMultiReaction", async ({ ctx, utils, props }) => {
        const { msgId, cliMsgId, reactionIcon, threadId, threadType, reactionType = 1, numReact = 1 } = props;
        const isGroup = String(threadType) === "1" || threadType === 1;
        const rMsgItem = { gMsgID: Number(msgId), cMsgID: Number(cliMsgId) };
        const rMsgs = Array(Number(numReact)).fill(rMsgItem);
        const msg = { rMsg: rMsgs, rIcon: String(reactionIcon), rType: Number(reactionType), source: 6 };
        const payload = { react_list: [{ message: JSON.stringify(msg), clientId: Date.now() }], imei: ctx.imei };
        let url = isGroup ? "https://reaction.chat.zalo.me/api/group/reaction" : "https://reaction.chat.zalo.me/api/message/reaction";
        if (isGroup) {
            payload.grid = String(threadId);
        } else {
            payload.toid = String(threadId);
        }
        const enc = utils.encodeAES(JSON.stringify(payload));
        const res = await utils.request(utils.makeURL(url, { zpw_ver: 647, zpw_type: 30 }), { method: "POST", body: new URLSearchParams({ params: enc }) });
        return await utils.resolve(res);
    });

    safeCustom("sendBusinessCard", async ({ props }) => {
        const { userId, threadId, threadType, phone = "", ttl = 0 } = props;
        return await api.sendBusinessCard(null, userId, phone, threadType, threadId, ttl);
    });

    // --- NEW APIs FROM PYTHON VERSION ---

    safeCustom("getQRLink", async ({ props }) => {
        return await api.getQRLink(props.userId);
    });

    safeCustom("removeBlockedMember", async ({ ctx, utils, props }) => {
        const { threadId, memberIds } = props;
        const url = "https://tt-group-wpa.chat.zalo.me/api/group/blockedmems/remove";
        const payload = { grid: String(threadId), members: Array.isArray(memberIds) ? memberIds.map(String) : [String(memberIds)] };
        const enc = utils.encodeAES(JSON.stringify(payload));
        const res = await utils.request(utils.makeURL(url, { zpw_ver: 650, zpw_type: 30 }), { method: "POST", body: new URLSearchParams({ params: enc }) });
        return await utils.resolve(res);
    });

    safeCustom("getBlockedMembers", async ({ ctx, utils, props }) => {
        const { threadId, page = 1, count = 50 } = props;
        const url = "https://tt-group-wpa.chat.zalo.me/api/group/blockedmems/list";
        const payload = { grid: String(threadId), page: Number(page), count: Number(count) };
        const enc = utils.encodeAES(JSON.stringify(payload));
        const res = await utils.request(utils.makeURL(url, { zpw_ver: 650, zpw_type: 30, params: enc }));
        return await utils.resolve(res);
    });

    safeCustom("checkGroupInfo", async ({ ctx, utils, props }) => {
        const { link } = props;
        const url = "https://tt-group-wpa.chat.zalo.me/api/group/link/ginfo";
        const payload = { link, avatar_size: 120, member_avatar_size: 120, mpage: 1 };
        const enc = utils.encodeAES(JSON.stringify(payload));
        const res = await utils.request(utils.makeURL(url, { zpw_ver: 650, zpw_type: 30, params: enc }));
        return await utils.resolve(res);
    });

    safeCustom("unfriendUser", async ({ ctx, utils, props }) => {
        const { userId } = props;
        const url = "https://tt-friend-wpa.chat.zalo.me/api/friend/unfriend";
        const payload = { fid: String(userId) };
        const enc = utils.encodeAES(JSON.stringify(payload));
        const res = await utils.request(utils.makeURL(url, { zpw_ver: 641, zpw_type: 30 }), { method: "POST", body: new URLSearchParams({ params: enc }) });
        return await utils.resolve(res);
    });

    safeCustom("sendGroupCall", async ({ ctx, utils, props }) => {
        const { threadId, userIds, callId } = props;
        const cId = callId || Math.floor(Math.random() * 1000000000).toString();
        const url = "https://voicecall-wpa.chat.zalo.me/api/voicecall/group/request";
        const payload = {
            callId: String(cId),
            partners: Array.isArray(userIds) ? userIds.map(String) : [String(userIds)],
            groupId: String(threadId),
            codec: '[{"dynamicFptime":0,"frmPtime":20,"name":"opus/16000/1","payload":112}]',
            typeRequest: 1,
            imei: ctx.imei
        };
        const enc = utils.encodeAES(JSON.stringify(payload));
        const res = await utils.request(utils.makeURL(url, { zpw_ver: 646, zpw_type: 24 }), { method: "POST", body: new URLSearchParams({ params: enc }) });
        return await utils.resolve(res);
    });

    // --- VIDEO API ---
    safeCustom("sendVideoEnhanced", async ({ ctx, utils, props }) => {
        let { videoUrl, thumbnailUrl, duration = 0, width = 720, height = 1280, fileSize, msg, mentions, threadId, threadType } = props;
        if (!threadId) threadId = props.threadId || ctx.threadId;
        if (!threadType) threadType = props.threadType || ctx.type || ctx.threadType;
        if (!threadId) throw new Error("Missing threadId");

        const isGroup = String(threadType) === "1" || threadType === 1;
        const clientId = Date.now();

        const cleanDuration = Math.max(1, Math.floor(Number(duration) || 0));
        const cleanWidth = Math.max(1, Math.floor(Number(width) || 720));
        const cleanHeight = Math.max(1, Math.floor(Number(height) || 1280));
        const cleanFileSize = Math.max(1, Math.floor(Number(fileSize) || 0));

        const msgInfo = JSON.stringify({
            videoUrl: String(videoUrl),
            thumbUrl: String(thumbnailUrl || ""),
            duration: cleanDuration,
            width: cleanWidth,
            height: cleanHeight,
            fileSize: cleanFileSize,
            properties: { color: -1, size: -1, type: 1003, subType: 0, ext: { sSrcType: -1, sSrcStr: "", msg_warning_type: 0 } },
            title: String(msg || "")
        });

        const params = isGroup ? {
            grid: String(threadId),
            visibility: 0,
            clientId: String(clientId),
            ttl: 0,
            zsource: 704,
            msgType: 5,
            msgInfo,
            imei: ctx.imei
        } : {
            toId: String(threadId),
            clientId: String(clientId),
            ttl: 0,
            zsource: 704,
            msgType: 5,
            msgInfo,
            imei: ctx.imei,
            title: String(msg || "")
        };

        if (isGroup && mentions) params.mentionInfo = JSON.stringify(mentions);

        const fileEndpoints = api.zpwServiceMap?.file || ["https://tt-files-wpa.chat.zalo.me"];
        const urls = fileEndpoints.map(u => isGroup ? `${u}/api/group/forward` : `${u}/api/message/forward`);

        const result = await robustRequest(utils, urls, params, { zpw_ver: 645, zpw_type: 30 });
        if (result && !result.error) return result;

        // Fallback: Gửi như link đính kèm nếu forward tèo
        return await api.sendMessage({ msg: (msg || "") + "\n" + videoUrl }, threadId, threadType);
    });

    safeCustom("sendVideoUnified", async ({ ctx, utils, props }) => {
        let videoPath, thumbnailUrl, thumbnailPath, msg, threadId, threadType;
        if (Array.isArray(props)) {
            [videoPath, thumbnailUrl, thumbnailPath, msg, threadId, threadType] = props;
        } else {
            ({ videoPath, thumbnailUrl, thumbnailPath, msg, threadId, threadType } = props);
        }

        // Cố gắng fallback threadId/threadType nếu vẫn bị thiếu
        if (!threadId) threadId = props.threadId || (Array.isArray(props) ? props[4] : null) || ctx.threadId;
        if (!threadType) threadType = props.threadType || (Array.isArray(props) ? props[5] : null) || ctx.type || ctx.threadType;

        if (!videoPath) throw new Error("No videoPath provided");
        if (!threadId) {
            if (log) log.error(`[sendVideoUnified] Missing threadId.`);
            throw new Error("Missing threadId");
        }

        const thumbDir = path.join(process.cwd(), "src/modules/cache");
        if (!existsSync(thumbDir)) mkdirSync(thumbDir, { recursive: true });

        let uploadPath = videoPath;
        const remuxPath = path.join(thumbDir, `remux_${Date.now()}.mp4`);

        try {
            const metadata = await new Promise((resolve, reject) => {
                ffmpeg.ffprobe(videoPath, (err, meta) => err ? reject(err) : resolve(meta));
            });
            const vStream = metadata.streams.find(s => s.codec_type === 'video');
            const aStream = metadata.streams.find(s => s.codec_type === 'audio');
            const durationMs = Math.max(0, Math.round(Number(metadata.format.duration || 0) * 1000));
            const width = vStream?.width || 720;
            const height = vStream?.height || 1280;
            let fileSize = metadata.format.size || statSync(videoPath).size;

            const isHEVC = vStream?.codec_name === "hevc" || vStream?.codec_tag_string === "hvc1";
            const isNotAAC = aStream && aStream.codec_name !== "aac";

            await new Promise((resolve) => {
                let f = ffmpeg(videoPath);
                if (isHEVC || isNotAAC) {
                    f = f.videoCodec("libx264").audioCodec("aac").outputOptions(["-pix_fmt yuv420p", "-preset fast", "-crf 23", "-b:a 128k"]);
                } else {
                    f = f.outputOptions(["-c:v copy", "-c:a copy"]);
                }
                f.outputOptions(["-movflags +faststart", "-y"]).output(remuxPath).on("end", resolve).on("error", () => resolve()).run();
            });

            if (existsSync(remuxPath) && statSync(remuxPath).size > 100) {
                uploadPath = remuxPath;
                fileSize = statSync(remuxPath).size;
            }

            if (fileSize > 50 * 1024 * 1024) {
                let finalUploadPath = uploadPath;
                if (path.basename(uploadPath).startsWith("remux")) {
                    const renamedPath = path.join(path.dirname(uploadPath), `Video_HD_${Date.now()}.mp4`);
                    try {
                        fs.renameSync(uploadPath, renamedPath);
                        finalUploadPath = renamedPath;
                    } catch (e) {}
                }
                return await api.sendMessage({ msg: msg || "", attachments: [finalUploadPath] }, threadId, threadType);
            }

            const uploadResults = await api.uploadAttachment([uploadPath], threadId, threadType);
            if (!uploadResults || uploadResults.length === 0) throw new Error("Upload Video thất bại.");

            const videoUrl = uploadResults[0].fileUrl || uploadResults[0].url;
            let resolvedThumbnailUrl = thumbnailUrl;

            if (!resolvedThumbnailUrl && thumbnailPath && existsSync(thumbnailPath)) {
                try {
                    const uploadedThumb = await api.uploadAttachment([thumbnailPath], threadId, threadType);
                    resolvedThumbnailUrl = uploadedThumb?.[0]?.fileUrl || uploadedThumb?.[0]?.url;
                } catch (e) { }
            }

            if (!resolvedThumbnailUrl) {
                const generatedThumbPath = path.join(thumbDir, `vthumb_${Date.now()}.jpg`);
                try {
                    await new Promise((resolve, reject) => {
                        ffmpeg(uploadPath).on("end", resolve).on("error", reject).screenshots({ count: 1, timemarks: ["0.0"], filename: path.basename(generatedThumbPath), folder: path.dirname(generatedThumbPath), size: "640x?", fastSeek: true });
                    });
                    if (existsSync(generatedThumbPath)) {
                        const uploadedThumb = await api.uploadAttachment([generatedThumbPath], threadId, threadType);
                        resolvedThumbnailUrl = uploadedThumb?.[0]?.fileUrl || uploadedThumb?.[0]?.url;
                    }
                } catch (err) { } finally { try { if (existsSync(generatedThumbPath)) unlinkSync(generatedThumbPath); } catch { } }
            }

            if (!resolvedThumbnailUrl) resolvedThumbnailUrl = "https://photo-stal-17.zdn.vn/gr/jpg/f288c96bd87e1920406f/1321651193041366091.jpg";

            const sendRes = await api.sendVideoEnhanced({ videoUrl, thumbnailUrl: resolvedThumbnailUrl, duration: durationMs, width, height, fileSize, msg, threadId, threadType });
            
            // Nếu sendVideoEnhanced lỗi (hiếm), gửi link trực tiếp kèm message
            if (!sendRes || sendRes.error) {
                 return await api.sendMessage({ msg: (msg || "") + "\n" + videoUrl }, threadId, threadType);
            }
            return sendRes;

        } catch (e) {
            if (log) log.error(`[sendVideoUnified] Lỗi: ${e.message}`);
            return await api.sendMessage({ msg: msg || "", attachments: [uploadPath] }, threadId, threadType);
        } finally {
            try { if (existsSync(remuxPath)) unlinkSync(remuxPath); } catch { }
        }
    });

    safeCustom("sendVideoDirect", async ({ ctx, utils, props }) => {
        const { videoUrl, thumbnailUrl, msg, threadId, threadType, ttl = 0, mention } = props;
        const isGroup = String(threadType) === "1" || threadType === 1;
        let fileSize = 0, duration = 0, width = 720, height = 1280;

        try {
            await new Promise((resolve, reject) => {
                ffmpeg.ffprobe(videoUrl, (err, metadata) => {
                    if (err) return reject(err);
                    const stream = metadata.streams.find(s => s.codec_type === 'video') || metadata.streams[0];
                    duration = Math.floor((stream.duration || metadata.format?.duration || 0) * 1000);
                    width = stream.width || 720;
                    height = stream.height || 1280;
                    fileSize = metadata.format?.size || 0;
                    resolve();
                });
            });
        } catch (error) { }

        const payload = {
            clientId: String(Date.now()),
            ttl: ttl,
            zsource: 704,
            msgType: 5,
            msgInfo: JSON.stringify({ videoUrl: String(videoUrl), thumbUrl: String(thumbnailUrl || ""), duration, width, height, fileSize, properties: { color: -1, size: -1, type: 1003, subType: 0, ext: { sSrcType: -1, sSrcStr: "", msg_warning_type: 0 } }, title: msg || "" })
        };
        if (msg && mention) payload.mentionInfo = mention;
        if (isGroup) { payload.visibility = 0; payload.grid = String(threadId); }
        else { payload.toId = String(threadId); }

        const enc = utils.encodeAES(JSON.stringify(payload));
        const serviceURL = isGroup ? `${api.zpwServiceMap.file[0]}/api/group/forward` : `${api.zpwServiceMap.file[0]}/api/message/forward`;
        const res = await utils.request(utils.makeURL(serviceURL, { zpw_ver: 645, zpw_type: 30 }), { method: "POST", body: new URLSearchParams({ params: enc }) });
        return await utils.resolve(res);
    });

    safeCustom("sendCall", async ({ ctx, utils, props }) => {
        const { targetId, callId } = props;
        const imei = ctx.imei;
        const payload1 = { calleeId: String(targetId), callId: String(callId), codec: "[]\n", typeRequest: 1, imei: imei };
        const enc1 = utils.encodeAES(JSON.stringify(payload1));
        await utils.request("https://voicecall-wpa.chat.zalo.me/api/voicecall/requestcall?zpw_ver=646&zpw_type=24", { method: "POST", body: new URLSearchParams({ params: enc1 }) });
        const payload2 = { calleeId: String(targetId), rtcpAddress: "171.244.25.88:4601", rtpAddress: "171.244.25.88:4601", codec: '[{"dynamicFptime":0,"frmPtime":20,"name":"opus/16000/1","payload":112}]\n', session: String(callId), callId: String(callId), imei: imei, subCommand: 3 };
        const enc2 = utils.encodeAES(JSON.stringify(payload2));
        const res = await utils.request("https://voicecall-wpa.chat.zalo.me/api/voicecall/request?zpw_ver=646&zpw_type=24", { method: "POST", body: new URLSearchParams({ params: enc2 }) });
        return await utils.resolve(res);
    });

    safeCustom("getStickersEnhanced", async ({ ctx, utils, props }) => {
        const { keyword } = props;
        const params = { keyword, gif: 1, guggy: 0, imei: ctx.imei };
        const enc = utils.encodeAES(JSON.stringify(params));
        const res = await utils.request(utils.makeURL(`${api.zpwServiceMap.sticker}/api/message/sticker/suggest/stickers`, { params: enc }));
        return await utils.resolve(res, (result) => (result.data?.sugg_sticker || []).map(s => ({ id: s.sticker_id, cateId: s.cate_id, type: s.type })));
    });

    safeCustom("callOneUser", async ({ ctx, utils, props }) => {
        const { userId, groupId, groupName, typeRequest = 1 } = props;
        const url = utils.makeURL("https://voicecall-wpa.chat.zalo.me/api/message/call", { zpw_ver: 667, zpw_type: 24 });
        const p1 = { [groupId ? "groupId" : "toId"]: String(groupId || userId), chatType: groupId ? "group" : "user", typeRequest: Number(typeRequest) || 1, imei: ctx.imei, clientId: Date.now() };
        const enc1 = utils.encodeAES(JSON.stringify(p1));
        const res1 = await utils.request(url, { method: "POST", body: new URLSearchParams({ params: enc1 }) });
        const d1 = await utils.resolve(res1);
        if (d1.error) throw new Error(d1.error.message || "Lỗi yêu cầu gọi");
        let pData = {}; try { pData = typeof d1.params === 'string' ? JSON.parse(d1.params) : d1.params || {}; } catch { }
        const srvs = pData.callSetting?.servers || d1.servers || [];
        const sess = pData.callSetting?.session || d1.session || "";
        if (!sess || srvs.length === 0) throw new Error(`Zalo denied permission (Status: ${d1.status})`);
        const pIds = d1.partnerIds?.[0] ? String(d1.partnerIds[0]) : String(userId);
        const p2 = { callId: pData.callId || d1.callId, callType: 1, data: JSON.stringify({ codec: "", data: JSON.stringify({ groupAvatar: "", groupName: groupName || "Zalo Call", hostCall: pData.hostCall || "", maxUsers: 8, noiseId: [pIds] }), extendData: "", rtcpAddress: srvs[0].rtcpaddr || "", rtcpAddressIPv6: srvs[0].rtcpaddrIPv6 || "", rtpAddress: srvs[0].rtpaddr || "", rtpAddressIPv6: srvs[0].rtpaddrIPv6 || "", }), session: sess, partners: JSON.stringify([pIds]), groupId: String(groupId || userId) };
        const enc2 = utils.encodeAES(JSON.stringify(p2));
        const res2 = await utils.request(url, { method: "POST", body: new URLSearchParams({ params: enc2 }) });
        return await utils.resolve(res2);
    });

    // --- GROUP PENDING & INVITE APIs ---
    safeCustom("getGroupInvites", async () => {
        return await api.getGroupInviteBoxList();
    });

    safeCustom("handleGroupInvite", async ({ args, props }) => {
        const groupId = args[0] || props.groupId;
        const isApprove = args[1] !== undefined ? !!args[1] : true;
        if (isApprove) return await api.joinGroupInviteBox(groupId);
        return await api.deleteGroupInviteBox(groupId);
    });
}
