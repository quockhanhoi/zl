import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import { loadModules } from "./src/modules/index.js";
import { loadEvents } from "./src/events/index.js";
import { log } from "./src/logger.js";
import { rentalManager } from "./src/utils/rentalManager.js";
import { statsManager } from "./src/utils/statsManager.js";
import { threadSettingsManager } from "./src/utils/threadSettingsManager.js";
import { autoReactManager } from "./src/utils/autoReactManager.js";
import { protectionManager } from "./src/utils/protectionManager.js";
import { cleanTempFiles, cleanupOldFiles } from "./src/utils/io-json.js";
import { handleListen } from "./src/utils/listen.js";
import { registerCustomApi } from "./src/utils/customApi.js";
import { startAutosendTicker } from "./src/modules/autosend.js";
import { startXSMBTracker } from "./src/modules/xsmb.js";
import { autoSendWeather } from "./src/modules/weather.js";
import { loadConfig, readRawConfig, writeRawConfig } from "./src/utils/config.js";
import { Zalo } from "./src/api-zalo/index.js";
import { appContext } from "./src/api-zalo/api-zalo/context.js";
import { startDashboard } from "./src/dashboard/server.js";

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath.path);

const normalizeCookies = (raw) => {
    if (!raw) return null;
    if (typeof raw === "string") return raw;
    if (Array.isArray(raw)) {
        return raw.map(c => `${c.name || c.key}=${c.value}`).join("; ");
    }
    if (raw.cookies && Array.isArray(raw.cookies)) {
        return raw.cookies.map(c => `${c.name || c.key}=${c.value}`).join("; ");
    }
    return null;
};

async function main() {
    const config = loadConfig();
    const { bot: { prefix = "-", selfListen = false } = {}, admin: { ids: adminIds = [] } = {}, credentials: creds = {} } = config;

    log.info("┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓");
    log.info("┃   ✦  ZALO BOT (api-zalo)    ┃");
    log.info("┃   ✦  CREATE BY DGK.SEX       ┃");
    log.info("┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛");

    rentalManager.load();
    statsManager.load();
    threadSettingsManager.load();
    autoReactManager.load();
    protectionManager.load();

    const { allCommands, moduleInfo, extraHandlers, inits } = await loadModules();
    const { handlers: baseEventHandlers, eventCommands } = await loadEvents();
    const eventHandlers = [...baseEventHandlers, ...extraHandlers];
    Object.assign(allCommands, eventCommands);

    log.info(`✦ ${moduleInfo.length} modules | ${Object.keys(allCommands).length} commands | ${eventHandlers.length} events`);

    const fixedUA = creds.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
    const fixedImei = creds.imei || "a3a30244-5f0a-45d1-9ce9-07a1bcd0f9ae-33d0f257a817d1ca4c4381b87f8ad83f";
    const cookieStr = normalizeCookies(creds.cookies);

    if (!cookieStr || !fixedImei) {
        log.error("⚠️ Thiếu cookie hoặc imei trong config.json. Hãy chạy 'node login.js' trước.");
        process.exit(1);
    }

    // api-zalo nhận credentials vào constructor, không phải vào login()
    const zalo = new Zalo({
        cookie: cookieStr,
        imei: fixedImei,
        userAgent: fixedUA,
        language: "vi",
        selfListen,
    }, {
        selfListen,
        checkUpdate: false,
    });

    let api;
    try {
        log.info("🔑 Đang đăng nhập bằng cookie...");
        api = await zalo.login();
        log.success("Đăng nhập thành công!");
    } catch (e) {
        log.error("⚠️ Đăng nhập thất bại:", e.message);
        process.exit(1);
    }

    // Lưu lại cookie trong config (tùy chọn – api-zalo không tự cập nhật)
    try {
        const cfg = readRawConfig();
        cfg.credentials = {
            cookies: cookieStr,
            imei: appContext.imei || fixedImei,
            userAgent: appContext.userAgent || fixedUA,
        };
        writeRawConfig(cfg);
    } catch (e) {
        log.warn("Không thể ghi lại credentials:", e.message);
    }

    // Bổ sung các method compat để không crash
    if (!api.undo) {
        api.undo = (...args) => api.undoMessage?.(...args) ?? Promise.resolve();
    }
    if (!api.sendTypingEvent) {
        api.sendTypingEvent = () => Promise.resolve();
    }
    if (!api.getContext) {
        api.getContext = () => appContext;
    }
    if (!api.ctx) {
        api.ctx = appContext;
    }

    registerCustomApi(api, log);

    cleanTempFiles(); cleanupOldFiles();
    setInterval(() => { cleanTempFiles(); cleanupOldFiles(); }, 3600000);

    startAutosendTicker(api);
    startXSMBTracker(api);

    setInterval(() => {
        autoSendWeather(api, log).catch(e => log.error("AutoWeather ticker error:", e.message));
    }, 1800000);

    await handleListen(api, { prefix, selfListen, adminIds, allCommands, moduleInfo, eventHandlers, log });

    // Khởi động Dashboard
    startDashboard(api, { allCommands, moduleInfo, eventHandlers, prefix, adminIds });

    // Khởi tạo các module
    for (const initFn of inits) {
        try { await initFn(api); } catch (e) { log.error("Module init error", e.message); }
    }

    const stop = () => {
        log.info("\n✦ Tắt bot...");
        try {
            if (api.listener?.ws?.readyState === 1) api.listener.ws.close();
        } catch { }
        process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
}

main();
