import { createCipheriv } from 'crypto';
import axios from 'axios';
import protobuf from 'protobufjs';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Cấu hình & Constants ──
const CFG_FILE  = join(__dirname, '../modules/data/ff-accounts.json');
const AES_KEY = Buffer.from('Yg&tc%DEuh6%Zc^8');
const AES_IV  = Buffer.from('6oyZDr22E3ychjM%');
const RELEASE = 'OB53';
const UA_DALVIK = 'Dalvik/2.1.0 (Linux; U; Android 13; A063 Build/TKQ1.221220.001)';

// ── Tiện ích mã hóa ──
function pkcs7Pad(buf) {
    const padLen = 16 - (buf.length % 16);
    return Buffer.concat([buf, Buffer.alloc(padLen, padLen)]);
}

function aesEncrypt(data) {
    const cipher = createCipheriv('aes-128-cbc', AES_KEY, AES_IV);
    cipher.setAutoPadding(false);
    const padded = pkcs7Pad(Buffer.isBuffer(data) ? data : Buffer.from(data));
    return Buffer.concat([cipher.update(padded), cipher.final()]);
}

// ── Load Config ──
let accounts = {};
function loadAccounts() {
    try {
        if (!existsSync(CFG_FILE)) return {};
        const data = readFileSync(CFG_FILE, 'utf8');
        accounts = JSON.parse(data);
        return accounts;
    } catch { return {}; }
}
loadAccounts();

// ── Protobuf Logic ──
let _T = null;
async function getTypes() {
    if (_T) return _T;
    const root = new protobuf.Root();
    await root.load(join(__dirname, 'FreeFireSimplified.proto'), { keepCase: true });
    _T = {
        MajorLoginReq: root.lookupType('MajorLoginReq'),
        MajorLoginResp: root.lookupType('MajorLoginResp'),
        ShowReq: root.lookupType('ShowReq'),
        ShowResp: root.lookupType('ShowResp'),
        StatsReq: root.lookupType('StatsReq'),
        StatsResp: root.lookupType('StatsResp'),
        CSReq: root.lookupType('CSReq'),
        CSResp: root.lookupType('CSResp'),
        SearchReq: root.lookupType('SearchReq'),
        SearchResp: root.lookupType('SearchResp'),
    };
    return _T;
}

function encEnc(Type, data) {
    const msg = Type.create(data);
    return aesEncrypt(Type.encode(msg).finish());
}

function dec(Type, buf) {
    try {
        return Type.toObject(Type.decode(buf), { longs: String, enums: String, arrays: true });
    } catch { return {}; }
}

// ──────────── AUTH LOGIC ────────────
const _cache = new Map();

async function auth(server, T) {
    const key = server.toUpperCase();
    const cached = _cache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached;

    loadAccounts();
    const cfg = accounts[key];
    if (!cfg) throw new Error(`Server "${key}" không có trong cấu hình.`);

    const garena = (await axios.post('https://ffmconnect.live.gop.garenanow.com/oauth/guest/token/grant', 
        new URLSearchParams({ uid: String(cfg.uid), password: String(cfg.password), response_type: 'token', client_type: '2', client_id: '100067' }),
        { timeout: 15000 }
    )).data;

    if (!garena?.access_token) throw new Error('Đăng nhập Garena thất bại.');

    const loginPayload = encEnc(T.MajorLoginReq, { openid: String(garena.open_id), logintoken: String(garena.access_token), platform: '4' });
    const loginRes = await axios.post('https://loginbp.ggpolarbear.com/MajorLogin', loginPayload, {
        headers: { 'User-Agent': UA_DALVIK, 'Content-Type': 'application/x-www-form-urlencoded', 'ReleaseVersion': RELEASE, 'Authorization': 'Bearer', 'X-GA': 'v1 1' },
        responseType: 'arraybuffer', timeout: 15000
    });
    
    const loginData = dec(T.MajorLoginResp, Buffer.from(loginRes.data));
    if (!loginData?.token || !loginData?.serverUrl) throw new Error('Major Login Failed');

    const entry = { token: loginData.token, serverUrl: loginData.serverUrl, expiresAt: Date.now() + 50 * 60 * 1000 };
    _cache.set(key, entry);
    return entry;
}

// ──────────── PARSING HELPERS ────────────
function extMsg(buf) {
    if (!buf || !Buffer.isBuffer(buf)) return {};
    let pos = 0; const res = {};
    try {
        while (pos < buf.length) {
            let tag = buf[pos++]; if (tag > 127) tag = (tag & 127) | (buf[pos++] << 7);
            let id = tag >> 3, wire = tag & 7;
            let val;
            if (wire === 0) {
                let v = 0n, shift = 0n;
                while (buf[pos] >= 128) { v |= BigInt(buf[pos++] & 127) << shift; shift += 7n; }
                v |= BigInt(buf[pos++]) << shift; val = Number(v);
            } else if (wire === 2) {
                let len = buf[pos++]; if (len > 127) len = (len & 127) | (buf[pos++] << 7);
                val = buf.subarray(pos, pos + len); pos += len;
            } else if (wire === 1) { val = buf.readBigUInt64LE(pos); pos += 8; }
            else if (wire === 5) { val = buf.readUInt32LE(pos); pos += 4; }
            else break;

            if (res[id] !== undefined) {
                if (Array.isArray(res[id])) res[id].push(val);
                else res[id] = [res[id], val];
            } else res[id] = val;
        }
    } catch {} return res;
}

const _str = (v) => Buffer.isBuffer(v) ? v.toString('utf8') : (v ? String(v) : '');

