import { exec } from "node:child_process";

export const name = "bug";
export const description = "Debug tools";

export const commands = {
    bug: async (ctx) => {
        try {
            const data = ctx.message.data;
            const target = data.quote ? data.quote : data;
            
            // Deep parse strings that might be JSON (attach, properties, etc)
            const deepParse = (obj) => {
                if (typeof obj !== 'object' || obj === null) return obj;
                for (const key in obj) {
                    if (typeof obj[key] === 'string' && (obj[key].startsWith('{') || obj[key].startsWith('['))) {
                        try {
                            obj[key] = JSON.parse(obj[key]);
                            deepParse(obj[key]);
                        } catch (e) {}
                    } else if (typeof obj[key] === 'object') {
                        deepParse(obj[key]);
                    }
                }
                return obj;
            };

            const parsed = deepParse(JSON.parse(JSON.stringify(target)));
            let rawData = JSON.stringify(parsed, null, 2);
            
            if (rawData.length > 2000) {
                const chunks = rawData.match(/.{1,1900}/gs) || [];
                for (const chunk of chunks) {
                    await ctx.api.sendMessage({ msg: "DEBUG BUG (Chunk):\n" + chunk }, ctx.threadId, ctx.threadType);
                    await new Promise(r => setTimeout(r, 500));
                }
            } else {
                await ctx.api.sendMessage({ msg: "DEBUG BUG:\n" + rawData }, ctx.threadId, ctx.threadType);
            }
        } catch (e) {
            console.error(e);
            ctx.api.sendMessage({ msg: "⚠️ Lỗi bug: " + e.message }, ctx.threadId, ctx.threadType);
        }
    },
    shell: async (ctx) => {
        const { api, threadId, threadType, args, senderId, adminIds } = ctx;
        if (!adminIds.includes(senderId)) return;

        const cmd = args.join(" ");
        if (!cmd) return api.sendMessage({ msg: "🔍 Nhập lệnh shell cần chạy!" }, threadId, threadType);

        exec(cmd, (err, stdout, stderr) => {
            if (err) return api.sendMessage({ msg: `    Lỗi:\n${err.message}` }, threadId, threadType);
            const output = stdout || stderr || "✅ Command executed with no output.";
            api.sendMessage({ msg: `💻 Shell Output:\n${output.substring(0, 1500)}` }, threadId, threadType);
        });
    }
};
