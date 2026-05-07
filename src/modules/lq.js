import { getHeroes, RANK_NAMES, MASTERY_NAMES, SOULMATE_NAMES, SPELL_NAMES, ENCHANTMENT_NAMES, LQ_ASSETS } from '../utils/lqAssetHelper.js';
import { drawZingSearch } from '../utils/canvasHelper.js';
import { createCanvas, loadImage, registerFont } from 'canvas';
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { uploadToTmpFiles } from '../utils/tmpFiles.js';

export const searchCache = new Map();

export const commands = {
    lq: async (ctx) => {
        const { api, args, threadId, threadType, senderId, message } = ctx;
        const query = args.join(" ").trim();

        if (!query) {
            return api.sendMessage({ msg: "⚠️ Vui lòng nhập tên tướng! Ví dụ: !lq nakroth" }, threadId, threadType);
        }

        const heroes = await getHeroes();
        if (!heroes || heroes.length === 0) {
            return api.sendMessage({ msg: "⚠️ Đang tải dữ liệu tướng, vui lòng thử lại sau vài giây!" }, threadId, threadType);
        }

        const searchTerm = query.toLowerCase();
        const results = heroes.filter(h => 
            (h.heroName || "").toLowerCase().includes(searchTerm) || 
            (h.skinName || "").toLowerCase().includes(searchTerm)
        ).slice(0, 10);

        if (results.length === 0) {
            return api.sendMessage({ msg: "⚠️ Không tìm thấy tướng/skin nào khớp với từ khóa!" }, threadId, threadType);
        }

        // Vẽ danh sách kết quả
        const canvasBuffer = await drawZingSearch(results.map(r => ({
            title: r.heroName || "Unknown",
            artistsNames: r.skinName || "Trang phục mặc định",
            thumbnail: r.avatar || "",
            duration: r.tier || "Mặc định"
        })), query, "LIÊN QUÂN MOBILE");

        const cacheDir = path.resolve(process.cwd(), "src", "modules", "cache");
        const searchCacheDir = path.join(cacheDir, "lq_temp");
        if (!fs.existsSync(searchCacheDir)) fs.mkdirSync(searchCacheDir, { recursive: true });
        
        const searchImgPath = path.join(searchCacheDir, `lq_search_${Date.now()}.png`);
        fs.writeFileSync(searchImgPath, canvasBuffer);

        const remoteUrl = await uploadToTmpFiles(searchImgPath, api, threadId, threadType);
        const caption = `🔍 Kết quả tìm kiếm cho: "${query}"\n💡 Phản hồi STT (1-${results.length}) để chọn!`;
        
        let sentMsg;
        try {
            if (remoteUrl && typeof api.sendImageEnhanced === 'function') {
                sentMsg = await api.sendImageEnhanced({ imageUrl: remoteUrl, threadId, threadType, width: 1280, height: 720, msg: caption });
            } else {
                // zca-js standard sendMessage expects 'attachments' as an array of paths
                sentMsg = await api.sendMessage({ msg: caption, attachments: [searchImgPath] }, threadId, threadType);
            }
        } catch (e) { 
            console.error("[LQ] Error sending search result:", e.message);
            // Last fallback: try sending just the text if image sending fails
            sentMsg = await api.sendMessage({ msg: caption }, threadId, threadType);
        }

        if (fs.existsSync(searchImgPath)) {
            try { fs.unlinkSync(searchImgPath); } catch (e) {}
        }
        
        // Robust extraction of msgId for search results
        const resultData = sentMsg?.data || sentMsg?.message || sentMsg || {};
        const msgId = String(resultData.msgId || resultData.globalMsgId || resultData.globalMsgID || "");
        
        const session = {
            results,
            senderId,
            msgId,
            timeout: setTimeout(() => {
                searchCache.delete(msgId);
                searchCache.delete(`${threadId}_${senderId}`);
            }, 60000)
        };

        if (msgId && msgId !== "undefined") searchCache.set(msgId, session);
        searchCache.set(`${threadId}_${senderId}`, session);

        if (resultData.msgId) api.addReaction("🎵", sentMsg).catch(() => {});
    }
};

