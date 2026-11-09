// @name Auete影视
// @author 梦
// @description 站点 www.au1080.top（Auete影视网：电影/剧集/综艺/动漫，云播 m3u8 直链）：支持首页、分类、搜索、详情与直链播放；播放页地址 base64 编码，解码即得 m3u8；站内搜索需算术验证码，未过验证时自动改扫列表页
// @dependencies cheerio
// @version 2.0.0
// @downloadURL https://gh-proxy.org/https://github.com/tardlk/OmniBox-Spider/raw/refs/heads/main/影视/采集/Auete影视.js

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");
const cheerio = require("cheerio");

// 旧域名 auete.top 现在只返回 Redirecting...，站点已迁到 au1080.top
const HOST = (process.env.AU_HOST || "https://www.au1080.top").replace(/\/+$/, "");
const UA = process.env.AU_UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
const PAGE_CACHE_TTL = 120;      // 列表/详情页缓存秒数
const SEARCH_CACHE_TTL = 900;    // 本地扫描结果缓存秒数
const SEARCH_SCAN_PAGES = Number(process.env.AU_SEARCH_PAGES || 2);
const PAGE_SIZE_HINT = 20;

const CLASS_LIST = [
  { type_id: "Movie", type_name: "电影", path: "/Movie/" },
  { type_id: "Tv", type_name: "电视剧", path: "/Tv/" },
  { type_id: "Zy", type_name: "综艺", path: "/Zy/" },
  { type_id: "Dm", type_name: "动漫", path: "/Dm/" },
  { type_id: "qita", type_name: "其他", path: "/qita/" },
];

