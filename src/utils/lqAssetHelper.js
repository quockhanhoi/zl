import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';

const SPREADSHEET_URL = "https://docs.google.com/spreadsheets/d/1shR8v0QEyokBvU6YoizRMOd5yGTIx0COno2cxRsHnLQ/gviz/tq?tqx=out:json&tq&gid=0";
const CACHE_FILE = path.join(process.cwd(), 'src/modules/cache/lq_heroes.json');

export async function getHeroes() {
    // Check cache
    if (fs.existsSync(CACHE_FILE)) {
        const stats = fs.statSync(CACHE_FILE);
        const now = Date.now();
        // Cache for 24 hours
        if (now - stats.mtimeMs < 24 * 60 * 60 * 1000) {
            return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        }
    }

    try {
        const response = await axios.get(SPREADSHEET_URL);
        const dataStr = response.data;
        // Extract JSON from google.visualization.Query.setResponse(...)
        const jsonStr = dataStr.substring(dataStr.indexOf('(') + 1, dataStr.lastIndexOf(')'));
        const json = JSON.parse(jsonStr);
        
        const rows = json.table.rows;
        const heroes = rows.map(row => {
            const c = row.c;
            return {
                avatar: c[0]?.v,
                image: c[1]?.v,
                mask: c[2]?.v,
                width: c[3]?.v || 0,
                x: c[4]?.v || 0,
                y: c[5]?.v || 0,
                tier: c[6]?.v || "",
                skinName: c[7]?.v || "",
                heroName: (c[1]?.v && typeof c[1].v === 'string') ? path.basename(c[1].v, path.extname(c[1].v)).replace(/[-_]/g, ' ') : "Unknown"
            };
        }).filter(h => h.image);

        // Ensure cache directory exists
        const cacheDir = path.dirname(CACHE_FILE);
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(heroes, null, 2));

        return heroes;
    } catch (error) {
        console.error("Lỗi lấy dữ liệu tướng từ Spreadsheet:", error.message);
        if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        return [];
    }
}

export const LQ_ASSETS = {
    rank: "https://taoanhdep.com/files/tad/effect/khung-lq-new/rank2024/",
    thongthao: "https://taoanhdep.com/files/tad/effect/khung-lq-new/thongthao2025/",
    triky: "https://taoanhdep.com/files/tad/effect/khung-lq-new/triky/",
    botro: "https://taoanhdep.com/files/tad/effect/khung-lq-new/botro/",
    phuhieu: "https://taoanhdep.com/files/tad/effect/khung-lq-new/phuhieu/",
    bacskin: "https://taoanhdep.com/files/tad/effect/khung-lq-new/bacskin/",
    team: "https://taoanhdep.com/files/tad/effect/khung-lq-new/team/",
    base: "https://lh3.googleusercontent.com/-zzSitNM6oF4/Yu3htEBz9fI/AAAAAAAA_f0/ysAcJURUtGE1Ye4eyccAcfYQ7fUn6a1VwCNcBGAsYHQ/s0/nguon.png"
};

export const RANK_NAMES = [
    { name: "Chưa Rank", id: "0" },
    { name: "Đồng", id: "dong" },
    { name: "Bạc", id: "bac" },
    { name: "Vàng", id: "vang" },
    { name: "Bạch Kim", id: "bachkim" },
    { name: "Kim Cương", id: "kimcuong" },
    { name: "Tinh Anh", id: "tinhanh" },
    { name: "Cao Thủ", id: "caothu" },
    { name: "Chiến Tướng", id: "chientuong" },
    { name: "Chiến Thần", id: "chienthan" },
    { name: "Thách Đấu", id: "thachdau" }
];

export const MASTERY_NAMES = [
    { name: "D", id: "d" },
    { name: "C", id: "c" },
    { name: "B", id: "b" },
    { name: "A", id: "a" },
    { name: "S", id: "s" }
];

export const SOULMATE_NAMES = [
    { name: "Trống", id: "blank" },
    { name: "Cặp đôi", id: "cd" },
    { name: "Chị em", id: "ce" },
    { name: "Bạn thân", id: "bb" },
    { name: "Anh em", id: "ae" }
];

export const SPELL_NAMES = [
    { name: "Trực tiếp", id: "blank" },
    { name: "Tốc hành", id: "tochanh" },
    { name: "Cấp cứu", id: "capcuu" },
    { name: "Trừng trị", id: "trungtri" },
    { name: "Gầm thét", id: "gamthet" },
    { name: "Suy nhược", id: "suynhuoc" },
    { name: "Cấm trụ", id: "camtru" },
    { name: "Ngất ngư", id: "ngatngu" },
    { name: "Thanh tẩy", id: "thanhtay" },
    { name: "Bộc phá", id: "bocpha" },
    { name: "Tốc biến", id: "tocbien" },
    { name: "Tê tái", id: "tetai" }
];

export const ENCHANTMENT_NAMES = [
    { name: "Trống", id: "blank" },
    { name: "Thần lộc", id: "tl" },
    { name: "Thánh thuẫn", id: "tq" },
    { name: "Tinh thuẫn", id: "tt" },
    { name: "Du hiệp", id: "dk" },
    { name: "Mộc giáp", id: "mc" },
    { name: "Ma tính", id: "mt" },
    { name: "Tháp quang minh", id: "tb" },
    { name: "Ma chú", id: "mg" },
    { name: "Đấu khí", id: "dh" },
    { name: "Chuyển sinh", id: "cs" },
    { name: "Luyện kim", id: "lk" }
];