function parseBasic(buf) {
    const d = extMsg(buf);
    return { 
        accountid: String(d[1] || ''), nickname: _str(d[3]), region: _str(d[5]), level: d[6] || 0, exp: d[7] || 0, liked: d[21] || 0,
        rankingpoints: d[15] || 0, csrankingpoints: d[31] || 0, createat: d[44] || 0, lastloginat: d[24] || 0,
        badgeid: d[19] || 0, seasonid: d[20] || 0, csmaxrank: d[36] || 0, maxrankingpoints: d[37] || 0,
        hipporank: d[66] || 0, hipporankingpoints: d[67] || 0
    };
}

function parseProfileInfo(buf) {
    const d = extMsg(buf);
    const toArr = (v) => Array.isArray(v) ? v : (v !== undefined ? [v] : []);
    return {
        avatarid: d[1] || 0,
        clothes: toArr(d[3]),
        equipedskills: toArr(d[4]),
        pveprimaryweapon: d[6] || 0,
        ismarkedstar: d[11] === 1
    };
}

function parseSocial(buf) {
    const d = extMsg(buf);
    const GENDERS = { 0: 'Unknown', 1: 'Nam', 2: 'Nữ' };
    const LANGUAGES = { 0: 'None', 1: 'EN', 5: 'Vietnamese', 8: 'Spanish' };
    return {
        signature: _str(d[9]),
        gender: GENDERS[d[2]] || 'Ẩn',
        language: LANGUAGES[d[3]] || 'Unknown'
    };
}

function parseStatMode(buf, isCS = false) {
    if (!buf) return null;
    const d = extMsg(buf);
    const mode = {
        gamesplayed: d[2] || 0, wins: d[3] || 0, kills: d[4] || 0,
        detailedstats: { damage: 0, headshots: 0 }
    };
    if (d[5] && Buffer.isBuffer(d[5])) {
        const det = extMsg(d[5]);
        if (isCS) {
            mode.detailedstats.damage = det[5] || 0;
            mode.detailedstats.headshots = det[6] || det[17] || 0;
            mode.detailedstats.mvp_count = det[1] || 0;
        } else {
            mode.detailedstats.damage = det[8] || 0;
            mode.detailedstats.headshots = det[10] || det[11] || 0;
        }
    }
    return mode;
}

// ────────────────────────────────────────────────────────────────
//  PUBLIC API (100% PURE JS)
// ────────────────────────────────────────────────────────────────

export const ffApi = {
    getProfile: async (uid, server = 'VN') => {
        try {
            const T = await getTypes();
            const { token, serverUrl } = await auth(server, T);
            const payload = encEnc(T.ShowReq, { accountId: String(uid), callSignSrc: 7 });
            const res = await axios.post(`${serverUrl}/GetPlayerPersonalShow`, payload, {
                headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': UA_DALVIK, 'ReleaseVersion': RELEASE, 'X-GA': 'v1 1' },
                responseType: 'arraybuffer', timeout: 15000
            });
            const decoded = dec(T.ShowResp, Buffer.from(res.data));
            
            const pBasic = parseBasic(decoded.basicinfo);
            const pProf  = parseProfileInfo(decoded.profileinfo);
            const pSoc   = parseSocial(decoded.socialinfo);
            const clanMsg = extMsg(decoded.clanbasicinfo);
            const petMsg = extMsg(decoded.petinfo);
            const diaMsg = extMsg(decoded.diamondcostres);
            const creMsg = extMsg(decoded.creditscoreinfo);

            return { 
                status: 'success', 
                basicinfo: pBasic,
                profileinfo: pProf,
                clanbasicinfo: { clanname: _str(clanMsg[2]), clanlevel: clanMsg[4] },
                petinfo: { name: _str(petMsg[2]), level: petMsg[3] },
                socialinfo: pSoc,
                diamondcostres: { diamondcost: diaMsg[1] || 0 },
                creditscoreinfo: { creditscore: creMsg[1] || 0 }
            };
        } catch (e) {
            return { status: 'error', error: e.message };
        }
    },

    getStats: async (uid, server = 'VN', mode = 'br') => {
        try {
            const T = await getTypes();
            const { token, serverUrl } = await auth(server, T);
            const isCS = mode.toLowerCase() === 'cs';
            const payload = isCS 
                ? encEnc(T.CSReq, { accountid: String(uid), gamemode: 15, matchmode: 0 })
                : encEnc(T.StatsReq, { accountid: String(uid), matchmode: 0 });
            const endpoint = isCS ? 'GetPlayerTCStats' : 'GetPlayerStats';
            const res = await axios.post(`${serverUrl}/${endpoint}`, payload, {
                headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': UA_DALVIK, 'ReleaseVersion': RELEASE, 'X-GA': 'v1 1' },
                responseType: 'arraybuffer', timeout: 15000
            });
            const decoded = dec(isCS ? T.CSResp : T.StatsResp, Buffer.from(res.data));
            
            return { 
                success: true, 
                data: isCS 
                    ? { csstats: parseStatMode(decoded.csstats, true) }
                    : { 
                        solostats: parseStatMode(decoded.solostats),
                        duostats:  parseStatMode(decoded.duostats),
                        quadstats: parseStatMode(decoded.quadstats)
                    }
            };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    searchPlayer: async (keyword, server = 'VN') => {
        try {
            const T = await getTypes();
            const { token, serverUrl } = await auth(server, T);
            const payload = encEnc(T.SearchReq, { keyword: String(keyword) });
            const res = await axios.post(`${serverUrl}/FuzzySearchAccountByName`, payload, {
                headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': UA_DALVIK, 'ReleaseVersion': RELEASE, 'X-GA': 'v1 1' },
                responseType: 'arraybuffer', timeout: 15000
            });
            const decoded = dec(T.SearchResp, Buffer.from(res.data));
            return { infos: (decoded.infos || []).map(b => parseBasic(b)) };
        } catch (e) {
            return { error: e.message };
        }
    },
};
