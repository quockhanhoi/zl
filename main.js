import { execSync, spawn } from "child_process";
import { createServer } from "http";

// ─── Giữ Render không sleep (UptimeRobot ping vào đây) ───
const PORT = process.env.PORT || 3000;
createServer((req, res) => {
    res.writeHead(200);
    res.end("Bot is running!");
}).listen(PORT, () => {
    console.log(`[RENDER] Keep-alive server đang chạy trên port ${PORT}`);
});

// ─── Cài packages ───
console.log("[RENDER] Đang cài npm packages...");
try {
    execSync("npm install", { stdio: "inherit" });
    console.log("[RENDER] Cài xong!");
} catch (e) {
    console.error("[RENDER] npm install lỗi:", e.message);
}

// ─── Chạy bot.js ───
console.log("[RENDER] Đang khởi động bot.js...");

function startBot() {
    const bot = spawn("node", ["bot.js"], { stdio: "inherit" });

    bot.on("close", (code) => {
        console.log(`[RENDER] bot.js thoát với code ${code}, restart sau 3 giây...`);
        setTimeout(startBot, 3000);
    });

    bot.on("error", (err) => {
        console.error("[RENDER] Lỗi khởi động bot:", err.message);
        setTimeout(startBot, 10000);
    });
}

startBot();
