import axios from "axios";

const GEMINI_KEYS = [
    "AIzaSyArXI4srWdCk0tLWQTp5Nt6pwnd5ll1oNA", 
];
let currentKeyIndex = 0;

// ================== CẤU HÌNH API ==================
// Vì gpt4free thường xuyên bị lỗi auth, chúng ta chuyển sang dùng Pollinations AI API
// Đây là API hoàn toàn miễn phí, ổn định, không cần chạy server Python và hỗ trợ nhận diện ảnh (Vision)
const API_BASE_URL = "https://text.pollinations.ai/openai";
const personaName = "『 🤖 ChatGPT 』: ";

// ================== LOGIC GỌI AI ==================
async function callAI(question, message) {
    let messages = [
        { role: "system", content: "Bạn là ChatGPT, một trợ lý ảo thông minh. Bắt buộc luôn luôn trả lời bằng Tiếng Việt." }
    ];
    
    let userMessage = { role: "user", content: question || "Chào bạn!" };
    
    // Xử lý nếu người dùng reply ảnh HOẶC gửi ảnh trực tiếp kèm caption
    let attachData = null;
    let msgType = null;

    if (message.data && message.data.quote && message.data.quote.attach) {
        // Trường hợp Reply ảnh
        attachData = message.data.quote.attach;
        msgType = String(message.data.quote.cliMsgType);
    } else if (message.data && message.data.attach) {
        // Trường hợp Gửi ảnh trực tiếp kèm caption
        attachData = message.data.attach;
        msgType = String(message.data.msgType || message.data.cliMsgType);
    }

    if (attachData) {
        try {
            const attach = JSON.parse(attachData);
            let url = (attach.href || attach.originalUrl || "").replace(/\/jxl\//g, '/jpg/').replace(/\.jxl/g, '.jpg');
            
            if (url) {
                const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
                const data = Buffer.from(res.data).toString("base64");
                let mimeType = "image/jpeg";
                if (msgType === "4") mimeType = "video/mp4";
                if (msgType === "32") mimeType = "audio/mp3";

                const apiKey = GEMINI_KEYS[currentKeyIndex];
                const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
                
                const geminiBody = {
                    system_instruction: { 
                        parts: { text: "Bạn là ChatGPT, một trợ lý ảo thông minh. Luôn trả lời bằng Tiếng Việt." } 
                    },
                    contents: [{
                        parts: [
                            { text: question || "Hãy phân tích và mô tả chi tiết bức ảnh này giúp tôi." },
                            { inline_data: { mime_type: mimeType, data: data } }
                        ]
                    }]
                };

                const result = await axios.post(geminiUrl, geminiBody, { headers: { 'Content-Type': 'application/json' }, timeout: 60000 });
                return result.data.candidates[0].content.parts[0].text;
            }
        } catch (e) {
            console.error("[ChatGPT Module] Lỗi gọi Gemini API:", e?.response?.data || e.message);
        }
    }
    messages.push(userMessage);

    try {
        const response = await axios.post(API_BASE_URL, {
            model: "openai", 
            messages: messages
        }, { 
            headers: { 'Content-Type': 'application/json' },
            timeout: 60000 
        });
        
        let resultText = response.data.choices[0].message.content;
        // Lọc bỏ đoạn quảng cáo (Ad) của Pollinations ở cuối câu trả lời
        resultText = resultText.replace(/\n*---\n*\**Support Pollinations\.AI[\s\S]*/gi, '').trim();
        
        return resultText;
    } catch (error) {
        throw new Error("Hệ thống AI hiện đang bảo trì, vui lòng thử lại sau! " + (error.response?.status || ""));
    }
}

export const commands = {
    chatgpt: async (ctx) => {
        const { api, threadId, threadType, args, message } = ctx;
        const question = args.join(" ");
        
        if (!question && !message.data.quote) {
            return api.sendMessage({ msg: "🤖 Bạn muốn hỏi ChatGPT điều gì? (Có thể reply ảnh để hỏi)" }, threadId, threadType);
        }

        try {
            api.sendTypingEvent(threadId, threadType).catch(() => {});
            const response = await callAI(question, message);
            await api.sendMessage({ msg: personaName + response, quote: message }, threadId, threadType);
        } catch (e) {
            api.sendMessage({ msg: `😭 Lỗi: ${e.message}` }, threadId, threadType);
        }
    }
};

export async function handle(ctx) {
    return false; 
}

export default { commands, handle };