async function createPlayerFrame(data) {
    const { hero, name, rank, mastery, triky, spell, enchantment, team = "xanh" } = data;
    // Tỷ lệ chuẩn web là 1000 x 615
    const canvas = createCanvas(1000, 615);
    const ctx = canvas.getContext('2d');

    const loadImg = async (url) => {
        if (!url || url === 'blank') return null;
        try {
            const res = await axios.get(url, { 
                responseType: 'arraybuffer', 
                timeout: 15000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
            });
            return await loadImage(Buffer.from(res.data));
        } catch (e) { return null; }
    };

    const assetsUrls = {
        hero: hero.image,
        mask: hero.mask,
        frame: `${LQ_ASSETS.rank}${rank}.png`,
        mastery: `${LQ_ASSETS.thongthao}${mastery}.png`,
        triky: `${LQ_ASSETS.triky}${triky}.png`,
        spell: `${LQ_ASSETS.botro}${spell}.png`,
        enchantment: `${LQ_ASSETS.phuhieu}${enchantment}.png`,
        logo: LQ_ASSETS.base
    };

    if (hero.tier && hero.tier !== "Default") {
        const tierId = hero.tier.toLowerCase().replace(/[^a-z0-9]/g, '');
        assetsUrls.tier = `${LQ_ASSETS.bacskin}${tierId}.png`;
    }

    const [heroImg, maskImg, frameImg, masteryImg, trikyImg, spellImg, enchantmentImg, logoImg, tierImg] = await Promise.all([
        loadImg(assetsUrls.hero),
        loadImg(assetsUrls.mask),
        loadImg(assetsUrls.frame),
        loadImg(assetsUrls.mastery),
        loadImg(assetsUrls.triky),
        loadImg(assetsUrls.spell),
        loadImg(assetsUrls.enchantment),
        loadImg(assetsUrls.logo),
        loadImg(assetsUrls.tier)
    ]);

    // 1. Draw Hero with Mask
    if (heroImg) {
        // Tỷ lệ scale tướng từ dữ liệu sheet (thường được căn cho 1000x615)
        const hW = parseInt(hero.width) || 1000;
        const hX = parseInt(hero.x) || 0;
        const hY = parseInt(hero.y) || 0;
        const hH = (hW * heroImg.height) / heroImg.width;

        if (maskImg) {
            const tempCanvas = createCanvas(1000, 615);
            const tCtx = tempCanvas.getContext('2d');
            tCtx.drawImage(heroImg, hX, hY, hW, hH);
            tCtx.globalCompositeOperation = 'destination-in';
            tCtx.drawImage(maskImg, 0, 0, 1000, 615);
            ctx.drawImage(tempCanvas, 0, 0, 1000, 615);
        } else {
            ctx.drawImage(heroImg, hX, hY, hW, hH);
        }
    }

    // 2. Draw Frame & Overlays (Full Size)
    if (frameImg) ctx.drawImage(frameImg, 0, 0, 1000, 615);
    if (logoImg) ctx.drawImage(logoImg, 0, 0, 1000, 615);
    
    // 3. Draw Sub-Assets (Đã scale tỷ lệ 615/1000)
    if (tierImg) ctx.drawImage(tierImg, 400, 465, 200, 45); // Bậc skin
    if (masteryImg) ctx.drawImage(masteryImg, 15, 15, 85, 115); // Rank/Thông thạo góc trái
    if (trikyImg) ctx.drawImage(trikyImg, 65, 525, 55, 55); // Tri kỷ
    if (spellImg) ctx.drawImage(spellImg, 785, 525, 55, 55); // Bổ trợ
    if (enchantmentImg) ctx.drawImage(enchantmentImg, 868, 515, 75, 75); // Phù hiệu

    // 4. Text Rendering (Mẫu 2024 chuẩn)
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';

    const uppercaseName = String(name || "PLAYER").toUpperCase();

    // 4.1 Nickname (Dòng trên)
    ctx.font = 'bold 44px BeVietnamProBold, Sans';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 10;
    ctx.strokeText(uppercaseName, 500, 530);
    ctx.fillText(uppercaseName, 500, 530);

    // 4.2 Tướng - Skin (Dòng dưới)
    const heroPart = (hero.heroName || "HERO").toUpperCase();
    const skinPart = (hero.skinName || "").toUpperCase();
    
    // Tránh lặp: Nếu skinName là "Mặc định" hoặc trùng heroName thì chỉ hiện heroName
    let displaySkin = heroPart;
    if (skinPart && skinPart !== "MẶC ĐỊNH" && !heroPart.includes(skinPart)) {
        displaySkin = `${heroPart} - ${skinPart}`;
    }

    ctx.font = 'bold 26px BeVietnamProBold, Sans';
    ctx.fillStyle = team === "xanh" ? '#5d9af6' : '#ffcc00';
    ctx.lineWidth = 8;
    ctx.strokeText(displaySkin, 500, 575);
    ctx.fillText(displaySkin, 500, 575);

    return canvas.toBuffer('image/png');
}


