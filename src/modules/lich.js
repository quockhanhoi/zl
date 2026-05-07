import { Lunar, Solar } from "lunar-javascript";
import fs from "node:fs";
import path from "node:path";
import { drawCalendarMonthly, drawCalendarDaily } from "../utils/canvasHelper.js";
import { tempDir } from "../utils/io-json.js";
import { log } from "../logger.js";

export const name = "lich";
export const description = "Xem lịch vạn niên, lịch âm/dương, giờ hoàng đạo và thông tin ngày";

const canChiMap = {
    // Thiên Can
    "甲": "Giáp", "乙": "Ất", "丙": "Bính", "丁": "Đinh", "戊": "Mậu",
    "己": "Kỷ", "庚": "Canh", "辛": "Tân", "壬": "Nhâm", "癸": "Quý",
    // Địa Chi
    "子": "Tý", "丑": "Sửu", "寅": "Dần", "卯": "Mão", "辰": "Thìn", "巳": "Tỵ",
    "午": "Ngọ", "未": "Mùi", "申": "Thân", "酉": "Dậu", "戌": "Tuất", "亥": "Hợi"
};

const trucMap = {
    "建": "Kiến", "除": "Trừ", "满": "Mãn", "平": "Bình", "定": "Định", "执": "Chấp",
    "破": "Phá", "危": "Nguy", "成": "Thành", "收": "Thu", "开": "Khai", "闭": "Bế"
};

const tietKhiMap = {
    "立春": "Lập Xuân", "雨水": "Vũ Thủy", "惊蛰": "Kinh Trập", "春分": "Xuân Phân", "清明": "Thanh Minh", "谷雨": "Cốc Vũ",
    "立夏": "Lập Hạ", "小满": "Tiểu Mãn", "芒种": "Mang Chủng", "夏至": "Hạ Chí", "小暑": "Tiểu Thử", "大暑": "Đại Thử",
    "立秋": "Lập Thu", "处暑": "Xử Thử", "白露": "Bạch Lộ", "秋分": "Thu Phân", "寒露": "Hàn Lộ", "霜降": "Sương Giáng",
    "立冬": "Lập Đông", "小雪": "Tiểu Tuyết", "大雪": "Đại Tuyết", "冬至": "Đông Chí", "小寒": "Tiểu Hàn", "大寒": "Đại Hàn"
};

const directionMap = {
    "正东": "Chính Đông", "正西": "Chính Tây", "正南": "Chính Nam", "正北": "Chính Bắc",
    "东北": "Đông Bắc", "东南": "Đông Nam", "西北": "Tây Bắc", "西南": "Tây Nam"
};

const toVietnamese = (s, map) => {
    if (!s) return "";
    // Check if the whole string is in map (like for directions)
    if (map[s]) return map[s];
    // Otherwise split by character (like for Can Chi)
    return s.split('').map(c => map[c] || c).join(' ');
};

const quotes = [
    "Một ngày không có tiếng cười là một ngày lãng phí. - Charlie Chaplin",
    "Hành trình vạn dặm bắt đầu từ một bước chân nhỏ bé. - Lão Tử",
    "Hãy sống như thể ngày mai bạn sẽ chết. Hãy học như thể bạn sẽ sống mãi mãi. - Mahatma Gandhi",
    "Thành công không phải là chìa khóa mở cửa hạnh phúc. Hạnh phúc mới là chìa khóa dẫn tới thành công.",
    "Đừng bao giờ từ bỏ ước mơ của mình chỉ vì nó tốn thời gian. Thời gian vẫn sẽ trôi qua thôi. - Earl Nightingale",
    "Cuộc sống là 10% những gì xảy ra với bạn và 90% cách bạn phản ứng với nó. - Charles R. Swindoll",
    "Người duy nhất bạn nên cố gắng để tốt hơn chính là bản thân bạn của ngày hôm qua.",
    "Mọi khó khăn đều là một cơ hội để rèn luyện bản thân.",
    "Hạnh phúc không phải là điểm đến, mà là hành trình chúng ta đang đi.",
    "Hãy luôn tử tế với mọi người bạn gặp, bởi ai cũng đang chiến đấu một cuộc chiến riêng của họ."
];

export const commands = {
    lich: async (ctx) => {
        const { args } = ctx;
        const subCmd = args[0]?.toLowerCase();

        if (subCmd === "month" || subCmd === "thang") {
            return await handleMonthlyCalendar(ctx);
        }

        await handleDailyInfo(ctx);
    },
    amlich: async (ctx) => {
        await handleDailyInfo(ctx);
    }
};

