import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import ffmpeg from "fluent-ffmpeg";

async function downloadFallbackFfmpeg(m3u8Url, outputPath, referer, headers) {
    let command;
    await new Promise((resolve, reject) => {
        let isDone = false;
        const timer = setTimeout(() => {
            isDone = true;
            if (command) command.kill("SIGKILL");
            reject(new Error("Timeout 120s"));
        }, 120000);

        const origin = referer ? new URL(referer).origin : "";
        const inputOpts = [
            "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
            "-user_agent", headers["User-Agent"] || "Mozilla/5.0",
        ];
        if (referer) {
            inputOpts.push("-headers", `Referer: ${referer}\r\nOrigin: ${origin}\r\nAccept: */*\r\n`);
        }

        command = ffmpeg(m3u8Url)
            .inputOptions(inputOpts)
            .outputOptions(["-c copy", "-bsf:a aac_adtstoasc", "-movflags +faststart"])
            .output(outputPath)
            .on("end", () => { if (isDone) return; clearTimeout(timer); resolve(); })
            .on("error", err => { if (isDone) return; clearTimeout(timer); reject(err); });
        command.run();
    });

    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 10240) {
        throw new Error("File qua nho sau khi tai bang ffmpeg");
    }
}

export async function fastDownloadM3U8(m3u8Url, outputPath, options = {}) {
    const {
        headers = {},
        referer = "",
        concurrency = 15,
        timeout = 120000
    } = options;

    const reqHeaders = { ...headers };
    if (referer) reqHeaders["Referer"] = referer;

    const tmpDir = outputPath + "_tmp_ts";

    try {
        const m3u8Content = await axios.get(m3u8Url, { headers: reqHeaders, timeout: 15000 }).then(r => r.data);

        // Check if master playlist
        if (m3u8Content.includes("#EXT-X-STREAM-INF")) {
            const lines = m3u8Content.split("\n");
            let nextUrl = "";
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
                    for (let j = i + 1; j < lines.length; j++) {
                        if (lines[j].trim() && !lines[j].startsWith("#")) {
                            nextUrl = lines[j].trim();
                            break;
                        }
                    }
                    break;
                }
            }
            if (nextUrl) {
                const absoluteUrl = new URL(nextUrl, m3u8Url).toString();
                return fastDownloadM3U8(absoluteUrl, outputPath, options);
            }
        }

        // If encrypted, fallback to ffmpeg native which handles decryption
        if (m3u8Content.includes("#EXT-X-KEY")) {
            return downloadFallbackFfmpeg(m3u8Url, outputPath, referer, headers);
        }

        // Parse TS segments
        const segments = [];
        const lines = m3u8Content.split("\n");
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith("#")) {
                segments.push(new URL(trimmed, m3u8Url).toString());
            }
        }

        if (segments.length === 0) {
            return downloadFallbackFfmpeg(m3u8Url, outputPath, referer, headers);
        }

        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        const tsFiles = [];
        let completed = 0;
        
        const downloadTask = async (url, index) => {
            const tsPath = path.join(tmpDir, `${String(index).padStart(5, "0")}.ts`);
            for (let retries = 0; retries < 3; retries++) {
                try {
                    const response = await axios({
                        method: "GET",
                        url: url,
                        responseType: "arraybuffer",
                        headers: reqHeaders,
                        timeout: 15000
                    });
                    fs.writeFileSync(tsPath, response.data);
                    tsFiles[index] = tsPath;
                    completed++;
                    break;
                } catch (e) {
                    if (retries === 2) throw e;
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        };

        const activeTasks = new Set();
        let hasError = null;
        
        const abortTimeout = setTimeout(() => {
            hasError = new Error(`Fast M3U8 Download Timeout ${timeout/1000}s`);
        }, timeout);

        for (let i = 0; i < segments.length; i++) {
            if (hasError) break;
            const p = downloadTask(segments[i], i).catch(e => { hasError = e; });
            activeTasks.add(p);
            p.finally(() => activeTasks.delete(p));
            if (activeTasks.size >= concurrency) {
                await Promise.race(activeTasks);
            }
        }
        await Promise.all(activeTasks);
        clearTimeout(abortTimeout);
        
        if (hasError) throw hasError;

        // Merge TS using ffmpeg
        const listFile = path.join(tmpDir, "list.txt");
        const listContent = tsFiles.map(f => `file '${path.basename(f)}'`).join("\n");
        fs.writeFileSync(listFile, listContent);

        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(listFile)
                .inputOptions(["-f concat", "-safe 0"])
                .outputOptions(["-c copy", "-bsf:a aac_adtstoasc", "-movflags +faststart"])
                .output(outputPath)
                .on("end", resolve)
                .on("error", reject)
                .run();
        });

        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 10240) {
            throw new Error("File qua nho sau khi gop ts");
        }

    } catch (e) {
        // If anything fails in fast mode, fallback to ffmpeg sequential
        console.error(`[FastM3U8] Loi: ${e.message}. Dang fallback sang FFmpeg...`);
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        await downloadFallbackFfmpeg(m3u8Url, outputPath, referer, headers);
    } finally {
        // Cleanup tmp dir
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
}
