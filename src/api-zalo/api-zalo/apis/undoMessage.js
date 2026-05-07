import { appContext } from "../context.js";
import { Zalo, ZaloApiError } from "../index.js";
import { GroupMessage, Message, MessageType } from "../models/Message.js";
import { encodeAES, handleZaloResponse, request } from "../utils.js";
export function undoMessageFactory(api) {
  const URLPatterns = {
    [MessageType.DirectMessage]: ["/api/message/undo", "/api/message/undomsg", "/api/message/recallmsg"],
    [MessageType.GroupMessage]: ["/api/group/recallmsg", "/api/group/undomsg", "/api/group/undo"],
  };

  /**
   * Undo a message (Recall)
   * Supports Admin Recall for groups if fromId is provided.
   *
   * @param message Message info (msgId, cliMsgId, fromId?)
   * @param threadId Thread ID
   * @param type Message Type (Direct or Group)
   */
  return async function undo(message, threadId, type) {
    if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent)
      throw new ZaloApiError("Missing required app context fields");

    const messagesToUndo = Array.isArray(message) ? message : [message];
    const results = [];

    for (const msg of messagesToUndo) {
      try {
        let globalMsgId, cliMsgId, fromId, finalThreadId, finalType;

        if (msg.msgId || msg.data?.quote?.globalMsgId) {
          globalMsgId = msg.msgId || msg.data?.quote?.globalMsgId;
          cliMsgId = msg.cliMsgId || msg.data?.quote?.cliMsgId;
          fromId = msg.fromId || msg.uidFrom || msg.data?.quote?.uidFrom;
          finalThreadId = threadId || msg.threadId;
          finalType = type ?? msg.type ?? MessageType.DirectMessage;
        } else {
          continue;
        }

        const params = {
          msgId: String(globalMsgId),
          clientId: Date.now(),
        };

        const isGroup = finalType === MessageType.GroupMessage || finalType === 1 || finalType === "1";
        if (isGroup) {
          params["grid"] = String(finalThreadId);
          params["imei"] = appContext.imei;
          if (fromId && String(fromId) !== "0" && String(fromId) !== appContext.uid) {
            params["fromId"] = String(fromId);
            params["cliMsgId"] = String(cliMsgId);
            params["isAdminRecall"] = 1;
          } else {
            params["cliMsgIdUndo"] = String(cliMsgId);
          }
        } else {
          params["toid"] = String(finalThreadId);
          params["cliMsgIdUndo"] = String(cliMsgId);
          params["cliMsgId"] = String(cliMsgId);
        }

        const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
        if (!encryptedParams) continue;

        const baseServer = isGroup ? api.zpwServiceMap.group[0] : api.zpwServiceMap.chat[0];
        const endpoints = URLPatterns[finalType] || (isGroup ? URLPatterns[MessageType.GroupMessage] : URLPatterns[MessageType.DirectMessage]);
        
        let success = false;
        for (const endpoint of endpoints) {
          try {
            const url = `${baseServer}${endpoint}?zpw_ver=684&zpw_type=30`;
            const response = await request(url, {
              method: "POST",
              body: new URLSearchParams({ params: encryptedParams }),
            });
            const result = await handleZaloResponse(response);
            if (result.data && result.data.status === 0) {
              results.push(result.data);
              success = true;
              break;
            }
            if (result.error) console.warn(`[UNDO TRY] Endpoint ${endpoint} failed:`, result.error.message);
          } catch (err) {
            console.warn(`[UNDO TRY] Endpoint ${endpoint} error:`, err.message);
          }
        }
        if (!success) results.push(null);
      } catch (e) {
        console.error("[UNDO CRITICAL]", e.message);
      }
    }
    return results;
  };
}