async function handleDailyInfo(ctx) {
    const { api, threadId, threadType } = ctx;
    
    try {
        const now = new Date();
        const solar = Solar.fromDate(now);
        const lunar = Lunar.fromDate(now);

        const canChiDay = toVietnamese(lunar.getDayInGanZhi(), canChiMap);
        const canChiMonth = toVietnamese(lunar.getMonthInGanZhi(), canChiMap);
        const canChiYear = toVietnamese(lunar.getYearInGanZhi(), canChiMap);
        const canChiHour = toVietnamese(lunar.getTimeInGanZhi(), canChiMap);
        
        const tietKhi = tietKhiMap[lunar.getJieQi()] || lunar.getJieQi();
        const truc = trucMap[lunar.getZhiXing()] || lunar.getZhiXing();
        
        // Giờ hoàng đạo
        const dayTimes = lunar.getTimes();
        const hoangDao = dayTimes.filter(t => t.getTianShenType() === "黄道").map(t => toVietnamese(t.getZhi(), canChiMap)).join(", ");
        
        // Hướng xuất hành
        const hyThan = toVietnamese(lunar.getDayPositionXiDesc(), directionMap);
        const taiThan = toVietnamese(lunar.getDayPositionCaiDesc(), directionMap);

        const quote = quotes[now.getDate() % quotes.length];
        const dayNames = ["Chủ Nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];

        const canvasData = {
            solar: {
                day: solar.getDay(),
                month: solar.getMonth(),
                year: solar.getYear(),
                dayName: dayNames[now.getDay()]
            },
            lunar: {
                day: lunar.getDay(),
                month: Math.abs(lunar.getMonth()),
                yearInCanChi: canChiYear
            },
            canChi: {
                day: canChiDay,
                month: canChiMonth,
                year: canChiYear
            },
            extra: {
                tietKhi,
                truc,
                hoangDao,
                hyThan,
                taiThan,
                quote
            }
        };

        const imgBuf = await drawCalendarDaily(canvasData);
        const tmpPath = path.join(tempDir, `lich_${Date.now()}.png`);
        fs.writeFileSync(tmpPath, imgBuf);

        await api.sendMessage({
            msg: `[ 📅 LỊCH VẠN NIÊN ]\n☀️ Ngày ${solar.getDay()}/${solar.getMonth()}/${solar.getYear()}\n─────────────────\n💡 Dùng !lich month để xem lịch tháng.`,
            attachments: [tmpPath]
        }, threadId, threadType);

        try { fs.unlinkSync(tmpPath); } catch { }
    } catch (e) {
        log.error(`Lỗi handleDailyInfo:`, e.stack);
        return api.sendMessage({ msg: "⚠️ Lỗi: " + e.message }, threadId, threadType);
    }
}

async function handleMonthlyCalendar(ctx) {
    const { api, threadId, threadType } = ctx;
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const today = now.getDate();

    try {
        // Chuẩn bị dữ liệu cho 42 ô
        const firstDayOfMonth = new Date(currentYear, currentMonth - 1, 1).getDay();
        const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
        const daysInPrevMonth = new Date(currentYear, currentMonth - 1, 0).getDate();

        const gridDays = [];

        // Ngày của tháng trước
        for (let i = firstDayOfMonth - 1; i >= 0; i--) {
            gridDays.push({
                day: daysInPrevMonth - i,
                currentMonth: false
            });
        }

        // Ngày của tháng hiện tại
        for (let i = 1; i <= daysInMonth; i++) {
            const dateObj = new Date(currentYear, currentMonth - 1, i);
            const l = Lunar.fromDate(dateObj);
            gridDays.push({
                day: i,
                lunarDay: Math.abs(l.getDay()),
                lunarMonth: Math.abs(l.getMonth()),
                currentMonth: true,
                isToday: i === today
            });
        }

        // Ngày của tháng sau
        const remaining = 42 - gridDays.length;
        for (let i = 1; i <= remaining; i++) {
            gridDays.push({
                day: i,
                currentMonth: false
            });
        }

        const buffer = await drawCalendarMonthly(currentMonth, currentYear, gridDays);
        const tmpFile = path.join(process.cwd(), `calendar_${Date.now()}.png`);
        fs.writeFileSync(tmpFile, buffer);

        try {
            await api.sendMessage({ msg: "", attachments: [tmpFile] }, threadId, threadType);
        } finally {
            if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        }

    } catch (e) {
        return api.sendMessage({ msg: "⚠️ Lỗi: " + e.message }, threadId, threadType);
    }
}
