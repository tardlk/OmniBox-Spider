// @name FKTV
// @author 梦
// @description 刮削：已接入，弹幕：未接入，播放：走站内加密接口直取 m3u8（双线路，直链播放）
// @version 2.0.0
// @downloadURL https://gh-proxy.org/https://github.com/tardlk/OmniBox-Spider/raw/refs/heads/main/影视/采集/FKTV.js

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");
const crypto = require("crypto");

// ======================== 站点常量 ========================
// 站点已改成 Next.js + 私有接口：网页里没有直链，所有数据都走 POST /ysapi/<endpoint>，
// 请求体与响应体都是 AES-128-ECB(PKCS7, base64)，key 就是前端 chunk 里的 apiKey。
const BASE_URL = "https://fktv.me";
const API_BASE = `${BASE_URL}/ysapi`;
const API_KEY = "9ed1a661a6ab787a";
const API_VERSION = "1.0";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const DEVICE_ID = crypto.createHash("md5").update("fktv-omnibox-v2").digest("hex");
const MAX_EPISODES = 300;

// 分类：type_id 直接用站方 cat_id，省得再维护一层映射
const CATEGORIES = [
  { type_id: "6", type_name: "电影", code: "movie" },
  { type_id: "5", type_name: "电视剧", code: "tv" },
  { type_id: "4", type_name: "综艺", code: "zy" },
  { type_id: "7", type_name: "动漫", code: "comic" },
  { type_id: "9", type_name: "短剧", code: "short_tv" },
  { type_id: "8", type_name: "纪录片", code: "jlp" },
  { type_id: "11", type_name: "电影解说", code: "js" },
  { type_id: "10", type_name: "音乐", code: "music" }
];

const PLAY_HEADERS = {
  "User-Agent": UA,
  "Referer": `${BASE_URL}/`,
  "Origin": BASE_URL
};

// ======================== 工具 ========================
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// SDK 的 request() 是裸 http/https：options.timeout 不生效、连接挂住不会断，
// 超时后残留的 socket 还会把进程拖到几十秒才退出。这里自己发请求，能真正超时并 destroy。
let _https = null;
let _http = null;
let _zlib = null;
try {
  _https = require("https");
  _http = require("http");
  _zlib = require("zlib");
} catch {
  _https = null;
}

function _decodeBody(res, chunks) {
  let buf = Buffer.concat(chunks);
  const encoding = String((res.headers && res.headers["content-encoding"]) || "").toLowerCase();
  try {
    if (encoding === "gzip" && _zlib) buf = _zlib.gunzipSync(buf);
    else if (encoding === "deflate" && _zlib) buf = _zlib.inflateSync(buf);
    else if (encoding === "br" && _zlib) buf = _zlib.brotliDecompressSync(buf);
  } catch {
    // 解压失败就按原文返回
  }
  return buf.toString("utf8");
}

