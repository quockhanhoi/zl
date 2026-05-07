import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { log } from "../logger.js";

const DEFAULT_TEMP_DIR = path.join(process.cwd(), "src", "modules", "cache", "temp");
if (!fs.existsSync(DEFAULT_TEMP_DIR)) fs.mkdirSync(DEFAULT_TEMP_DIR, { recursive: true });

/**
 * Lớp Wrapper để tương tác với spotDL CLI
 */
class SpotDL {
    constructor(options = {}) {
        this.tempDir = options.tempDir || DEFAULT_TEMP_DIR;
    }

    /**
     * Thực thi lệnh spotdl
     * @param {string[]} args 
     * @returns {Promise<{stdout: string, stderr: string, code: number}>}
     */
    async execute(args) {
        return new Promise((resolve, reject) => {
            log.info(`[spotDL] Đang chạy lệnh: spotdl ${args.join(" ")}`);
            const child = spawn("spotdl", args, {
                cwd: this.tempDir,
                shell: true
            });

            let stdout = "";
            let stderr = "";

            child.stdout.on("data", (data) => {
                const chunk = data.toString();
                stdout += chunk;
                if (chunk.trim()) console.log(`[spotDL STDOUT] ${chunk.trim()}`);
            });
            
            child.stderr.on("data", (data) => {
                const chunk = data.toString();
                stderr += chunk;
                if (chunk.trim()) console.log(`[spotDL STDERR] ${chunk.trim()}`);
            });

            child.on("close", (code) => {
                if (code === 0) {
                    resolve({ stdout, stderr, code });
                } else {
                    log.error(`[spotDL] Lệnh thất bại với code ${code}: ${stderr}`);
                    resolve({ stdout, stderr, code });
                }
            });

            child.on("error", (err) => {
                log.error(`[spotDL] Lỗi thực thi: ${err.message}`);
                reject(err);
            });
        });
    }

    /**
     * Tải một bài hát hoặc danh sách bài hát
     * @param {string} query Link Spotify hoặc tên bài hát
     * @returns {Promise<{success: boolean, filePath?: string, error?: string}>}
     */
    async download(query) {
        try {
            // --format mp3 --output "{title} - {artist}.{output-ext}"
            // Chúng ta dùng ID ngẫu nhiên để tránh trùng lặp
            const outputTemplate = `track_${Date.now()}`;
            const args = [
                "download",
                query,
                "--format", "mp3",
                "--output", `${outputTemplate}.{output-ext}`,
                "--no-cache"
            ];

            const result = await this.execute(args);

            if (result.code !== 0) {
                return { success: false, error: "Lỗi process spotDL" };
            }

            // Tìm file mp3 vừa tải trong thư mục temp
            const files = fs.readdirSync(this.tempDir);
            const downloadedFile = files.find(f => f.startsWith(outputTemplate) && f.endsWith(".mp3"));

            if (downloadedFile) {
                const fullPath = path.join(this.tempDir, downloadedFile);
                return { success: true, filePath: fullPath };
            }

            return { success: false, error: "Không tìm thấy file MP3 sau khi tải" };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Lấy thông tin metadata/link của bài hát (không tải file)
     * @param {string} query 
     */
    async getUrls(query) {
        const result = await this.execute(["url", query]);
        return result.stdout.trim().split("\n").filter(l => l.startsWith("http"));
    }

    /**
     * Đồng bộ thư mục với playlist
     * @param {string} query Link playlist
     * @param {string} targetDir Thư mục đích
     */
    async sync(query, targetDir) {
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        return await this.execute(["sync", query, "--save-file", path.join(targetDir, "sync.spotdl")]);
    }
}

export const spotdl = new SpotDL();
export default spotdl;
