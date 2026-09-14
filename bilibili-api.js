const crypto = require('crypto');

// 對齊 parse.shenzjd.com：B 站 Web API 缺 WBI（wts/w_rid）會回 code=-412
const BILIBILI_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
    26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
    20, 34, 44, 52
];

const WBI_KEY_TTL_MS = 12 * 60 * 60 * 1000;
const ANON_COOKIE_KEYS = new Set(['buvid3', 'buvid4', 'b_nut', 'buvid', 'b_lsid']);

function generateBuvid3() {
    const hex = (n) =>
        Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16).toUpperCase()).join('');
    return `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(4)}${hex(8)}infoc`;
}

let anonCookie = `buvid3=${generateBuvid3()}`;
let wbiKeyCache = null;
let refreshing = null;

function md5(text) {
    return crypto.createHash('md5').update(text).digest('hex');
}

function getMixinKey(imgKey, subKey) {
    const orig = imgKey + subKey;
    let str = '';
    for (const i of MIXIN_KEY_ENC_TAB) {
        if (i < orig.length) str += orig[i];
    }
    return str.slice(0, 32);
}

function signQuery(params, mixinKey) {
    const wts = Math.floor(Date.now() / 1000);
    const merged = { ...params, wts };
    const query = Object.keys(merged)
        .sort()
        .map((key) => {
            const value = String(merged[key]).replace(/[!'()*]/g, '');
            return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
        })
        .join('&');
    return `${query}&w_rid=${md5(query + mixinKey)}`;
}

function getHeaders() {
    return {
        'User-Agent': BILIBILI_USER_AGENT,
        Referer: 'https://www.bilibili.com/',
        Origin: 'https://www.bilibili.com',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Cookie: anonCookie
    };
}

function captureCookies(response) {
    let setCookies = [];
    if (typeof response.headers.getSetCookie === 'function') {
        setCookies = response.headers.getSetCookie();
    } else if (response.headers.get && typeof response.headers.get === 'function') {
        const single = response.headers.get('set-cookie');
        if (single) setCookies = [single];
    } else {
        const raw = response.headers['set-cookie'];
        if (raw) setCookies = Array.isArray(raw) ? raw : [raw];
    }
    if (!setCookies.length) return;
    const list = setCookies;
    const current = new Map();
    for (const part of anonCookie.split(';')) {
        const [name, ...rest] = part.trim().split('=');
        if (name) current.set(name, rest.join('='));
    }
    for (const sc of list) {
        const pair = sc.split(';')[0].trim();
        const [name, ...rest] = pair.split('=');
        if (ANON_COOKIE_KEYS.has(name)) {
            current.set(name, rest.join('='));
        }
    }
    anonCookie = Array.from(current.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function fetchJson(url, extra = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), extra.timeout || 10000);
    try {
        const response = await fetch(url, {
            headers: getHeaders(),
            signal: controller.signal
        });
        captureCookies(response);
        const data = await response.json();
        if (!response.ok) {
            const error = new Error(`Request failed with status code ${response.status}`);
            error.response = { status: response.status, data };
            throw error;
        }
        return { status: response.status, data, headers: response.headers };
    } finally {
        clearTimeout(timer);
    }
}

async function fetchKeysFromNav() {
    try {
        const response = await fetchJson('https://api.bilibili.com/x/web-interface/nav', { timeout: 3000 });
        const img = response.data?.data?.wbi_img;
        if (!img?.img_url || !img?.sub_url) return null;
        const imgKey = img.img_url.split('/').pop().replace(/\.[a-zA-Z]+$/, '');
        const subKey = img.sub_url.split('/').pop().replace(/\.[a-zA-Z]+$/, '');
        if (!imgKey || !subKey) return null;
        return { imgKey, subKey, fetchedAt: Date.now() };
    } catch (error) {
        console.warn(`[bilibili-wbi] nav 取得金鑰失敗: ${error.message}`);
        return null;
    }
}

async function getWbiKeys() {
    if (wbiKeyCache && Date.now() - wbiKeyCache.fetchedAt < WBI_KEY_TTL_MS) {
        return { ...wbiKeyCache, mixinKey: getMixinKey(wbiKeyCache.imgKey, wbiKeyCache.subKey) };
    }

    if (!refreshing) {
        refreshing = fetchKeysFromNav().then((fresh) => {
            if (fresh) wbiKeyCache = fresh;
            return Boolean(fresh);
        }).finally(() => {
            refreshing = null;
        });
    }
    await refreshing;

    if (wbiKeyCache) {
        return { ...wbiKeyCache, mixinKey: getMixinKey(wbiKeyCache.imgKey, wbiKeyCache.subKey) };
    }
    return null;
}

async function signWbiParams(params) {
    const keys = await getWbiKeys();
    if (!keys) return null;
    return signQuery(params, keys.mixinKey);
}

async function buildSignedUrl(pathname, params) {
    const signed = await signWbiParams(params);
    const query = signed || Object.keys(params)
        .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
        .join('&');
    return `https://api.bilibili.com${pathname}?${query}`;
}

async function biliGet(pathname, params, extra = {}) {
    const url = await buildSignedUrl(pathname, params);
    return fetchJson(url, extra);
}

function fetchBiliView(bvid) {
    return biliGet('/x/web-interface/wbi/view', { bvid });
}

function fetchBiliPlayurl(params) {
    return biliGet('/x/player/wbi/playurl', params);
}

module.exports = {
    BILIBILI_USER_AGENT,
    getHeaders,
    fetchBiliView,
    fetchBiliPlayurl,
    buildSignedUrl
};
