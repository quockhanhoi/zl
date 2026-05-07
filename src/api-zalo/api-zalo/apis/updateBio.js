import { Zalo } from "../index.js";
import { appContext } from "../context.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { encodeAES, handleZaloResponse, request, makeURL } from "../utils.js";

export function updateBioFactory(api) {
    const endpoints = [
        `${api.zpwServiceMap.profile[0]}/api/social/profile/update`,
        `${api.zpwServiceMap.profile[0]}/api/user/status`,
        `${api.zpwServiceMap.profile[0]}/api/user/about`,
        `${api.zpwServiceMap.profile[0]}/api/user/update`,
        `${api.zpwServiceMap.profile[0]}/api/social/user/update`,
        `${api.zpwServiceMap.profile[0]}/api/profile/update`,
    ];

    return async function updateBio(bio) {
        if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent)
            throw new ZaloApiError("Missing required app context fields");

        const safeBio = String(bio ?? "").replace(/\s+/g, " ").trim();
        if (!safeBio) throw new ZaloApiError("Bio không được để trống");

        const paramsList = [
            { bio: safeBio, imei: appContext.imei },
            { description: safeBio, imei: appContext.imei },
            { signature: safeBio, imei: appContext.imei },
            { about: safeBio, imei: appContext.imei },
            { status: safeBio, imei: appContext.imei },
            { userAbout: safeBio, imei: appContext.imei },
            { bio: safeBio, userid: appContext.uid, imei: appContext.imei },
            { desc: safeBio, imei: appContext.imei },
            { content: safeBio, imei: appContext.imei },
            { text: safeBio, imei: appContext.imei },
            { value: safeBio, imei: appContext.imei },
            { bio: safeBio, imei: appContext.imei, type: "bio" },
            { bio: safeBio, imei: appContext.imei, action: "update_bio" },
            { bio: safeBio, imei: appContext.imei, field: "bio" },
            { bio: safeBio, imei: appContext.imei, what: "bio" },
            { bio: safeBio, imei: appContext.imei, feature: "bio" },
        ];

        for (const endpoint of endpoints) {
            const serviceURL = makeURL(endpoint, {
                zpw_ver: Zalo.API_VERSION,
                zpw_type: Zalo.API_TYPE,
            });

            for (const params of paramsList) {
                try {
                    const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(params));
                    if (!encryptedParams) throw new ZaloApiError("Failed to encrypt params");

                    const response = await request(serviceURL, {
                        method: "POST",
                        body: new URLSearchParams({ params: encryptedParams }),
                    });

                    const result = await handleZaloResponse(response);
                    if (!result.error) return result.data;
                } catch (e) {
                    const code = e?.code;
                    if (code && code !== 114) throw e;
                }
            }
        }

        throw new ZaloApiError("Không thể cập nhật tiểu sử. Zalo có thể không hỗ trợ API này.");
    };
}
