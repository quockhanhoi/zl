import { appContext } from "../context.js";
import { Zalo, ZaloApiError } from "../index.js";
import { MessageType } from "../models/Message.js";
import { encodeAES, handleZaloResponse, makeURL, request } from "../utils.js";

export function sendCustomStickerFactory(api) {
  let fileHost = api.zpwServiceMap.file[0];
  if (fileHost.includes("zfcloud.zdn.vn")) {
    fileHost = fileHost.replace(/f\d+-zfcloud\.zdn\.vn/g, "f37-zfcloud.zdn.vn");
  }

  const directMessageServiceURL = makeURL(`${fileHost}/api/message/photo_url`, {
    zpw_ver: Zalo.API_VERSION,
    zpw_type: Zalo.API_TYPE,
    nretry: "0",
  });
  const groupMessageServiceURL = makeURL(`${fileHost}/api/group/photo_url`, {
    zpw_ver: Zalo.API_VERSION,
    zpw_type: Zalo.API_TYPE,
    nretry: "0",
  });
  /**
   * Gửi sticker tùy chỉnh (static/animation) đến một cuộc trò chuyện
   *
   * @param {Message} message Tin nhắn để gửi sticker
   * @param {string} staticImgUrl URL ảnh tĩnh (png, jpg, jpeg) để tạo sticker
   * @param {string} animationImgUrl URL ảnh động (webp) để tạo sticker
   * @param {number} [width] Chiều rộng của sticker
   * @param {number} [height] Chiều cao của sticker
   * @param {number} [ttl=0] Thời gian tồn tại của tin nhắn
   * @param {boolean} [noAI=false] Nếu true, không gửi thuộc tính jcp (pStickerType)
   * @throws {ZaloApiError}
   */
  return async function sendCustomSticker(message, staticImgUrl, animationImgUrl, width = null, height = null, ttl = 0, noAI = false) {
    // Support object-style calls: api.sendCustomSticker({ staticImgUrl, animationImgUrl, threadId, threadType, ... })
    if (message && typeof message === "object" && message.staticImgUrl) {
      const o = message;
      staticImgUrl = o.staticImgUrl;
      animationImgUrl = o.animationImgUrl || o.staticImgUrl;
      width = o.width || width;
      height = o.height || height;
      ttl = o.ttl ?? ttl;
      noAI = o.ai ? false : true;
      const threadType = (o.threadType === 1 || o.threadType === "1") ? MessageType.GroupMessage : MessageType.DirectMessage;
      message = { type: threadType, threadId: o.threadId, data: { quote: o.quote } };
    }

    if (!appContext.secretKey) throw new ZaloApiError("Secret key is not available");
    if (!appContext.imei) throw new ZaloApiError("IMEI is not available");
    if (!appContext.cookie) throw new ZaloApiError("Cookie is not available");
    if (!appContext.userAgent) throw new ZaloApiError("User agent is not available");
    if (!staticImgUrl) throw new ZaloApiError("Missing static image URL");
    if (!animationImgUrl) throw new ZaloApiError("Missing animation image URL");
    if (!message) throw new ZaloApiError("Missing message");

    const type = message.type;
    const threadId = message.threadId;
    const quote = message.data?.quote;

    width = width ? parseInt(width) : 512;
    height = height ? parseInt(height) : 512;
    const isGroupMessage = type === MessageType.GroupMessage;

    const params = {
      clientId: Date.now(),
      title: "",
      oriUrl: staticImgUrl,
      thumbUrl: staticImgUrl,
      hdUrl: staticImgUrl,
      width,
      height,
      properties: JSON.stringify({
        subType: 0,
        color: -1,
        size: -1,
        type: 3,
        ext: JSON.stringify({
          sSrcStr: "@STICKER",
          sSrcType: 0,
        }),
      }),
      contentId: Date.now(),
      thumb_height: width,
      thumb_width: height,
      webp: JSON.stringify({
        width,
        height,
        url: animationImgUrl,
      }),
      zsource: -1,
      ttl,
    };

    // Chỉ thêm jcp nếu không có noAI
    if (!noAI) {
      params.jcp = JSON.stringify({
        pStickerType: (message && typeof message === "object" ? message.pStickerType : null) || (animationImgUrl !== staticImgUrl ? 2 : 1),
      });
    }

    if (quote) {
      params.refMessage = quote.cliMsgId.toString();
    }

    if (isGroupMessage) {
      params.visibility = 0;
      params.grid = threadId.toString();
    } else {
      params.toId = threadId.toString();
    }

    const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
    if (!encryptedParams) throw new ZaloApiError("Failed to encrypt message");

    const finalServiceUrl = new URL(isGroupMessage ? groupMessageServiceURL : directMessageServiceURL);
    const response = await request(finalServiceUrl.toString(), {
      method: "POST",
      body: new URLSearchParams({
        params: encryptedParams,
      }),
    });

    const result = await handleZaloResponse(response);
    if (result.error) {
      throw new ZaloApiError(result.error.message, result.error.code);
    }

    return result.data;
  };
}
