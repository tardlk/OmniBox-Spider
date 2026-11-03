// @name 88看球
// @dependencies: axios, cheerio, crypto-js
// @version 1.2.0
// @downloadURL https://gh-proxy.org/https://github.com/tardlk/OmniBox-Spider/raw/refs/heads/main/影视/采集/88看球.js
/**
 * 刮削：不支持
 * 弹幕：不支持
 * 嗅探：不支持
 *
 * 说明：
 * 1. 本脚本由 `本地调试/88看球.js` 转换为 OmniBox 标准模板结构。
 * 2. 接口包含：`home` / `category` / `search` / `detail` / `play`。
 * 3. 详情接口将旧式 `vod_play_from + vod_play_url` 转换为 `vod_play_sources`。
 * 4. `playId` 只存 `{g:比赛ID,i:线路序号,n:线路名}` 的 base64url（约 47 字符）；
 *    play 阶段再拉一次 source 取最新签名地址，并抽出内层 m3u8 返回 `parse=0` 直链，
 *    仅在确实解不出时才回退 `parse=1`（该模式只有 ok影视 会做客户端嗅探）。
 *
 * 变更记录：
 * - v1.1.0：网站改版，分类由4大类改为24子类，移除无效筛选；play-url API 改为 /source
 *
 * 环境变量：
 * - `KANQIU_HOST`：88看球域名，默认 `http://www.88kanqiu.cc`
 */

const axios = require("axios");
const http = require("http");
const https = require("https");
const cheerio = require("cheerio");
const CryptoJS = require("crypto-js");
const OmniBox = require("omnibox_sdk");

// ==================== 配置区域 ====================
const HOST = process.env.KANQIU_HOST || "http://www.88kanqiu.cc";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const DEFAULT_PIC = "https://pic.imgdb.cn/item/657673d6c458853aeff94ab9.jpg";

const DEFAULT_HEADERS = {
  "User-Agent": UA,
  Referer: `${HOST}/`,
};

const axiosInstance = axios.create({
  timeout: 60 * 1000,
  httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
  httpAgent: new http.Agent({ keepAlive: true }),
});

// ==================== 日志工具 ====================
function logInfo(message, data = null) {
  const output = data ? `${message}: ${JSON.stringify(data)}` : message;
  OmniBox.log("info", `[88看球] ${output}`);
}

function logError(message, error) {
  OmniBox.log("error", `[88看球] ${message}: ${error?.message || error}`);
}

// ==================== 编解码工具 ====================
function e64(text) {
  try {
    // 用 base64url：去掉 + / =，避免 playId 在 URL / 路由里被截断或转义
    return CryptoJS.enc.Utf8.parse(String(text || ""))
      .toString(CryptoJS.enc.Base64)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  } catch {
    return "";
  }
}

function d64(encodedText) {
  try {
    let s = String(encodedText || "").trim().replace(/-/g, "+").replace(/_/g, "/");
    if (!s) return "";
    s += "=".repeat((4 - (s.length % 4)) % 4);
    return CryptoJS.enc.Base64.parse(s).toString(CryptoJS.enc.Utf8);
  } catch {
    return "";
  }
}

/**
 * 兼容多种 id 格式，提取真实详情 URL 与展示名称
 * 支持：
 * 1) 新格式：Base64(JSON.stringify({ gameId, playUrl, name }))
 * 2) 旧格式：Base64(JSON.stringify({ vid, name }))
 * 3) 旧格式：`${vid}###${encodeURIComponent(name)}`
 * 4) 兜底：直接把入参当 URL
 */
