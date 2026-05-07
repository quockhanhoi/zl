import axios from "axios";
import http from 'http';
import https from 'https';

const XOR_KEY = "IFYOUWANTTHEARTISTSTOGETPAIDDONOTDOWNLOADFROMMIXCLOUD";

const xorDecrypt = (cipher) => {
    try {
        if (!cipher) return null;
        const data = Buffer.from(cipher, 'base64');
        return Array.from(data).map((b, i) => String.fromCharCode(b ^ XOR_KEY.charCodeAt(i % XOR_KEY.length))).join('');
    } catch { return null; }
};

const axiosInstance = axios.create({
    httpAgent: new http.Agent({ keepAlive: false }),
    httpsAgent: new https.Agent({ keepAlive: false })
});

const gqlHeaders = {
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'origin': 'https://www.mixcloud.com',
    'referer': 'https://www.mixcloud.com/',
    'x-mixcloud-client-version': '6148af584d01e21cc497b21aeb93a3c035352594'
};

export async function downloadMixcloud(inputUrl) {
    try {
        const urlObj = new URL(inputUrl);
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        if (pathParts.length < 2) return { error: "Link Mixcloud không hợp lệ." };

        const username = pathParts[0];
        const slug = pathParts[1];

        const query = `query GetMixFull($l: CloudcastLookup!) {
          cloudcastLookup(lookup: $l) {
            ... on Cloudcast {
              id
              name
              audioLength
              isExclusive
              owner { displayName username }
              picture { url }
              streamInfo(timestamper: false) { url hlsUrl }
            }
          }
        }`;

        const resp = await axios.post("https://app.mixcloud.com/graphql", {
            query: query,
            variables: { l: { username, slug: decodeURIComponent(slug) } }
        }, {
            headers: gqlHeaders,
            timeout: 15000
        });

        const cc = resp?.data?.data?.cloudcastLookup;

        if (!cc || !cc.streamInfo) {
            return { error: "Không lấy được thông tin bài hát. Có thể link đã đổi hoặc bản quyền." };
        }

        const rawUrl = cc.streamInfo.url || cc.streamInfo.hlsUrl;

        return {
            title: cc.name,
            author: cc.owner?.displayName || cc.owner?.username,
            duration: cc.audioLength,
            streamUrl: xorDecrypt(rawUrl),
            hlsUrl: xorDecrypt(cc.streamInfo.hlsUrl),
            thumb: cc.picture?.url || null,
        };
    } catch (e) {
        return { error: `Lỗi Mixcloud: ${e.message}` };
    }
}

export async function searchMixcloud(term, limit = 10) {
    try {
        const resp = await axiosInstance.get("https://api.mixcloud.com/search/", {
            params: { q: term, type: "cloudcast", limit }
        });
        return (resp.data?.data || []).map(item => ({
            title: item.name,
            url: item.key || item.url?.replace("https://www.mixcloud.com", ""),
            artist: item.user?.name,
            duration: item.audio_length,
            thumbnail: item.pictures?.extra_large || item.pictures?.large || null,
        })).filter(r => r.title);
    } catch (e) {
        return null;
    }
}
