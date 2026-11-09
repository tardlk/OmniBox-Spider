// @name 枫叶4K影院
// @description 枫叶4K影院 - https://www.zzztool.com/ 聚合鹅酷爱芒桃的4K影视站（MacCMS AJAX 列表 + player_aaaa 直链/解析）
// @dependencies cheerio
// @version 1.0.9
// @downloadURL https://gh-proxy.org/https://github.com/tardlk/OmniBox-Spider/raw/refs/heads/main/影视/采集/枫叶4K影院.js

const cheerio = require("cheerio");
const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

const HOST = (process.env.ZZZ_HOST || "https://www.zzztool.com").replace(/\/+$/, "");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";
// 站点对 /type 与 /search 给普通浏览器弹图形验证码，但对搜索引擎蜘蛛直接放行。
// 实测 Baiduspider / Googlebot / bingbot 均免验证（Sogou 不在白名单），
// 所以搜索与页面分类统一用蜘蛛 UA；普通 UA 仍用于详情页/播放页。
const SPIDER_UA = "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)";
// 备选：浏览器里手动过一次验证码后，可把整串 Cookie 填到 ZZZ_COOKIE
const COOKIE = String(process.env.ZZZ_COOKIE || "").trim();
const API_LIST = `${HOST}/index.php/ajax/data`;
const PAGE_SIZE = 30; // 站点 ajax 接口上限为 30，超过会异常返回 10 条
const CFG_CACHE_KEY = "zzz:playercfg:v1";
const CFG_CACHE_TTL = 6 * 3600;

// tid 实测映射：1 电影 / 2 电视剧 / 3 综艺 / 4 动漫 / 5 短剧
const CATEGORIES = [
  { type_id: "1", type_name: "电影" },
  { type_id: "2", type_name: "电视剧" },
  { type_id: "3", type_name: "综艺" },
  { type_id: "4", type_name: "动漫" },
  { type_id: "5", type_name: "短剧" },
];

async function logInfo(message) {
  await OmniBox.log("info", `[zzz] ${message}`);
}

async function logError(message) {
  await OmniBox.log("error", `[zzz] ${message}`);
}

function decodeHtml(text = "") {
  return String(text)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

// 站点封面走百度图床：https://gimg0.baidu.com/gimg/app=2001&...&src=image.zzztool.com/upload/xxx.jpg
// 宿主 json 序列化会把 & 转义成 \u0026 导致封面裂图，这里统一还原成源站直链（实测 200）
function normalizePic(url = "") {
  const raw = decodeHtml(url || "");
  if (!raw) return "";
  const m = raw.match(/[?&]src=([^&]+)/);
  if (m && m[1]) {
    let src = m[1];
    try {
      src = decodeURIComponent(src);
    } catch (_) {
      /* 保持原样 */
    }
    if (/^https?:\/\//i.test(src)) return src;
    if (/^image\./i.test(src) || /^[\w.-]+\.[a-z]{2,}\//i.test(src)) return `https://${src}`;
  }
  return raw;
}

function toYear(text = "") {
  const m = String(text).match(/(19|20)\d{2}/);
  return m ? m[0] : "";
}

// 宿主对 text/html 有时会把响应体再 JSON 编码一层（首尾引号 + 内部 \" 转义），
// 直接交给 cheerio 会解析成乱码（h1/player_aaaa 全部取不到），这里统一剥一层。
function unwrapBody(raw) {
  let body = raw;
  if (body && typeof body === "object") {
    body = body.body !== undefined ? body.body : body.data !== undefined ? body.data : "";
  }
  if (typeof body !== "string") return String(body == null ? "" : body);
  const trimmed = body.trim();
  if (trimmed.length > 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch (_) {
      /* 不是完整 JSON 字符串则原样返回 */
    }
  }
  return body;
}

function isVerifyPage(html) {
  return /系统安全验证|访问此数据需要输入验证码/.test(String(html || ""));
}

async function httpGet(url, referer = HOST + "/", ua = UA) {
  const headers = {
    "User-Agent": ua,
    Referer: referer,
    Accept: "text/html,application/json,*/*",
  };
  if (COOKIE) headers.Cookie = COOKIE;
  const res = await OmniBox.request(url, { method: "GET", headers });
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
  return unwrapBody(res.body);
}

async function fetchList(tid, page) {
  const params = [`mid=1`, `limit=${PAGE_SIZE}`, `page=${page}`];
  if (tid) params.push(`tid=${encodeURIComponent(String(tid))}`);
  const url = `${API_LIST}?${params.join("&")}`;
  const body = await httpGet(url);
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    throw new Error(`列表 JSON 解析失败: ${body.slice(0, 80)}`);
  }
  if (Number(data.code) !== 1) throw new Error(`列表接口返回 code=${data.code} msg=${data.msg || ""}`);
  return {
    list: Array.isArray(data.list) ? data.list : [],
    page: Number(data.page) || page,
    pagecount: Number(data.pagecount) || page,
    total: Number(data.total) || 0,
  };
}

function mapItem(it) {
  const typeId = String(it.type_id_1 || it.type_id || "");
  const cat = CATEGORIES.find((c) => c.type_id === typeId);
  return {
    vod_id: String(it.vod_id || ""),
    vod_name: decodeHtml(it.vod_name || ""),
    vod_pic: normalizePic(it.vod_pic || ""),
    vod_remarks: decodeHtml(it.vod_remarks || ""),
    type_id: typeId,
    type_name: cat ? cat.type_name : "",
  };
}

function uniqueByVodId(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || !item.vod_id || seen.has(item.vod_id)) continue;
    seen.add(item.vod_id);
    out.push(item);
  }
  return out;
}