function parseVodId(rawId) {
  const idText = String(rawId || "");
  let realId = idText;
  let displayName = "赛事直播";
  let gameId = "";
  let playUrl = "";

  const jsonText = d64(idText);
  if (jsonText && (jsonText.startsWith("{") || jsonText.startsWith("["))) {
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed?.gameId || parsed?.playUrl) {
        realId = String(parsed.playUrl || parsed.vid || "");
        displayName = String(parsed.name || displayName);
        gameId = String(parsed.gameId || "");
        playUrl = String(parsed.playUrl || "");
        return { realId, displayName, gameId, playUrl };
      }
      if (parsed?.vid) {
        realId = String(parsed.vid);
        displayName = String(parsed.name || displayName);
        const match = realId.match(/\/live\/(\d+)\//);
        if (match) gameId = match[1];
        playUrl = realId;
        return { realId, displayName, gameId, playUrl };
      }
    } catch {
      // 忽略，继续尝试旧格式
    }
  }

  if (idText.includes("###")) {
    const parts = idText.split("###", 2);
    realId = parts[0] || "";
    displayName = decodeURIComponent(parts[1] || "赛事直播");
    const match = realId.match(/\/live\/(\d+)\//);
    if (match) gameId = match[1];
    playUrl = realId;
    return { realId, displayName, gameId, playUrl };
  }

  const m = idText.match(/\/live\/(\d+)\//);
  if (m) gameId = m[1];
  playUrl = idText;
  return { realId, displayName, gameId, playUrl };
}

/**
 * 从 `-url` 接口返回中提取 links，兼容不同返回形态
 */
function parseLinksFromPlayApiResponse(responseData) {
  const raw = responseData?.data;

  if (Array.isArray(raw?.links)) {
    return raw.links;
  }

  if (typeof raw === "object" && Array.isArray(raw?.links)) {
    return raw.links;
  }

  if (typeof raw !== "string") {
    return [];
  }

  const candidates = [
    raw,
    raw.substring(6, Math.max(6, raw.length - 2)),
  ].filter(Boolean);

  for (const item of candidates) {
    // 尝试直接 JSON
    try {
      const direct = JSON.parse(item);
      if (Array.isArray(direct?.links)) return direct.links;
    } catch {
      // ignore
    }

    // 尝试 Base64(JSON)
    try {
      const decoded = Buffer.from(item, "base64").toString();
      const parsed = JSON.parse(decoded || "{}");
      if (Array.isArray(parsed?.links)) return parsed.links;
    } catch {
      // ignore
    }
  }

  return [];
}

// ==================== 业务工具 ====================
function getClasses() {
  return [
    { type_id: "", type_name: "全部直播" },
    { type_id: "1", type_name: "NBA" },
    { type_id: "2", type_name: "CBA" },
    { type_id: "20", type_name: "WNBA" },
    { type_id: "4", type_name: "篮球综合" },
    { type_id: "3", type_name: "世界杯" },
    { type_id: "8", type_name: "英超" },
    { type_id: "9", type_name: "西甲" },
    { type_id: "10", type_name: "意甲" },
    { type_id: "14", type_name: "德甲" },
    { type_id: "15", type_name: "法甲" },
    { type_id: "12", type_name: "欧冠" },
    { type_id: "13", type_name: "欧联" },
    { type_id: "7", type_name: "中超" },
    { type_id: "11", type_name: "亚冠" },
    { type_id: "27", type_name: "足总杯" },
    { type_id: "26", type_name: "美职联" },
    { type_id: "31", type_name: "中甲" },
    { type_id: "23", type_name: "足球综合" },
    { type_id: "21", type_name: "体育电视台" },
    { type_id: "29", type_name: "网球" },
    { type_id: "25", type_name: "NFL" },
    { type_id: "19", type_name: "羽毛球" },
    { type_id: "38", type_name: "棒球" },
  ];
}

function getFilters() {
  return {};
}

/**
 * 获取分类列表
 * @param {string} type 分类 ID
 * @param {Object} extend 扩展筛选
 * @returns {Promise<{list:Array,page:number,pagecount:number,limit:number}>}
 */
async function getCategoryList(type, extend = {}) {
  try {
    const cateId = extend?.cateId || type || "";
    const path = cateId ? `/match/${cateId}/live` : "";
    const url = `${HOST}${path}`;

    const response = await axiosInstance.get(url, { headers: { ...DEFAULT_HEADERS } });
    const $ = cheerio.load(response.data || "");

    const list = [];
    $(".list-group-item.group-game-item").each((_, element) => {
      const $el = $(element);
      const time = $el.find(".category-game-time").text()?.trim() || "";
      const gameType = $el.find(".game-type").text()?.trim() || "";
      const teamNames = $el.find(".team-name");
      const homeTeam = teamNames.length > 0 ? teamNames.first().text().trim() : "";
      const awayTeam = teamNames.length > 1 ? teamNames.last().text().trim() : "";

      const name = `${time} ${gameType} ${homeTeam} vs ${awayTeam}`.trim();
      if (!name || name === "vs") return;

      const payBtn = $el.find(".pay-btn");
      const gameId = payBtn.attr("data-id") || "";

      const btnPrimary = $el.find(".btn.btn-primary");
      const btnDefault = $el.find(".btn.btn-default");
      const btn = btnPrimary.length > 0 ? btnPrimary : btnDefault;

      let playUrl = "";
      let remark = "暂无";
      if (btn.length > 0) {
        playUrl = `${HOST}${btn.attr("href") || ""}`;
        remark = btn.text().trim().replace(/\s+/g, " ") || "暂无";
      }

      const imgs = $el.find("img.team-logo");
      let pic = imgs.length > 0 ? imgs.first().attr("data-src") || imgs.first().attr("src") || "" : "";
      if (!pic) pic = DEFAULT_PIC;
      if (!String(pic).startsWith("http")) pic = `${HOST}${pic}`;

      if (!gameId && !playUrl) return;

      const encodedId = e64(JSON.stringify({ gameId, playUrl, name }));
      list.push({
        vod_id: encodedId,
        vod_name: name,
        vod_pic: pic,
        vod_remarks: remark,
      });
    });

    return {
      list,
      page: 1,
      pagecount: 1,
      limit: list.length,
    };
  } catch (error) {
    logError("获取分类列表失败", error);
    return { list: [], page: 1, pagecount: 1, limit: 0 };
  }
}

/**
 * 拉取某场比赛的全部线路（source 接口）
 * @param {string} gid 比赛 ID
 * @returns {Promise<Array<{url: string, name: string}>>}
 */
async function fetchSourceLinks(gid) {
  const id = String(gid || "").trim();
  if (!id) return [];
  try {
    const response = await axiosInstance.get(`${HOST}/live/${id}/source`, {
      headers: {
        ...DEFAULT_HEADERS,
        Referer: `${HOST}/live/${id}/play`,
      },
    });
    const links = parseLinksFromPlayApiResponse(response?.data) || [];
    return links
      .filter((it) => it?.url)
      .map((it) => ({
        url: String(it.url || "").replace(/\*\*\*/g, "#"),
        name: String(it.name || ""),
      }));
  } catch (error) {
    logError("拉取线路失败", error);
    return [];
  }
}

/**
 * 拉取详情并转换播放源
 * @param {string} rawId 列表中的 vod_id
 * @returns {Promise<Object|null>}
 */
async function getDetailById(rawId) {
  try {
    const { realId, displayName, gameId, playUrl } = parseVodId(rawId);

    if (!realId && !gameId) {
      return null;
    }

    const gid = gameId || realId.match(/\/live\/(\d+)\//)?.[1] || "";
    const pageUrl = playUrl || realId;

    if (gid) {
      const playUrlApi = `${HOST}/live/${gid}/source`;
      try {
        const response = await axiosInstance.get(playUrlApi, {
          headers: {
            ...DEFAULT_HEADERS,
            Referer: `${HOST}/live/${gid}/play`,
          },
        });

        const links = parseLinksFromPlayApiResponse(response?.data);

        if (links && links.length > 0) {
          const episodes = links
            .filter((it) => it?.url)
            .map((it, index) => {
              const epName = String(it.name || `直播源${index + 1}`);
              // playId 只存「哪场比赛 + 第几条线路」，播放时再拉一次 source，
              // 好处：签名地址不会过期、playId 也短（不会因为 URL 太长被截断）
              const playData = { g: String(gid), i: index, n: epName };
              return {
                name: epName,
                playId: e64(JSON.stringify(playData)),
              };
            });

          return {
            vod_id: realId || gid,
            vod_name: displayName,
            vod_pic: "",
            vod_content: "实时体育直播",
            vod_play_sources: [
              {
                name: "88看球",
                episodes,
              },
            ],
          };
        }
      } catch (apiError) {
        logError("source 接口失败，回退到页面直链", apiError);
      }
    }

    if (pageUrl && pageUrl.startsWith("http")) {
      const playData = {
        u: pageUrl,
        n: "直播页",
      };
      return {
        vod_id: realId || gid,
        vod_name: displayName,
        vod_pic: "",
        vod_content: "实时体育直播",
        vod_play_sources: [
          {
            name: "88看球",
            episodes: [
              {
                name: "直播页",
                playId: e64(JSON.stringify(playData)),
              },
            ],
          },
        ],
      };
    }

    return null;
  } catch (error) {
    logError("获取详情失败", error);
    return null;
  }
}

// ==================== 标准接口：home ====================
/**
 * 首页数据（分类 + 筛选 + 推荐）
 */
async function home(params) {
  try {
    const classes = getClasses();
    const result = await getCategoryList("");

    return {
      class: classes,
      filters: getFilters(),
      list: result.list || [],
      page: 1,
      pagecount: 1,
      total: (result.list || []).length,
      limit: result.limit || (result.list || []).length,
    };
  } catch (error) {
    logError("home 失败", error);
    return {
      class: getClasses(),
      filters: getFilters(),
      list: [],
      page: 1,
      pagecount: 1,
      total: 0,
      limit: 0,
    };
  }
}

// ==================== 标准接口：category ====================
/**
 * 分类列表
 */
async function category(params) {
  try {
    const type = params?.id || params?.categoryId || params?.tid || "";
    const extend = params?.extend || params?.filters || {};
    const result = await getCategoryList(type, extend);

    return {
      list: result.list || [],
      page: 1,
      pagecount: 1,
      total: (result.list || []).length,
      limit: result.limit || (result.list || []).length,
    };
  } catch (error) {
    logError("category 失败", error);
    return {
      list: [],
      page: 1,
      pagecount: 1,
      total: 0,
      limit: 0,
    };
  }
}

// ==================== 标准接口：detail ====================
/**
 * 视频详情
 */
async function detail(params) {
  try {
    const id = params?.id || params?.videoId || "";
    const vod = await getDetailById(id);
    return {
      list: vod ? [vod] : [],
    };
  } catch (error) {
    logError("detail 失败", error);
    return { list: [] };
  }
}

// ==================== 标准接口：search ====================
/**
 * 搜索（源站暂无关键词搜索能力）
 */
async function search(params) {
  return {
    list: [],
    page: Number(params?.page || 1),
    pagecount: 1,
    total: 0,
    limit: 0,
  };
}

// ==================== 标准接口：play ==================== 
/**
 * 判断是否是可直连的媒体地址
 */
const MEDIA_URL_RE = /\.(m3u8|mp4|flv|ts|mkv)(\?|#|$)/i;

/**
 * 站点返回的线路地址常常是「播放页包一层真实地址」，形如：
 *   https://play.88player.top/m3u8.html?url=https://play.aarray.cn/xxx.m3u8?auth_key=...
 * 直接把外层页面丢给播放器会一直转圈（播放器拿到的是 HTML），所以这里先把内层地址解出来。
 * @param {string} rawUrl
 * @returns {string} 内层可直连地址，解不出则返回空串
 */
function extractInnerMediaUrl(rawUrl) {
  const u = String(rawUrl || "").trim();
  if (!u) return "";

  try {
    const parsed = new URL(u);
    const inner = parsed.searchParams.get("url") || parsed.searchParams.get("u") || "";
    if (inner && MEDIA_URL_RE.test(inner)) {
      // 站点把内层地址直接拼在 ?url= 后面、不做编码，内层自带的 &token= / &device=
      // 会被 URLSearchParams 截断；这类 host 改走下面的“取剩余全部”逻辑更稳。
      if (!/88player|88kanqiu|aarray/i.test(parsed.hostname)) return inner;
    }
  } catch (_) {
    // 非法 URL，走下面的正则兜底
  }

  // 兜底：从 url=/u= 开始一直取到结尾（保留内层自带的 query）
  const m = u.match(/[?&](?:url|u)=(.+)$/i);
  if (m) {
    const raw = m[1];
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch (_) {
      // 保持原样
    }
    for (const cand of [raw, decoded]) {
      if (MEDIA_URL_RE.test(cand)) return cand;
    }
  }

  return "";
}

/**
 * 播放解析
 * 优先返回 parse=0 的直链（urls 数组）；只有确实解析不出时才回退 parse=1 交给客户端嗅探。
 */
async function play(params, context) {
  const flag = String(params?.flag || "play");

  try {
    const encoded = String(params?.id || params?.playId || "");
    logInfo("收到播放请求", { playIdLen: encoded.length });

    const playData = JSON.parse(d64(encoded) || "{}") || {};
    const baseHeader = { ...DEFAULT_HEADERS, ...(playData.headers || {}) };

    let epName = String(playData.n || playData.name || "播放");
    let rawUrl = String(playData.url || playData.u || "").trim();

    // 短 playId（{ g: gid, i: 线路序号 }）：现场拉一次 source 拿最新签名地址，
    // 避免播放地址过期，也避免把超长 URL 塞进 playId。
    const gid = String(playData.g || playData.gid || "");
    if (!rawUrl && gid) {
      const links = await fetchSourceLinks(gid);
      const index = Number.isInteger(playData.i) ? playData.i : 0;
      const picked = links[index] || links[0];
      if (picked) {
        rawUrl = picked.url;
        if (!playData.n && picked.name) epName = picked.name;
      }
      logInfo("按比赛重新取线路", { gid, index, total: links.length, hit: !!picked });
    }

    if (!rawUrl) {
      logError("play 缺少播放地址", new Error("playData 里没有可用的 url"));
      return { parse: 1, urls: [], flag, header: baseHeader };
    }

    // 1) 内嵌播放页：抽出真实 m3u8，直接给播放器
    const innerUrl = extractInnerMediaUrl(rawUrl);
    if (innerUrl) {
      logInfo("已从播放页抽出直链", { name: epName, url: innerUrl.slice(0, 120) });
      let referer = baseHeader.Referer;
      try {
        const host = new URL(rawUrl).hostname;
        if (/88player|88kanqiu/.test(host)) referer = "https://play.88player.top/";
      } catch (_) {
        // ignore
      }
      return {
        parse: 0,
        urls: [{ name: epName, url: innerUrl }],
        flag,
        header: { ...baseHeader, Referer: referer },
      };
    }

    // 2) 本身就是直链
    if (MEDIA_URL_RE.test(rawUrl)) {
      logInfo("直链播放", { name: epName, url: rawUrl.slice(0, 120) });
      return {
        parse: 0,
        urls: [{ name: epName, url: rawUrl }],
        flag,
        header: baseHeader,
      };
    }

    // 3) 普通播放页：交给服务端嗅探（需要完整运行环境）
    if (typeof OmniBox.sniffVideo === "function") {
      try {
        const sniffed = await OmniBox.sniffVideo(rawUrl, baseHeader);
        if (sniffed && sniffed.url) {
          logInfo("嗅探成功", { name: epName, url: String(sniffed.url).slice(0, 120) });
          return {
            parse: 0,
            urls: [{ name: epName, url: sniffed.url }],
            flag,
            header: { ...baseHeader, ...(sniffed.header || {}) },
          };
        }
      } catch (sniffError) {
        logError("嗅探失败", sniffError);
      }
    }

    // 4) 兜底：交回客户端嗅探（parse=1 仅 ok影视 会处理，其它客户端会当直链，注意日志提示）
    logInfo("无法解析直链，回退 parse=1（仅 ok影视 支持客户端嗅探）", { name: epName, url: rawUrl.slice(0, 120) });
    return {
      parse: 1,
      urls: [{ name: epName, url: rawUrl }],
      flag,
      header: baseHeader,
    };
  } catch (error) {
    logError("play 失败", error);
    return { parse: 1, urls: [], flag, header: { ...DEFAULT_HEADERS } };
  }
}

module.exports = {
  home,
  category,
  detail,
  search,
  play,
};

const runner = require("spider_runner");
runner.run(module.exports);