export async function handle(ctx) {
    const { api, message, threadId, threadType, senderId, content } = ctx;
    if (!content || message.isSelf) return false;

    const quoteId = String(message.data?.quote?.msgId || message.data?.quote?.globalMsgId || "");
    let session = quoteId ? searchCache.get(quoteId) : (/^\d+/.test(content.trim()) ? searchCache.get(`${threadId}_${senderId}`) : null);

    if (!session || senderId !== session.senderId) return false;

    const sendQuery = async (msg, nextStep) => {
        session.step = nextStep;
        const sent = await api.sendMessage({ msg }, threadId, threadType);
        const nextId = String(sent?.msgId || sent?.data?.msgId || sent?.message?.msgId || "");
        if (nextId) searchCache.set(nextId, session);
        return true;
    };

    const input = content.trim().toLowerCase();
    const isDone = input === 'done' || input === 'tao' || input === 'ok';
    const isSkip = input === '.';

    const finalize = async () => {
        clearTimeout(session.timeout);
        searchCache.delete(`${threadId}_${senderId}`);
        if (session.msgId) searchCache.delete(session.msgId);
        await processLqGeneration(ctx, session.selectedHero, session.playerName || "PLAYER", session.options || []);
        return true;
    };

    // Step 0: Hero selection
    if (!session.step) {
        const choice = parseInt(content.trim());
        if (isNaN(choice) || choice < 1 || choice > session.results.length) return false;
        
        api.addReaction("🎵", message).catch(() => {});
        session.selectedHero = session.results[choice - 1];
        session.options = []; 
        return await sendQuery(`✅ Đã chọn: ${session.selectedHero.heroName}\n\n👉 Bước 1: Nhập TÊN in lên ảnh (hoặc '.' để mặc định):`, 'NAME');
    }

    if (isDone && session.step !== 'NAME') return await finalize();

    // Step 1: Name
    if (session.step === 'NAME') {
        session.playerName = isSkip ? "PLAYER" : content.trim();
        return await sendQuery(`🛡️ Bước 2: Chọn RANK (hoặc '.' để bỏ qua, 'done' để tạo luôn):\n\nthachdau, chientuong, caothu, tinhanh, kimcuong, bachkim, vang, bac, dong`, 'RANK');
    }

    // Step 2: Rank
    if (session.step === 'RANK') {
        session.options[0] = isSkip ? "chientuong" : input;
        return await sendQuery(`⭐ Bước 3: Chọn THÔNG THẠO:\n\ns1mc, tmc, ht, cc, tc, sc, s, a, b, c, d`, 'MASTERY');
    }

    // Step 3: Mastery
    if (session.step === 'MASTERY') {
        session.options[1] = isSkip ? "s" : input;
        return await sendQuery(`⚡ Bước 4: Chọn PHÉP BỔ TRỢ:\n\ntocbien, trungtri, capcuu, tochanh, tetai, bocpha, camtru, suynhuoc`, 'SPELL');
    }

    // Step 4: Spell
    if (session.step === 'SPELL') {
        session.options[2] = isSkip ? "tocbien" : input;
        return await sendQuery(`💠 Bước 5: Chọn PHÙ HIỆU:\n\ntl, tq, tt, dk, mc, mt, tb, mg, dh, cs, lk`, 'PHUHIEU');
    }

    // Step 5: Phuhieu
    if (session.step === 'PHUHIEU') {
        session.options[3] = isSkip ? "tl" : input;
        return await sendQuery(`🔵 Bước 6: Chọn TEAM (xanh / do):`, 'TEAM');
    }

    // Step 6: Team
    if (session.step === 'TEAM') {
        session.options[4] = isSkip ? "xanh" : input;
        return await finalize();
    }

    return false;
}

async function processLqGeneration(ctx, hero, playerName, options = []) {
    const { api, threadId, threadType, senderId, message } = ctx;
    searchCache.delete(`${threadId}_senderId`);

    const wait = await api.sendMessage({ msg: "⏳ Đang tạo ảnh frame Liên Quân, vui lòng chờ..." }, threadId, threadType);

    try {
        // Options: [Rank, Mastery, Spell, Phuhieu, Team]
        const frameData = {
            hero,
            name: playerName,
            rank: options[0] || "chientuong", 
            mastery: options[1] || "s",
            spell: options[2] || "tocbien",
            enchantment: options[3] || "tl",
            team: options[4] || "xanh",
            triky: "cd"
        };

        const buffer = await createPlayerFrame(frameData);
        
        const cacheDir = path.resolve(process.cwd(), "src/modules/cache/lq_temp");
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

        const tmpPath = path.join(cacheDir, `lq_${Date.now()}.png`);
        fs.writeFileSync(tmpPath, buffer);

        const remoteUrl = await uploadToTmpFiles(tmpPath, api, threadId, threadType);
        const caption = `✨ Ảnh Liên Quân của bạn đã xong!\n👤 Tên: ${playerName}\n🛡️ Rank: ${frameData.rank.toUpperCase()}\n🎭 Tướng: ${hero.heroName}\n✨ Skin: ${hero.skinName || "Mặc định"}`;

        if (remoteUrl && typeof api.sendImageEnhanced === 'function') {
            await api.sendImageEnhanced({ imageUrl: remoteUrl, threadId, threadType, width: 1000, height: 1000, msg: caption });
        } else {
            // Fallback using native attachments array
            await api.sendMessage({ msg: caption, attachments: [tmpPath] }, threadId, threadType);
        }

        if (wait && wait.message) api.undoMessage(wait.message, threadId, threadType).catch(() => {});
        api.addReaction("✅", message).catch(() => {});

        setTimeout(() => {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        }, 5000);

    } catch (e) {
        console.error("[LQ] Gen error:", e);
        api.sendMessage(`⚠️ Lỗi tạo ảnh: ${e.message}`, threadId, threadType);
    }
}