async function home(params, context) {
  try {
    const classList = CATEGORIES.map(({ type_id, type_name }) => ({ type_id, type_name }));
    const { list } = await fetchList("", 1);
    const mapped = uniqueByVodId(list.map(mapItem)).slice(0, 20);
    await logInfo(`home 返回 ${mapped.length} 条`);
    return { class: classList, list: mapped };
  } catch (e) {
    await logError(`home 异常: ${e.message}`);
    return { class: CATEGORIES.map(({ type_id, type_name }) => ({ type_id, type_name })), list: [] };
  }
}

async function category(params, context) {
  try {
    const categoryId = String(params.categoryId || "2");
    const page = Math.max(1, Number(params.page) || 1);
    const { list, pagecount, total } = await fetchList(categoryId, page);
    const mapped = uniqueByVodId(list.map(mapItem));
    await logInfo(`category tid=${categoryId} page=${page} 返回 ${mapped.length} 条 pagecount=${pagecount}`);
    // pagecount 按规范返回总页数（官方模板同样直接回传 data.pagecount），不是“下一页页码”
    return {
      page,
      pagecount,
      total: total || page * PAGE_SIZE,
      list: mapped,
    };
  } catch (e) {
    await logError(`category 异常: ${e.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

function parseInfoItems($) {
  const info = { actor: "", director: "", remarks: "", episodes: "" };
  $(".module-info-item").each((_, el) => {
    const title = decodeHtml($(el).find(".module-info-item-title").first().text()).replace(/[：:]\s*$/, "");
    const value = decodeHtml($(el).find(".module-info-item-content").first().text());
    if (!title || !value) return;
    if (title.includes("导演")) info.director = value;
    else if (title.includes("主演") || title.includes("演员")) info.actor = value;
    else if (title.includes("集数") || title.includes("状态")) info.episodes = value;
    else if (title.includes("更新")) info.remarks = value;
  });
  return info;
}

function normalizeEpisodeName(raw, nid, total) {
  const text = decodeHtml(raw || "").replace(/\s+/g, " ").trim();
  if (!text) return nid === "1" && total <= 1 ? "正片" : `第${nid}集`;
  const num = text.match(/(\d+)\s*$/);
  if (num && text.replace(/\s*\d+\s*$/, "").length <= 12) return `第${num[1]}集`;
  return text;
}

async function detail(params, context) {
  try {
    const videoId = String(params.videoId || "").trim();
    if (!/^\d+$/.test(videoId)) return { list: [] };
    const detailUrl = `${HOST}/detail/${videoId}.html`;
    const html = await httpGet(detailUrl);
    if (!html) return { list: [] };
    const $ = cheerio.load(html);

    const title = decodeHtml($("h1").first().text() || $("title").text());
    if (!title) {
      await logError(`detail ${videoId} 标题为空，可能命中验证页`);
      return { list: [] };
    }
    const pic = normalizePic(
      $("img.lazyload").first().attr("data-src") ||
        $("img.lazyload").first().attr("src") ||
        $(".module-item-pic img").first().attr("src") ||
        ""
    );
    const content = decodeHtml($(".module-info-introduction-content").first().text()).replace(/^简介[:：]\s*/, "");
    const tags = [];
    $(".module-info-tag-link").each((_, el) => tags.push(decodeHtml($(el).text())));
    const info = parseInfoItems($);
    const year = toYear(tags[0] || "") || toYear(html);
    const area = tags[1] || "";

    const tabNames = [];
    $(".mx-anthology-tab").each((_, el) => {
      const name = decodeHtml($(el).find(".mx-anthology-tab-label").first().text()) || `线路${tabNames.length + 1}`;
      tabNames.push(name);
    });

    const sources = [];
    $(".mx-anthology-panel[role='tabpanel']").each((idx, panel) => {
      const episodes = [];
      $(panel)
        .find("a.mx-anthology-link[href]")
        .each((_, a) => {
          const href = $(a).attr("href") || "";
          const m = href.match(/\/play\/(\d+)-(\d+)-(\d+)\.html/);
          if (!m) return;
          const nid = m[3];
          const rawName = $(a).attr("title") || $(a).text();
          episodes.push({
            name: normalizeEpisodeName(rawName, nid, 0),
            playId: `${m[1]}-${m[2]}-${nid}`,
            _nid: Number(nid),
          });
        });
      if (!episodes.length) return;
      episodes.sort((a, b) => a._nid - b._nid);
      const total = episodes.length;
      for (const ep of episodes) {
        if (total <= 1) ep.name = "正片";
        else if (!/^第\d+集$/.test(ep.name) && !ep.name) ep.name = `第${ep._nid}集`;
        delete ep._nid;
      }
      sources.push({ name: tabNames[idx] || `线路${idx + 1}`, episodes });
    });

    // 自营线路（自营t/y/r）是 m3u8 直链、秒开；蓝光2k/至臻4k 走第三方解析要 9~15s，
    // 把直链排到前面，避免默认点第一条就卡在解析上。
    sources.sort((a, b) => (/自营/.test(String(a.name)) ? 0 : 1) - (/自营/.test(String(b.name)) ? 0 : 1));

    // 站点详情页本身就有同名线路：《灵武大陆》两个标签都叫「蓝光2k」
    // （sid=8 共 232 集 / sid=9 共 220 集），直接透出客户端会显示两条一样的线路。
    // 同名时补集数区分，既避免重复又提示哪条更全。
    const nameCount = {};
    for (const s of sources) nameCount[s.name] = (nameCount[s.name] || 0) + 1;
    for (const s of sources) {
      if (nameCount[s.name] > 1) s.name = `${s.name}（${s.episodes.length}集）`;
    }

    const vod = {
      vod_id: videoId,
      vod_name: title,
      vod_pic: pic,
      vod_content: content,
      vod_year: year,
      vod_area: area,
      vod_actor: info.actor,
      vod_director: info.director,
      vod_remarks: info.episodes || info.remarks || "",
      type_id: "",
      type_name: "",
      vod_play_sources: sources,
    };

    await logInfo(`detail ${videoId} 线路=${sources.length} 集数=${sources.map((s) => s.episodes.length).join("/")}`);
    return { list: [vod] };
  } catch (e) {
    await logError(`detail 异常: ${e.message}`);
    return { list: [] };
  }
}

// 搜索结果页：真结果在 .module-card-item 里，「大家都在搜」的裸链接不含该容器
function parseSearchPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  $(".module-card-item, .module-poster-item").each((_, el) => {
    const a = $(el).find("a[href*='/detail/']").first();
    const href = a.attr("href") || $(el).attr("href") || "";
    const m = href.match(/\/detail\/(\d+)\.html/);
    if (!m) return;
    const name = decodeHtml(
      $(el).find(".module-card-item-title, .module-poster-item-title").text() || a.attr("title") || ""
    ).replace(/\s+/g, " ").trim();
    if (!name) return;
    const pic = normalizePic(
      $(el).find("img.lazyload").attr("data-src") || $(el).find("img").attr("src") || ""
    );
    const note = decodeHtml(
      $(el).find(".module-card-item-class, .module-item-note, .module-card-item-footer").first().text()
    ).trim();
    items.push({ vod_id: m[1], vod_name: name, vod_pic: pic, vod_remarks: note, type_id: "", type_name: "" });
  });
  return items;
}

function parseLabelPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  $("a[href*='/detail/']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const m = href.match(/\/detail\/(\d+)\.html/);
    if (!m) return;
    const name = decodeHtml(
      $(el).attr("title") || $(el).find(".module-poster-item-title").text() || $(el).text()
    ).replace(/\s+/g, " ").trim();
    if (!name) return;
    const pic = normalizePic(
      $(el).find("img.lazyload").attr("data-src") || $(el).find("img").attr("src") || ""
    );
    const note = decodeHtml($(el).find(".module-item-note").text());
    items.push({ vod_id: m[1], vod_name: name, vod_pic: pic, vod_remarks: note, type_id: "", type_name: "" });
  });
  return items;
}

// 站点已关闭搜索：/search 与 /type 均需图形验证码，ajax 的 wd 被忽略，suggest 返回“联想搜索功能关闭中”。
// 这里退化为「最新列表 + 标签页热播榜本地匹配」，并缓存结果，避免用户误以为是脚本 bug。
async function search(params, context) {
  try {
    const keyword = String(params.keyword || "").trim();
    const page = Math.max(1, Number(params.page) || 1);
    if (!keyword) return { page: 1, pagecount: 0, total: 0, list: [] };

    const cacheKey = `zzz:search:v3:${keyword}`;
    try {
      const cached = await OmniBox.getCache(cacheKey);
      if (cached) {
        const arr = typeof cached === "string" ? JSON.parse(cached) : cached;
        if (Array.isArray(arr) && arr.length) {
          await logInfo(`search "${keyword}" 命中缓存 ${arr.length} 条`);
          return { page, pagecount: page, total: arr.length, list: arr };
        }
      }
    } catch (_) {
      /* 缓存不可用继续扫描 */
    }

    // 站内真搜索：用蜘蛛 UA 请求 /search/...，站点对搜索引擎放行，不弹验证码
    try {
      const searchUrl = `${HOST}/search/-------------.html?wd=${encodeURIComponent(keyword)}&submit=`;
      const html = await httpGet(searchUrl, HOST + "/", SPIDER_UA);
      if (!isVerifyPage(html)) {
        const items = uniqueByVodId(parseSearchPage(html)).slice(0, 30);
        await logInfo(`search "${keyword}" 站内搜索命中 ${items.length} 条`);
        if (items.length) {
          try {
            await OmniBox.setCache(cacheKey, JSON.stringify(items), 600);
          } catch (_) {
            /* 写缓存失败不影响返回 */
          }
          return { page, pagecount: 1, total: items.length, list: items };
        }
      } else {
        await logInfo("search 站内搜索命中验证页（蜘蛛 UA 可能失效），回退本地匹配");
      }
    } catch (e) {
      await logInfo(`search 站内搜索失败: ${e.message}，回退本地匹配`);
    }

    const seen = new Set();
    const hits = [];
    const push = (item) => {
      if (!item || !item.vod_id || seen.has(item.vod_id)) return;
      const name = String(item.vod_name || "");
      if (!name.includes(keyword)) return;
      seen.add(item.vod_id);
      hits.push(item);
    };

    for (let p = 1; p <= 5; p++) {
      try {
        const { list } = await fetchList("", p);
        list.map(mapItem).forEach(push);
      } catch (_) {
        break;
      }
      if (hits.length >= 30) break;
    }

    if (hits.length < 10) {
      for (const slug of ["qq", "youku", "bli", "duanju"]) {
        try {
          const html = await httpGet(`${HOST}/label/${slug}.html`);
          parseLabelPage(html).forEach(push);
        } catch (_) {
          /* 单个标签失败不影响整体 */
        }
        if (hits.length >= 30) break;
      }
    }

    const list = hits.slice(0, 30);
    if (list.length) {
      try {
        await OmniBox.setCache(cacheKey, JSON.stringify(list), 600);
      } catch (_) {
        /* 写缓存失败不影响返回 */
      }
    }
    await logInfo(`search "${keyword}" 本地命中 ${list.length} 条（站点搜索已关闭，改为最新列表+标签页匹配）`);
    return { page, pagecount: list.length ? 1 : 0, total: list.length, list };
  } catch (e) {
    await logError(`search 异常: ${e.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

async function getPlayerConfig() {
  try {
    const cached = await OmniBox.getCache(CFG_CACHE_KEY);
    if (cached) {
      const parsed = typeof cached === "string" ? JSON.parse(cached) : cached;
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch (_) {
    /* 缓存不可用则继续实取 */
  }
  try {
    const js = await httpGet(`${HOST}/static/js/playerconfig.js`);
    // 站点把 player_list / downer_list / server_list 串在同一个 js 里，
    // 用固定尾巴容易因为拼写/顺序变化失配，这里按赋值边界切片。
    const start = js.indexOf("player_list=");
    if (start < 0) {
      await logError("playerconfig 未找到 player_list");
      return {};
    }
    const from = start + "player_list=".length;
    const nextAssign = js.indexOf(",MacPlayerConfig.", from);
    const jsonText = js.slice(from, nextAssign > from ? nextAssign : undefined).trim();
    let cfg;
    try {
      cfg = JSON.parse(jsonText);
    } catch (e) {
      await logError(`playerconfig JSON 解析失败: ${e.message}`);
      return {};
    }
    try {
      await OmniBox.setCache(CFG_CACHE_KEY, JSON.stringify(cfg), CFG_CACHE_TTL);
    } catch (_) {
      /* 写缓存失败不影响播放 */
    }
    return cfg;
  } catch (e) {
    await logError(`playerconfig 获取失败: ${e.message}`);
    return {};
  }
}

// 解析站自带取流接口（比 sniffVideo 快一个数量级）：
//   GET  {origin}/player/?url=<co_xxx|JD-xxx>  → 页面里下发 data-u / data-te
//   POST {origin}/player/mplayer.php  url=<data-u>&token=<data-te>
//        → {"code":200,"url":"https://...m3u8","type":"hls"}
// 实测 0.5s 出结果；token 可复用，但必须先带站点 Referer 打开解析页，
// 否则返回空响应。注意解析页的 Referer 必须是 www.zzztool.com 的页面。
async function resolveParseDirect(parseBase, target) {
  const started = Date.now();
  const offKey = "zzz:pdirect:off:v1";
  try {
    // 解析站按 IP 限流，连着试只会越封越久：失败后静默一段时间，直接用嗅探兜底
    if (await OmniBox.getCache(offKey)) return null;
  } catch (_) {
    /* 缓存不可用则继续尝试 */
  }
  try {
    const origin = new URL(parseBase).origin;
    const pageUrl = `${origin}/player/?url=${encodeURIComponent(target)}`;
    const html = await httpGet(pageUrl, `${HOST}/`);
    if (!html) {
      await logInfo("解析接口 页面为空（可能被 Referer 拦）");
      return null;
    }
    const u = (html.match(/data-u="([^"]+)"/) || [])[1] || target;
    const te = (html.match(/data-te="([^"]+)"/) || [])[1];
    if (!te) {
      await logInfo("解析接口 未取到 token");
      return null;
    }
    // 注意：SDK 的 request() 只要带 body 就强制 Content-Type: application/json，
    // 表单字符串会被当成 JSON 发出去，解析站直接回「请传递正确的json参数」。
    // 所以这里先发 JSON 体；再退一步把参数放 query（空 body，避免被改成 JSON）。
    const attempts = [
      {
        label: "json",
        url: `${origin}/player/mplayer.php`,
        headers: {
          "User-Agent": UA,
          Referer: `${HOST}/`,
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({ url: u, token: te }),
      },
      {
        label: "query",
        url: `${origin}/player/mplayer.php?url=${encodeURIComponent(u)}&token=${encodeURIComponent(te)}`,
        headers: {
          "User-Agent": UA,
          Referer: `${HOST}/`,
          "X-Requested-With": "XMLHttpRequest",
        },
        body: undefined,
      },
    ];
    for (const attempt of attempts) {
      let res;
      try {
        res = await OmniBox.request(attempt.url, {
          method: "POST",
          headers: attempt.headers,
          body: attempt.body,
        });
      } catch (e) {
        await logInfo(`解析接口(${attempt.label})异常: ${e.message}`);
        continue;
      }
      const rawBody = unwrapBody(res.body);
      let json = {};
      try {
        json = JSON.parse(rawBody || "{}");
      } catch (_) {
        json = {};
      }
      if (Number(json.code) === 200 && json.url) {
        await logInfo(`解析接口成功(${attempt.label}) ${Date.now() - started}ms ${String(json.url).slice(0, 110)}`);
        return { url: String(json.url), header: null };
      }
      await logInfo(
        `解析接口(${attempt.label})失败 code=${json.code || res.statusCode} 耗时=${Date.now() - started}ms body=${String(rawBody || "").slice(0, 100)}`
      );
    }
    try {
      await OmniBox.setCache(offKey, "1", 300);
    } catch (_) {
      /* 写缓存失败不影响返回 */
    }
    return null;
  } catch (e) {
    await logInfo(`解析接口异常: ${e.message}`);
    return null;
  }
}

async function sniffDirect(targetUrl) {
  if (!OmniBox.sniffVideo) return null;
  try {
    const started = Date.now();
    const sniffed = await OmniBox.sniffVideo(targetUrl, { "User-Agent": UA, Referer: HOST + "/" });
    if (sniffed && sniffed.url) {
      await logInfo(`嗅探成功 耗时=${Date.now() - started}ms url=${String(sniffed.url).slice(0, 140)}`);
      return { url: sniffed.url, header: sniffed.header || null };
    }
    await logInfo(`嗅探无结果 耗时=${Date.now() - started}ms`);
  } catch (e) {
    await logInfo(`嗅探失败: ${e.message}`);
  }
  return null;
}

// 站点解析出来的“流”不一定真能播：实测两种假货
//   1) sid=9 蓝光2k：解析出 https://yun.jiexicn.top/api/vod/demo/playlist.m3u8，
//      m3u8 与分片都是 200，但分片是一张 1px gif（演示占位流）
//   2) sid=8 蓝光2k：解析出 cibn 的 m3u8，带 auth_key 已失效，302 到失效页
// 只判「状态码 200」会把它们当成功，客户端点进去照样黑屏。
const PLACEHOLDER_HINTS = ["/api/vod/demo/", "image.baidu.com", "console.lookbook.top", "picsum.photos"];

function absUrl(u, base) {
  try {
    return new URL(u, base).toString();
  } catch (_) {
    return u;
  }
}

async function fetchPlaylist(url) {
  const res = await OmniBox.request(url, { method: "GET", headers: { "User-Agent": UA } });
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
  return unwrapBody(res.body);
}

// master playlist 只给一路 variant（index.m3u8 -> 3000k/hls/mixed.m3u8），
// 必须跟到真正的分片列表，否则“首个非 # 行”其实还是个子 m3u8。
async function resolveSegments(m3u8Url, depth = 0) {
  const text = String(await fetchPlaylist(m3u8Url));
  if (!/#EXTM3U/i.test(text)) throw new Error("不是 m3u8");
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const subs = lines.filter((l) => !l.startsWith("#"));
  if (/#EXT-X-STREAM-INF/i.test(text) && depth < 2 && subs.length) {
    return resolveSegments(absUrl(subs[0], m3u8Url), depth + 1);
  }
  return { text, segments: subs.map((s) => absUrl(s, m3u8Url)) };
}

// 返回 { ok, segBytes }：既判可播，也顺便量一下分片大小（4K 单片 8MB 左右，
// 带宽不够的端会卡，用于决定要不要额外给几条 1080p 备选）
async function probeStream(m3u8Url) {
  try {
    if (PLACEHOLDER_HINTS.some((h) => m3u8Url.includes(h))) {
      await logInfo(`分片抽检 占位流 ${m3u8Url.slice(0, 100)}`);
      return { ok: false, segBytes: 0 };
    }
    const { text, segments } = await resolveSegments(m3u8Url);
    if (PLACEHOLDER_HINTS.some((h) => text.includes(h))) {
      await logInfo("分片抽检 播放列表是演示占位内容");
      return { ok: false, segBytes: 0 };
    }
    if (segments.length < 3) {
      await logInfo(`分片抽检 分片过少(${segments.length})，判为无效`);
      return { ok: false, segBytes: 0 };
    }
    let okCount = 0;
    let segBytes = 0;
    for (const seg of segments.slice(0, 1)) {
      try {
        const res = await OmniBox.request(seg, {
          method: "GET",
          headers: { "User-Agent": UA, Range: "bytes=0-2047" },
        });
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        const size = Number(res.headers && (res.headers["content-range"] || "").split("/").pop()) || 0;
        if (ok) {
          okCount++;
          if (size > segBytes) segBytes = size;
        }
        await logInfo(`分片抽检 ${res.statusCode} ${ok ? "可用" : "缺失"} ${seg.slice(0, 100)}`);
      } catch (e) {
        await logInfo(`分片抽检异常: ${e.message}`);
      }
    }
    return { ok: okCount > 0, segBytes };
  } catch (e) {
    await logInfo(`播放列表解析失败: ${e.message}`);
    return { ok: false, segBytes: 0 };
  }
}

// 详情页里 sid -> 线路名的解析已并入 findAltDirects，避免重复请求详情页

// 当前集在其他线路里的直链：同 nid 换 sid 取 player_aaaa，并发取页面 + 并发抽检，
// 返回所有可用线路（不再只取第一条——用户嫌卡时可以直接换线）
async function findAltDirects(videoId, nid, excludeSid, limit = 3) {
  try {
    const detailUrl = `${HOST}/detail/${videoId}.html`;
    const html = await httpGet(detailUrl);
    const $ = cheerio.load(html);
    const labels = [];
    $(".mx-anthology-tab .mx-anthology-tab-label").each((_, el) => labels.push(decodeHtml($(el).text())));
    const nameBySid = {};
    const sidOrder = [];
    $(".mx-anthology-panel").each((idx, panel) => {
      const href = $(panel).find("a.mx-anthology-link[href]").first().attr("href") || "";
      const m = href.match(/\/play\/\d+-(\d+)-\d+\.html/);
      if (!m) return;
      nameBySid[m[1]] = labels[idx] || `线路${m[1]}`;
      if (m[1] !== excludeSid && !sidOrder.includes(m[1])) sidOrder.push(m[1]);
    });

    // 上次这一部里哪几条 sid 好用，优先探它们（不用每集都把 5 条全试一遍）
    let pref = [];
    try {
      const raw = await OmniBox.getCache(`zzz:altorder:v1:${videoId}`);
      if (raw) pref = JSON.parse(raw);
    } catch (_) {
      pref = [];
    }
    if (Array.isArray(pref) && pref.length) {
      sidOrder.sort((a, b) => {
        const ia = pref.indexOf(a);
        const ib = pref.indexOf(b);
        return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib);
      });
    } else {
      pref = [];
    }

    const pages = await Promise.all(
      sidOrder.slice(0, pref.length ? 3 : 5).map(async (sid) => {
        try {
          const page = await httpGet(`${HOST}/play/${videoId}-${sid}-${nid}.html`, detailUrl);
          const pm = page.match(/var player_aaaa=(\{[\s\S]*?\})<\/script>/);
          if (!pm) return null;
          const target = String(JSON.parse(pm[1]).url || "");
          if (!/^https?:\/\/[^\s]+\.(m3u8|mp4|flv)(\?|$)/i.test(target)) return null;
          return { sid, url: target, name: nameBySid[sid] || `线路${sid}` };
        } catch (_) {
          return null;
        }
      })
    );
    const candidates = pages.filter(Boolean);
    const checked = await Promise.all(
      candidates.map(async (c) => ({ ...c, ok: (await probeStream(c.url)).ok }))
    );
    const usable = checked.filter((c) => c.ok).slice(0, limit);
    for (const c of usable) await logInfo(`备选可用 sid=${c.sid} ${c.name} ${c.url.slice(0, 90)}`);
    if (usable.length) {
      try {
        await OmniBox.setCache(`zzz:altorder:v1:${videoId}`, JSON.stringify(usable.map((c) => c.sid)), 900);
      } catch (_) {
        /* 写缓存失败不影响返回 */
      }
    }
    return usable;
  } catch (e) {
    await logInfo(`备选线路查找失败: ${e.message}`);
  }
  return [];
}

// 不要带站点 Referer：实测 svip.ryiplay18.com 带 Referer 会直接 SSL 断连（code=000），
// 不带 Referer 反而 200；dytt-tvs / yzzy 两条线有没有 Referer 都正常。
// 解析线路优先用嗅探器抓到的真实请求头。
const PLAY_HEADER = { "User-Agent": UA };

async function play(params, context) {
  const started = Date.now();
  try {
    const m = String(params.playId || "").match(/^(\d+)-(\d+)-(\d+)$/);
    if (!m) {
      await logError(`play 非法 playId: ${params.playId}`);
      return { urls: [], parse: 1 };
    }
    const [, videoId, sid, nid] = m;
    const pageUrl = `${HOST}/play/${videoId}-${sid}-${nid}.html`;
    const html = await httpGet(pageUrl, `${HOST}/detail/${videoId}.html`);
    const pm = html.match(/var player_aaaa=(\{[\s\S]*?\})<\/script>/);
    if (!pm) {
      await logError(`play ${videoId}-${sid}-${nid} 未找到 player_aaaa`);
      return { urls: [], parse: 1 };
    }
    const data = JSON.parse(pm[1]);
    let target = String(data.url || "");
    if (Number(data.encrypt) === 1) {
      try {
        target = unescape(target);
      } catch (_) {
        /* 保持原样 */
      }
    } else if (Number(data.encrypt) === 2) {
      try {
        target = Buffer.from(target, "base64").toString("utf8");
      } catch (_) {
        /* 保持原样 */
      }
    }

    if (/^https?:\/\/[^\s]+\.(m3u8|mp4|flv)(\?|$)/i.test(target)) {
      await logInfo(`play 直链 sid=${sid} nid=${nid} 耗时=${Date.now() - started}ms ${target.slice(0, 120)}`);
      return { urls: [{ name: "直链", url: target }], parse: 0, header: PLAY_HEADER };
    }

    const cfg = await getPlayerConfig();
    const entry = cfg[data.from] || {};
    if (String(entry.ps) === "1" && entry.parse) {
      const parseUrl = `${entry.parse}${encodeURIComponent(target)}`;
      // 预热调用不触发 9~15 秒的嗅探，避免宿主一次预取多集把队列堵死
      if (context && context.prefetch) {
        await logInfo(`play 预热跳过嗅探 sid=${sid} nid=${nid}`);
        return { urls: [{ name: entry.show || "解析", url: parseUrl }], parse: 1, header: PLAY_HEADER };
      }
      const deadKey = `zzz:deadline:v1:${videoId}:${sid}`;
      let knownDead = false;
      try {
        knownDead = !!(await OmniBox.getCache(deadKey));
      } catch (_) {
        /* 缓存不可用就走正常流程 */
      }
      if (knownDead) {
        // 这条解析线路刚被证伪过（占位/失效流），别再白等 8~15 秒嗅探
        const alts = await findAltDirects(videoId, nid, sid, 3);
        if (alts.length) {
          await logInfo(`play ${entry.show || "解析"} 已知源失效，直接给 ${alts.length} 条可用线路`);
          return { urls: alts.map((a) => ({ name: a.name, url: a.url })), parse: 0, header: PLAY_HEADER };
        }
      }
      const sniffed = (await resolveParseDirect(entry.parse, target)) || (await sniffDirect(parseUrl));
      if (sniffed) {
        const lineName = entry.show || "解析";
        const header = { ...PLAY_HEADER, ...(sniffed.header || {}) };
        const probe = await probeStream(sniffed.url);
        if (probe.ok) {
          // 4K 线路码率高（单片 8MB≈13Mbps），但不再在 play 里顺带探 1080p 备选：
          // 那要多花 2~3 秒，而详情页本来就列着自营t/y/r，卡了直接换线路即可。
          return { urls: [{ name: lineName, url: sniffed.url }], parse: 0, header };
        }
        // 这集的解析流是残缺/占位的（分片 404、302 到失效页、演示 gif），
        // 换同集直链线路，坏线路放后面备查
        try {
          await OmniBox.setCache(deadKey, "1", 600);
        } catch (_) {
          /* 写缓存失败不影响返回 */
        }
        const alts = await findAltDirects(videoId, nid, sid, 3);
        if (alts.length) {
          return {
            urls: [
              ...alts.map((a) => ({ name: a.name, url: a.url })),
              { name: `${lineName}（源缺失）`, url: sniffed.url },
            ],
            parse: 0,
            header: PLAY_HEADER,
          };
        }
        return { urls: [{ name: `${lineName}（源缺失）`, url: sniffed.url }], parse: 0, header };
      }
      await logInfo(`play 解析回退 sid=${sid} 耗时=${Date.now() - started}ms`);
      // 解析接口和嗅探都拿不到（解析站限流/被封时常见）：先给同集直链，
      // 实在没有才回页面地址，避免客户端拿到一个空壳页面
      const alts = await findAltDirects(videoId, nid, sid, 3);
      if (alts.length) {
        return { urls: alts.map((a) => ({ name: a.name, url: a.url })), parse: 0, header: PLAY_HEADER };
      }
      return { urls: [{ name: entry.show || "解析", url: parseUrl }], parse: 1, header: PLAY_HEADER };
    }

    await logInfo(`play 页面地址 sid=${sid} 耗时=${Date.now() - started}ms from=${data.from}`);
    return { urls: [{ name: "播放", url: target }], parse: 1, header: PLAY_HEADER };
  } catch (e) {
    await logError(`play 异常: ${e.message}`);
    return { urls: [], parse: 1 };
  }
}