const BASE_HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};
const PLAY_HEADERS = {
  "User-Agent": UA,
  Referer: `${HOST}/`,
  Origin: HOST,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function logInfo(message) {
  await OmniBox.log("info", `[Auete影视] ${message}`);
}

function absUrl(path = "") {
  const value = String(path || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  return `${HOST}${value.startsWith("/") ? "" : "/"}${value}`;
}

function cleanText(text = "") {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(text = "") {
  return cleanText(
    String(text || "")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&quot;/g, '"')
      .replace(/&#039;|&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
  );
}

async function requestHtml(url, referer = `${HOST}/`, useCache = true, depth = 0) {
  const finalUrl = absUrl(url);
  const cacheKey = `auete:page:${finalUrl}`;
  if (useCache) {
    try {
      const cached = await OmniBox.getCache(cacheKey);
      if (cached) return String(cached);
    } catch (_) {
      /* 缓存不可用则直连 */
    }
  }
  const res = await OmniBox.request(finalUrl, {
    method: "GET",
    headers: { ...BASE_HEADERS, Referer: referer },
  });
  const status = Number(res && res.statusCode);
  // 站点对 / 会 302 到 /index.html，而 SDK 不自动跟随跳转
  if (status >= 300 && status < 400) {
    const location = (res.headers && (res.headers.location || res.headers.Location)) || "";
    if (location && depth < 3) return requestHtml(absUrl(location), referer, useCache, depth + 1);
    throw new Error(`HTTP ${status} 跳转无 location @ ${url}`);
  }
  if (status !== 200) throw new Error(`HTTP ${status} @ ${url}`);
  const body = String((res && res.body) || "");
  if (useCache) {
    try {
      await OmniBox.setCache(cacheKey, body, PAGE_CACHE_TTL);
    } catch (_) {
      /* 写缓存失败不影响 */
    }
  }
  return body;
}

function getTypeId(path) {
  const m = String(path || "").match(/\/(Movie|Tv|Zy|Dm|qita)\//i);
  return m ? m[1] : "";
}

function getTypeName(typeId) {
  return (CLASS_LIST.find((c) => c.type_id === typeId) || {}).type_name || "";
}

// 列表卡片：<li data-href="/Movie/xxx/"><a class="pic"><img ...><span class="hdtag">HD</span></a><h2><a>片名</a></h2>
function parseCards(html) {
  const $ = cheerio.load(html || "", { decodeEntities: false });
  const list = [];
  const seen = new Set();
  $("li[data-href]").each((_, el) => {
    const $el = $(el);
    const href = String($el.attr("data-href") || $el.find("h2 a[href]").first().attr("href") || "").trim();
    if (!href || !/\/(Movie|Tv|Zy|Dm|qita)\//i.test(href)) return;
    const vodId = absUrl(href);
    if (seen.has(vodId)) return;
    const name = decodeHtml(
      $el.find("h2 a").first().attr("title") || $el.find("h2 a").first().text() || $el.find("img").first().attr("alt")
    );
    if (!name) return;
    seen.add(vodId);
    const pic = absUrl($el.find("a.pic img, img").first().attr("src") || "");
    const remarks = decodeHtml($el.find(".hdtag").first().text());
    const score = cleanText($el.find(".rating").first().text()).replace(/分$/, "");
    const typeId = getTypeId(href);
    list.push({
      vod_id: vodId,
      vod_name: name,
      vod_pic: pic,
      vod_remarks: remarks || (score ? `${score}分` : ""),
      vod_douban_score: score,
      type_id: typeId,
      type_name: getTypeName(typeId),
    });
  });
  return list;
}

function parsePageCount(html) {
  const m = String(html || "").match(/共\s*(\d+)\s*页/);
  return m ? Math.max(1, Number(m[1])) : 1;
}

function buildCategoryUrl(typeId, page) {
  const cat = CLASS_LIST.find((c) => c.type_id === typeId) || CLASS_LIST[0];
  return page <= 1 ? `${cat.path}index.html` : `${cat.path}index${page}.html`;
}

async function home(params, context) {
  try {
    const html = await requestHtml("/index.html");
    const list = parseCards(html).slice(0, 40);
    await logInfo(`home list=${list.length}`);
    return { class: CLASS_LIST.map((c) => ({ type_id: c.type_id, type_name: c.type_name })), list };
  } catch (error) {
    await logInfo(`home 失败: ${error.message}`);
    return { class: CLASS_LIST.map((c) => ({ type_id: c.type_id, type_name: c.type_name })), list: [] };
  }
}

async function category(params, context) {
  const page = Math.max(1, Number(params?.page || params?.pg || 1) || 1);
  const typeId = String(params?.type_id || params?.tid || params?.categoryId || "Movie");
  try {
    const url = buildCategoryUrl(typeId, page);
    const html = await requestHtml(url, absUrl(buildCategoryUrl(typeId, 1)));
    const list = parseCards(html);
    const pagecount = parsePageCount(html);
    await logInfo(`category ${typeId} page=${page}/${pagecount} list=${list.length}`);
    return { page, pagecount, total: pagecount * PAGE_SIZE_HINT, list };
  } catch (error) {
    await logInfo(`category ${typeId} page=${page} 失败: ${error.message}`);
    return { page, pagecount: page, total: 0, list: [] };
  }
}

// 详情页：每个 play-card 卡片是一条线路，episode-list 里是分集
function parseDetail(html, pageUrl) {
  const $ = cheerio.load(html || "", { decodeEntities: false });
  const vodName = decodeHtml($("h1").first().text() || $("title").first().text().split("-")[0]).replace(/^《|》$/g, "");
  const vodPic = absUrl($('meta[property="og:image"]').attr("content") || $(".poster img").first().attr("src") || "");
  const vodContent = decodeHtml($('meta[property="og:description"]').attr("content") || "");
  const text = String(html || "");
  const year = (text.match(/((?:19|20)\d{2})-\d{2}-\d{2}/) || [])[1] || "";
  const pickInfo = (keyword) => {
    const m = text.match(new RegExp(`${keyword}[:：]?\\s*<\\/[^>]+>\\s*(?:<[^>]+>\\s*)*([^<]{1,80})`));
    return decodeHtml(m ? m[1] : "");
  };
  const director = pickInfo("导演");
  const actor = pickInfo("主演");

  const sources = [];
  const chunks = text.split('class="card mb-3 play-card"');
  for (let i = 1; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const nameMatch = chunk.match(/<b>『[^』]*』([^<]+)<\/b>/);
    const lineName = decodeHtml(nameMatch ? nameMatch[1] : `线路${i}`) || `线路${i}`;
    const episodes = [];
    const seen = new Set();
    const re = /href="([^"]*\/play-(\d+)-(\d+)\.html)"[^>]*>([^<]*)</g;
    let m;
    while ((m = re.exec(chunk))) {
      const path = m[1];
      if (seen.has(path)) continue;
      seen.add(path);
      const label = decodeHtml(m[4]) || `第${Number(m[3]) + 1}集`;
      episodes.push({ name: label, playId: absUrl(path) });
    }
    if (episodes.length) sources.push({ name: lineName, episodes });
  }

  const typeId = getTypeId(pageUrl);
  return {
    vod_id: pageUrl,
    vod_name: vodName,
    vod_pic: vodPic,
    vod_content: vodContent,
    vod_year: year,
    vod_actor: actor,
    vod_director: director,
    vod_remarks: "",
    type_id: typeId,
    type_name: getTypeName(typeId),
    vod_play_sources: sources,
  };
}

async function detail(params, context) {
  const vodId = String(params?.vod_id || params?.videoId || params?.id || "").trim();
  if (!vodId) return { list: [] };
  const pageUrl = absUrl(vodId);
  try {
    const html = await requestHtml(pageUrl);
    const vod = parseDetail(html, pageUrl);
    if (!vod.vod_name) {
      await logInfo(`detail ${vodId} 解析为空`);
      return { list: [] };
    }
    await logInfo(
      `detail ${vod.vod_name} 线路=${vod.vod_play_sources.length} 集数=${vod.vod_play_sources.map((s) => s.episodes.length).join("/")}`
    );
    return { list: [vod] };
  } catch (error) {
    await logInfo(`detail ${vodId} 失败: ${error.message}`);
    return { list: [] };
  }
}

// 播放页里：var now=base64decode("aHR0cHM6Ly8uLi4vaW5kZXgubTN1OA==")
// 注意别取 next —— 那是"下一集"的地址，老版本就踩过这个坑
function extractPlayUrl(html) {
  const text = String(html || "");
  const m = text.match(/var\s+now\s*=\s*base64decode\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/);
  if (m) {
    const decoded = Buffer.from(m[1], "base64").toString("utf8").trim();
    if (/^https?:\/\//i.test(decoded)) return decoded;
  }
  const plain = text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
  return plain ? plain[0] : "";
}

async function play(params, context) {
  const raw = String(params?.play_id || params?.playId || params?.id || "").trim();
  if (!raw) return { urls: [], parse: 1 };
  const pageUrl = absUrl(raw);
  try {
    const html = await requestHtml(pageUrl, `${HOST}/`);
    const url = extractPlayUrl(html);
    if (!url) {
      await logInfo(`play 未找到 m3u8: ${raw}`);
      return { urls: [{ name: "播放页", url: pageUrl }], parse: 1, header: PLAY_HEADERS };
    }
    await logInfo(`play 直链 ${url.slice(0, 110)}`);
    return { urls: [{ name: "云播", url }], parse: 0, header: { ...PLAY_HEADERS, Referer: pageUrl } };
  } catch (error) {
    await logInfo(`play 失败: ${error.message}`);
    return { urls: [], parse: 1 };
  }
}

// 站内搜索被算术验证码挡住（56x20 图片，形如 5+6=?），没过验证就退化为扫列表页
function normText(text = "") {
  return String(text || "").toLowerCase().replace(/[\s\-_:：·,，.。'"!！?？()（）[\]/]/g, "");
}

async function scanSearch(keyword, context) {
  const key = normText(keyword);
  const cacheKey = `auete:scan:v1:${key}`;
  try {
    const cached = await OmniBox.getCache(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (_) {
    /* 继续扫描 */
  }
  const out = [];
  const seen = new Set();
  for (const cat of CLASS_LIST) {
    for (let page = 1; page <= SEARCH_SCAN_PAGES; page += 1) {
      let html;
      try {
        html = await requestHtml(buildCategoryUrl(cat.type_id, page), absUrl(`${cat.path}index.html`));
      } catch (_) {
        break;
      }
      for (const item of parseCards(html)) {
        if (seen.has(item.vod_id)) continue;
        if (!normText(item.vod_name).includes(key)) continue;
        seen.add(item.vod_id);
        out.push(item);
      }
      if (out.length >= 30) break;
      await sleep(200);
    }
    if (out.length >= 30) break;
  }
  try {
    await OmniBox.setCache(cacheKey, JSON.stringify(out), SEARCH_CACHE_TTL);
  } catch (_) {
    /* 忽略 */
  }
  return out;
}

async function search(params, context) {
  const page = Math.max(1, Number(params?.page || params?.pg || 1) || 1);
  const keyword = String(params?.wd || params?.keyword || params?.key || "").trim();
  if (!keyword) return { page, pagecount: 0, total: 0, list: [] };

  // 站内搜索基本每次都要算术验证码，没见过验证码就直接跳过它，省一次请求
  let off = false;
  try {
    off = Boolean(await OmniBox.getCache("auete:scoff:v1"));
  } catch (_) {
    off = false;
  }
  if (off) {
    await logInfo("search 站内搜索已知需要验证码，直接扫列表页");
  }
  try {
    if (off) throw new Error("skip");
    const html = await requestHtml(`/auete4so.php?searchword=${encodeURIComponent(keyword)}`, `${HOST}/`);
    if (!/系统安全验证/.test(html)) {
      const list = parseCards(html);
      if (list.length) {
        await logInfo(`search 站内 keyword=${keyword} list=${list.length}`);
        return { page: 1, pagecount: 1, total: list.length, list };
      }
    } else {
      await logInfo("search 站内需要算术验证码，改为扫列表页");
      try {
        await OmniBox.setCache("auete:scoff:v1", "1", 3600);
      } catch (_) {
        /* 忽略 */
      }
    }
  } catch (error) {
    if (error.message !== "skip") await logInfo(`search 站内失败: ${error.message}`);
  }

  const all = await scanSearch(keyword, context);
  const pagecount = Math.max(1, Math.ceil(all.length / 30));
  const list = page > pagecount ? [] : all.slice((page - 1) * 30, page * 30);
  await logInfo(`search 本地扫描 keyword=${keyword} page=${page}/${pagecount} total=${all.length} list=${list.length}`);
  return { page, pagecount, total: all.length, list };
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
