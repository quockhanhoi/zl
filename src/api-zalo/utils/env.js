/**
 * env.js - Environment utilities for api-zalo
 */
export function getBotName() {
    return process.env.BOT_NAME || "admin";
}