function _httpPost(url, headers, body, timeout, family) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === "https:" ? _https : _http;
    if (!lib) {
      reject(new Error("当前环境不支持原生 http 请求"));
      return;
    }
    const options = {
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      method: "POST",
      // 不复用连接：Node 19+ 的全局 agent 默认 keepAlive，池里的死连接会拖到超时才报错
      agent: false,
      headers: { ...headers, "Content-Length": Buffer.byteLength(body) }
    };
    // 优先走 IPv4：某些环境 AAAA 记录连不通，会白等一个连接超时
    if (family) options.family = family;

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: _decodeBody(res, chunks) });
        } catch (e) {
          reject(e);
        }
      });
      res.on("error", reject);
    });

    req.setTimeout(timeout, () => {
      req.destroy(new Error(`请求超时(${timeout}ms)`));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function _log(level, message, extra) {
  let suffix = "";
  if (typeof extra !== "undefined") {
    try {
      suffix = ` | ${JSON.stringify(extra)}`;
    } catch {
      suffix = "";
    }
  }
  // 不 await：宿主日志接口自身没有超时，卡住会拖死整个请求
  try {
    const pending = OmniBox.log(level, `[FKTV] ${message}${suffix}`);
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {
    // 日志失败不影响主流程
  }
}

// 排障用：设 FKTV_DEBUG=1 时把关键步骤打到 stderr（宿主会收集 stderr）
const DEBUG = String(process.env.FKTV_DEBUG || "") === "1";
function _trace(message, extra) {
  if (!DEBUG) return;
  let suffix = "";
  if (typeof extra !== "undefined") {
    try {
      suffix = ` | ${JSON.stringify(extra)}`;
    } catch {
      suffix = "";
    }
  }
  try {
    console.error(`[FKTV] ${message}${suffix}`);
  } catch {
    // ignore
  }
}

function _timeString(date) {
  const d = date || new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function _aesKey() {
  return Buffer.from(API_KEY, "utf8");
}

function _aesEncrypt(obj) {
  const cipher = crypto.createCipheriv("aes-128-ecb", _aesKey(), null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]).toString("base64");
}

function _aesDecrypt(text) {
  try {
    const decipher = crypto.createDecipheriv("aes-128-ecb", _aesKey(), null);
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(Buffer.from(text, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

// 宿主偶尔会把 text 响应体再 JSON 编码一层（首尾引号 + \" 转义）
function _bodyText(res) {
  let body = res && typeof res === "object" && "body" in res ? res.body : res;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) body = Buffer.from(body).toString("utf8");
  let text = typeof body === "string" ? body : String(body == null ? "" : body);
  text = text.trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const inner = JSON.parse(text);
      if (typeof inner === "string") text = inner.trim();
    } catch {
      // 保持原样
    }
  }
  return text;
}

function _parsePayload(text) {
  if (!text) return null;
  const raw = text.trim();
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const plain = _aesDecrypt(raw);
  if (!plain) return null;
  try {
    return JSON.parse(plain.trim());
  } catch {
    return null;
  }
}

function _absUrl(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  return `${BASE_URL}${u.startsWith("/") ? "" : "/"}${u}`;
}

function _pagination(page, pageSize, total) {
  const safePage = Number.isFinite(page) && page > 0 ? page : 1;
  const safeSize = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 30;
  const safeTotal = Number.isFinite(total) && total >= 0 ? total : 0;
  const pagecount = safeTotal > 0 ? Math.ceil(safeTotal / safeSize) : safePage;
  return { page: safePage, pagecount, limit: safeSize, total: safeTotal };
}

// ======================== 接口层 ========================
function _apiHeaders() {
  return {
    "version": API_VERSION,
    "deviceType": "pc",
    "time": _timeString(),
    "shareCode": "",
    "channel": "",
    "ip": "",
    "Content-Type": "application/octet-stream",
    "User-Agent": UA,
    "Accept": "*/*",
    "Origin": BASE_URL,
    "Referer": `${BASE_URL}/`
  };
}

function _apiBody(data) {
  return _aesEncrypt({
    deviceId: DEVICE_ID,
    token: null,
    domain: "fktv.me",
    referer: "",
    user_agent: UA,
    shareCode: "",
    channel: "",
    ip: "",
    data: data || {}
  });
}

async function _api(endpoint, data, options) {
  const opts = options || {};
  const attempts = opts.attempts || 2;
  const timeout = opts.timeout || 12000;
  const startedAt = Date.now();
  let lastError = "";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const attemptStart = Date.now();
    try {
      const headers = _apiHeaders();
      const body = _apiBody(data);
      const res = _https
        ? await _httpPost(`${API_BASE}/${endpoint}`, headers, body, timeout, attempt === 1 ? 4 : 0)
        : await OmniBox.request(`${API_BASE}/${endpoint}`, { method: "POST", headers, body });
      _trace(`${endpoint} 收到响应`, { attempt, ms: Date.now() - attemptStart, code: res && res.statusCode, len: res && res.body ? res.body.length : 0 });
      const statusCode = res && res.statusCode ? res.statusCode : 200;
      const text = _bodyText(res);
      const json = _parsePayload(text);

      if (!json) {
        lastError = `响应不可解析(code=${statusCode}, len=${text.length}, head=${text.slice(0, 32)})`;
        _trace(`${endpoint} 响应不可解析`, { attempt, statusCode, head: text.slice(0, 120) });
        await _log("warn", `${endpoint} 响应不可解析`, { attempt, statusCode, head: text.slice(0, 80) });
      } else if (json.status === "y") {
        await _log("info", `${endpoint} ok`, { ms: Date.now() - startedAt, attempt });
        return json;
      } else {
        lastError = json.error || "接口返回失败";
        await _log("warn", `${endpoint} 接口失败`, { attempt, error: json.error, errorCode: json.errorCode });
        // 业务错误重试没意义（参数错误/未实现），直接返回
        if (json.errorCode && json.errorCode !== 2001) return json;
      }
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
      _trace(`${endpoint} 请求异常`, { attempt, ms: Date.now() - attemptStart, message: lastError });
      await _log("warn", `${endpoint} 请求异常`, { attempt, message: lastError });
    }
    if (attempt < attempts) await _sleep(400);
  }

  await _log("error", `${endpoint} 最终失败`, { ms: Date.now() - startedAt, error: lastError });
  return null;
}

// ======================== 映射 ========================
function _toVod(item, typeId) {
  if (!item || !item.id) return null;
  const score = Number(item.score);
  const remarks = [];
  if (item.release_at) remarks.push(String(item.release_at));
  if (Number.isFinite(score) && score > 0) remarks.push(`${score.toFixed(1)}分`);
  if (item.today_update_num && Number(item.today_update_num) > 0) remarks.push(`今日+${item.today_update_num}`);

  return {
    vod_id: item.id,
    vod_name: item.name || item.name_tw || "",
    // img_x 是加密过的 .bnc，播放器解不了；优先用 CDN 上的真 PNG
    vod_pic: item.img_x_source || item.img_y_source || item.img_x || item.img_y || "",
    vod_remarks: remarks.join(" · "),
    type_id: String(typeId || item.cat_id || ""),
    type_name: item.category || item.child_title || "",
    vod_content: item.description || ""
  };
}

function _dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const it of list) {
    if (!it || !it.vod_id || seen.has(it.vod_id)) continue;
    seen.add(it.vod_id);
    out.push(it);
  }
  return out;
}

// ======================== 方法 ========================
async function home() {
  // movie/home 一次下发 350KB+，弱网下要十几秒；首页只要「最新更新」，
  // 用 search 空关键词拉一页（约 27KB）就够，块级推荐留着当兜底。
  const list = [];
  const quick = await _api("movie/search", { keywords: "", page: 1, page_size: 30, order: "last_update" }, { timeout: 12000 });
  if (quick && quick.data && Array.isArray(quick.data.data)) {
    list.push(...quick.data.data);
  }

  if (!list.length) {
    const res = await _api("movie/home", {}, { timeout: 15000 });
    const data = (res && res.data) || {};
    const raw = [];
    if (Array.isArray(data.new_items)) raw.push(...data.new_items);
    if (Array.isArray(data.main_block)) {
      for (const block of data.main_block) {
        if (block && Array.isArray(block.items)) raw.push(...block.items);
      }
    }
    if (Array.isArray(data.other_block)) {
      for (const block of data.other_block) {
        if (block && Array.isArray(block.items)) raw.push(...block.items);
      }
    }
    list.push(...raw);
  }

  const vods = _dedupe(list.map((it) => _toVod(it)).filter(Boolean)).slice(0, 60);
  await _log("info", "home 结束", { count: vods.length, first: vods[0] ? vods[0].vod_name : null });

  return { class: CATEGORIES.map((c) => ({ type_id: c.type_id, type_name: c.type_name })), list: vods };
}

async function category(params) {
  const page = Number(params.page) > 0 ? Number(params.page) : 1;
  const pageSize = Number(params.page_size) > 0 ? Number(params.page_size) : 30;
  let typeId = String(params.type_id || params.cat_id || params.typeId || params.type || "").trim();
  const order = params.order || "last_update";

  // 兼容传分类代号（movie/tv/...）的客户端
  if (typeId && !/^\d+$/.test(typeId)) {
    const hit = CATEGORIES.find((c) => c.code === typeId);
    if (hit) typeId = hit.type_id;
    else typeId = "";
  }

  const query = { keywords: "", page, page_size: pageSize, order };
  if (typeId) query.cat_id = typeId;

  await _log("info", "category 入参", { typeId, page, pageSize, order });

  const res = await _api("movie/search", query);
  const data = (res && res.data) || {};
  const items = Array.isArray(data.data) ? data.data : [];
  const list = items.map((it) => _toVod(it, typeId)).filter(Boolean);
  const total = Number(data.total) || 0;

  await _log("info", "category 结束", {
    typeId,
    page,
    count: list.length,
    total,
    first: list[0] ? list[0].vod_name : null
  });

  return { ..._pagination(page, pageSize, total), list };
}

async function detail(params) {
  const id = String(params.videoId || params.vod_id || params.id || "").trim();
  if (!id) return { list: [] };

  await _log("info", "detail 入参", { id });
  const res = await _api("movie/detail", { id });
  const data = (res && res.data) || {};
  if (!data.id && !data.name) {
    await _log("warn", "detail 无数据", { id, error: res && res.error });
    return { list: [] };
  }

  const movieId = data.id || id;
  const links = Array.isArray(data.links) ? data.links.filter((it) => it && it.id) : [];
  const playback = data.playback_v2 || {};
  let lines = Array.isArray(playback.video_lines) ? playback.video_lines.filter(Boolean) : [];
  if (!lines.length) lines = [{ line: "cn", name: "线路1" }];

  // links 对剧集是「集」，对电影是「版本（抢先版/1080P）」，结构一样，统一当条目用
  let episodes = links.map((it, idx) => ({
    id: it.id,
    name: String(it.name || "").trim() || `第${idx + 1}集`
  }));
  if (!episodes.length && data.link_id) episodes = [{ id: data.link_id, name: "正片" }];
  if (episodes.length > MAX_EPISODES) episodes = episodes.slice(0, MAX_EPISODES);

  const vodPlaySources = lines.map((line) => ({
    name: line.name || line.line || "线路",
    episodes: episodes.map((ep) => ({
      name: ep.name,
      playId: `${movieId}|${ep.id}|${line.line || "cn"}`
    }))
  }));

  const remarks = [];
  if (data.category || data.categories) remarks.push(data.category || data.categories);
  if (data.play_error_type && data.play_error_type !== "none") remarks.push(data.play_error_type);

  await _log("info", "detail 结束", {
    name: data.name,
    position: data.position,
    links: links.length,
    lines: lines.map((l) => `${l.line}/${l.name}`),
    sources: vodPlaySources.map((s) => `${s.name}:${s.episodes.length}`),
    playErrorType: data.play_error_type
  });

  return {
    list: [{
      vod_id: movieId,
      vod_name: data.name || "",
      vod_pic: data.img_x_source || data.img_y_source || data.img_x || data.img_y || "",
      vod_content: data.description || "",
      vod_remarks: remarks.join(" · "),
      vod_year: data.release_at || "",
      vod_area: data.area || "",
      vod_actor: data.actor || "",
      vod_director: data.director || "",
      type_name: data.category || data.child_title || "",
      vod_play_sources: vodPlaySources
    }]
  };
}

function _parsePlayId(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  // 兼容 1.x 的 JSON playId
  if (text.startsWith("{")) {
    try {
      const meta = JSON.parse(text);
      const movieId = meta.movie_id || meta.movieId || "";
      const linkId = meta.link_id || meta.linkId || "";
      if (movieId || linkId) return { movieId, linkId, line: meta.line_id || meta.line || "" };
    } catch {
      return null;
    }
    return null;
  }

  const parts = text.split("|");
  if (parts.length >= 2) {
    return { movieId: parts[0], linkId: parts[1], line: parts[2] || "" };
  }
  return null;
}

async function play(params) {
  try {
    const raw = String(params.playId || params.play_id || params.url || "").trim();
    await _log("info", "play 入参", { playId: raw.slice(0, 120) });
    if (!raw) return { parse: 0, url: "", urls: [] };

    // 已经是直链就直接放
    if (/^https?:\/\//i.test(raw) && /\.(m3u8|mp4|flv)(\?|$)/i.test(raw)) {
      return { parse: 0, url: raw, urls: [{ name: "直链", url: raw }], header: PLAY_HEADERS, headers: PLAY_HEADERS };
    }

    const meta = _parsePlayId(raw);
    if (!meta) {
      await _log("warn", "play 无法解析 playId", { raw: raw.slice(0, 120) });
      return { parse: 0, url: "", urls: [] };
    }

    const query = { id: meta.movieId };
    if (meta.linkId) query.link_id = meta.linkId;

    const res = await _api("movie/detail", query);
    const data = (res && res.data) || {};
    const playback = data.playback_v2 || {};
    const lines = Array.isArray(playback.video_lines) ? playback.video_lines.filter(Boolean) : [];

    // 用户点的线路排最前，其它线路作为备选
    const preferred = lines.filter((l) => l.line === meta.line);
    const rest = lines.filter((l) => l.line !== meta.line);
    const ordered = preferred.concat(rest);

    const urls = [];
    for (const line of ordered) {
      const h264 = line.h264 && line.h264.url ? _absUrl(line.h264.url) : "";
      const hevc = line.hevc && line.hevc.url ? _absUrl(line.hevc.url) : "";
      const url = h264 || hevc;
      if (!url) continue;
      urls.push({ name: `${line.name || line.line}${!h264 && hevc ? "(HEVC)" : ""}`, url });
    }

    // playback_v2 没下发时，退回 play_links（站方预览档，只保证前 50 秒，聊胜于无）
    if (!urls.length && Array.isArray(data.play_links)) {
      for (const pl of data.play_links) {
        const url = _absUrl(pl && pl.m3u8_url);
        if (url) urls.push({ name: `${pl.name || "线路"}(预览)`, url });
      }
    }
    // 再退一步：站方 CDN 上的原始 m3u8（无签名，能开就能放整片）
    if (!urls.length) {
      const src = _absUrl(data.m3u8_url_source);
      if (src) urls.push({ name: "源地址", url: src });
    }

    if (!urls.length) {
      await _log("warn", "play 无可播地址", {
        movieId: meta.movieId,
        linkId: meta.linkId,
        line: meta.line,
        playErrorType: data.play_error_type,
        playError: data.play_error
      });
      return { parse: 0, url: "", urls: [] };
    }

    const result = {
      parse: 0,
      url: urls[0].url,
      urls,
      header: PLAY_HEADERS,
      headers: PLAY_HEADERS
    };
    await _log("info", "play 成功", {
      movieId: meta.movieId,
      linkId: meta.linkId,
      line: meta.line,
      picked: urls[0].name,
      alternatives: urls.length - 1,
      url: urls[0].url.slice(0, 110)
    });
    return result;
  } catch (e) {
    await _log("error", "play 异常", { message: e && e.message, stack: e && e.stack });
    return { parse: 0, url: "", urls: [] };
  }
}

async function search(params) {
  const keyword = String(params.keyword || params.key || params.wd || "").trim();
  const page = Number(params.page) > 0 ? Number(params.page) : 1;
  const pageSize = Number(params.page_size) > 0 ? Number(params.page_size) : 30;

  await _log("info", "search 入参", { keyword, page, pageSize });
  if (!keyword) return { ..._pagination(page, pageSize, 0), list: [] };

  const res = await _api("movie/search", { keywords: keyword, page, page_size: pageSize });
  const data = (res && res.data) || {};
  const items = Array.isArray(data.data) ? data.data : [];
  const list = items.map((it) => _toVod(it)).filter(Boolean);
  const total = Number(data.total) || 0;

  await _log("info", "search 结束", {
    keyword,
    page,
    count: list.length,
    total,
    first: list[0] ? list[0].vod_name : null
  });

  return { ..._pagination(page, pageSize, total), list };
}

runner.run({ home, category, detail, search, play });
