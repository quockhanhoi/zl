import { Zalo } from "../index.js";
import { appContext } from "../context.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { encodeAES, handleZaloResponse, request, makeURL } from "../utils.js";

export function updateProfileFactory(api) {
    const serviceURL = makeURL(`${api.zpwServiceMap.profile[0]}/api/social/profile/update`, {
        zpw_ver: Zalo.API_VERSION,
        zpw_type: Zalo.API_TYPE,
    });
    /**
     * Update account profile (name, date of birth, gender)
     *
     * @param {string} name - New account name
     * @param {string} dob - Date of birth (format: YYYY-MM-DD, default: "2002-12-06")
     * @param {number} gender - Gender (0: male, 1: female, default: 0)
     *
     * @throws ZaloApiError
     */
    return async function updateProfile(name, dob = "2002-12-06", gender = 0) {
        if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent)
            throw new ZaloApiError("Missing required app context fields");

        const safeName = String(name ?? "").replace(/\s+/g, " ").trim();
        if (!safeName) throw new ZaloApiError("Name is not blank");

        const safeDob = String(dob ?? "2002-12-06");
        const dobOk = /^\d{4}-\d{2}-\d{2}$/.test(safeDob);
        const safeGender = Number.isFinite(Number(gender)) ? Number(gender) : 0;

        const tryPayloads = [
            // Payload 1: name + imei (Tối giản nhất)
            { name: safeName, imei: appContext.imei },
            // Payload 2: displayName + imei (Một số build mới dùng key này)
            { displayName: safeName, imei: appContext.imei },
            // Payload 3: zname + imei
            { zname: safeName, imei: appContext.imei },
            // Payload 4: Full chuẩn cũ
            {
                name: safeName,
                dob: dobOk ? safeDob : "2002-12-06",
                gender: safeGender,
                imei: appContext.imei,
            },
        ];

        let lastErr = null;
        for (const params of tryPayloads) {
            try {
                const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
                if (!encryptedParams) throw new ZaloApiError("Failed to encrypt params");

                const response = await request(serviceURL, {
                    method: "POST",
                    body: new URLSearchParams({ params: encryptedParams }),
                });

                const result = await handleZaloResponse(response);
                if (result.error) throw new ZaloApiError(result.error.message, result.error.code);
                return result.data;
            } catch (e) {
                lastErr = e;
                // Debug log an toàn (không log cookie / params encrypted)
                const code = e?.code;
                const msg = e?.message;
                console.warn(`[updateProfile] Failed with code=${code} msg=${msg} endpoint=${serviceURL}`);
                // nếu code không phải 114 thì không cần thử tiếp
                if (code && code !== 114) throw e;
            }
        }

        throw lastErr;
    };
}

