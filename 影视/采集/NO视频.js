// @name NO视频
// @description NO视频 - https://www.novipnoad.us/ 海外剧集电影采集站（恢复 SDK 嗅探 + 详情页回退）
// @dependencies cheerio
// @version 1.2.1
// @downloadURL https://gh-proxy.org/https://github.com/tardlk/OmniBox-Spider/raw/refs/heads/main/影视/采集/NO视频.js

const cheerio = require("cheerio");
const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

// 站点换过域名：.net 已挂，现在走 .us
const HOST = "https://www.novipnoad.us";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

const CATEGORIES = [
  { type_id: "movie", type_name: "电影", path: "/movie/" },
  { type_id: "tv-hongkong", type_name: "港剧", path: "/tv/hongkong/" },
  { type_id: "tv-taiwan", type_name: "台剧", path: "/tv/taiwan/" },
  { type_id: "tv-western", type_name: "欧美剧", path: "/tv/western/" },
  { type_id: "tv-japan", type_name: "日剧", path: "/tv/japan/" },
  { type_id: "tv-korea", type_name: "韩剧", path: "/tv/korea/" },
  { type_id: "tv-thailand", type_name: "泰剧", path: "/tv/thailand/" },
  { type_id: "tv-turkey", type_name: "土耳其剧", path: "/tv/turkey/" },
  { type_id: "anime", type_name: "动画", path: "/anime/" },
  { type_id: "shows", type_name: "综艺", path: "/shows/" },
  { type_id: "music", type_name: "音乐", path: "/music/" },
  { type_id: "short", type_name: "短片", path: "/short/" },
  { type_id: "other", type_name: "其他", path: "/other/" },
];

function absUrl(url = "") {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return "https:" + url;
  return HOST + (url.startsWith("/") ? url : `/${url}`);
}

function decodeHtml(text = "") {
  return String(text)
    .replace(/&#8211;/g, "-")
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
}

async function logInfo(message) {
  await OmniBox.log("info", `[NO视频] ${message}`);
}

async function logError(message) {
  await OmniBox.log("error", `[NO视频] ${message}`);
}

async function requestHtml(url) {
  try {
    await logInfo(`请求 ${url}`);
    const res = await OmniBox.request(url, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        Referer: HOST + "/",
      },
    });
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers && (res.headers.Location || res.headers.location)) {
      const redirected = absUrl(res.headers.Location || res.headers.location);
      await logInfo(`跟随跳转 ${redirected}`);
      return await requestHtml(redirected);
    }
    if (res.statusCode !== 200) {
      throw new Error(`HTTP ${res.statusCode}`);
    }
    return res.body || "";
  } catch (e) {
    await logError(`请求失败 ${url}: ${e.message}`);
    return "";
  }
}

function extractNumericId(url = "") {
  const match = String(url).match(/\/(\d+)\.html?$/i);
  return match ? match[1] : "";
}

function detectTypeFromUrl(url = "") {
  const clean = String(url);
  const cat = CATEGORIES.find((item) => clean.includes(item.path));
  return cat || null;
}

// 纯数字 vod_id 与站点文章 ID 一致，宿主侧播放/历史链路最稳；
// 同时兼容 1.2.0 曾短暂使用过的「数字-分类」格式 id

function parseVideoId(videoId) {
  const raw = String(videoId || "").trim();
  const withPath = raw.match(/^(\d+)-([a-z-]+)$/i);
  if (withPath) {
    const path = `/${withPath[2].replace(/-/g, "/")}/`;
    const cat = CATEGORIES.find((item) => item.path === path);
    if (cat) return { numericId: withPath[1], directUrl: `${HOST}${cat.path}${withPath[1]}.html` };
  }
  const numericId = /^\d+$/.test(raw) ? raw : extractNumericId(raw);
  return { numericId, directUrl: "" };
}

function parseCard($, el) {
  const root = $(el).closest(".video-item, article.post, .post, div[class*='video-item']");
  const anchor = root.find(".item-thumbnail a, h3 a, h2 a, a[href$='.html']").first();
  const href = absUrl(anchor.attr("href") || "");
  const title = decodeHtml(
    anchor.attr("title") ||
    root.find("h3 a, h2 a, h3, h2").first().text() ||
    root.text()
  );
  const img = absUrl(
    root.find("img[data-original]").first().attr("data-original") ||
    root.find("img[src]").first().attr("src") || ""
  );
  const cat = detectTypeFromUrl(href);
  const numericId = extractNumericId(href);
  if (!numericId || !title) return null;
  return {
    vod_id: numericId,
    vod_name: title,
    vod_pic: img,
    type_id: cat?.type_id || "",
    type_name: cat?.type_name || "",
    vod_remarks: "",
  };
}

function uniqueByVodId(list) {
  const seen = new Set();
  const result = [];
  for (const item of list) {
    if (!item || !item.vod_id || seen.has(item.vod_id)) continue;
    seen.add(item.vod_id);
    result.push(item);
  }
  return result;
}

async function fetchCategoryPage(category, page) {
  const base = absUrl(category.path);
  const url = page > 1 ? `${base}page/${page}/` : base;
  const html = await requestHtml(url);
  return { url, html };
}

async function resolveDetailPage(videoId, directUrl = "") {
  const urls = [];
  if (directUrl) urls.push(directUrl);
  // WordPress 固定链接 /?p=<id> 会 301 到真实详情页，requestHtml 自动跟随跳转
  urls.push(`${HOST}/?p=${videoId}`);
  for (const item of CATEGORIES) urls.push(`${HOST}${item.path}${videoId}.html`);

  let tried = 0;
  for (const url of urls) {
    tried += 1;
    const html = await requestHtml(url);
    // 必须带播放信息才是真详情页，避免把 404 / 首页误判成成功
    if (html && /window\.playInfo|multilink-btn/.test(html) && !/未找到页面|404!|Page not found/i.test(html)) {
      return { url, html, tried };
    }
  }
  return { url: "", html: "", tried };
}

function buildPlayId(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function parsePlayId(playId) {
  try {
    return JSON.parse(Buffer.from(String(playId || ""), "base64").toString("utf8"));
  } catch {
    return {};
  }
}

async function home(params, context) {
  try {
    const classList = CATEGORIES.map(({ type_id, type_name }) => ({ type_id, type_name }));
    const { html } = await fetchCategoryPage(CATEGORIES[0], 1);
    const $ = cheerio.load(html || "");
    const cards = [];
    $(".video-item, article.post, .post").each((_, el) => {
      const item = parseCard($, el);
      if (item) cards.push(item);
    });
    const list = uniqueByVodId(cards).slice(0, 20);
    await logInfo(`home 返回 ${list.length} 条`);
    return { class: classList, list };
  } catch (e) {
    await logError(`home 异常: ${e.message}`);
    return { class: CATEGORIES.map(({ type_id, type_name }) => ({ type_id, type_name })), list: [] };
  }
}

async function category(params, context) {
  try {
    const categoryId = String(params.categoryId || "movie");
    const page = Math.max(1, Number(params.page) || 1);
    const category = CATEGORIES.find((item) => item.type_id === categoryId) || CATEGORIES[0];
    const { html } = await fetchCategoryPage(category, page);
    const $ = cheerio.load(html || "");
    const cards = [];
    $(".video-item, article.post, .post").each((_, el) => {
      const item = parseCard($, el);
      if (item) {
        item.type_id = category.type_id;
        item.type_name = category.type_name;
        cards.push(item);
      }
    });
    const list = uniqueByVodId(cards);
    const hasNext = $("a[href*='/page/']").toArray().some((a) => {
      const href = $(a).attr("href") || "";
      return href.includes(`/page/${page + 1}/`);
    });
    await logInfo(`category ${categoryId} page=${page} 返回 ${list.length} 条`);
    return {
      page,
      pagecount: hasNext ? page + 1 : page,
      total: hasNext ? page * list.length + list.length : page * list.length,
      list,
    };
  } catch (e) {
    await logError(`category 异常: ${e.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

async function detail(params, context) {
  try {
    const rawVideoId = String(params.videoId || "").trim();
    if (!rawVideoId) return { list: [] };
    const { numericId: videoId, directUrl } = parseVideoId(rawVideoId);
    if (!videoId) return { list: [] };
    const started = Date.now();
    const { url, html, tried } = await resolveDetailPage(videoId, directUrl);
    if (!html) {
      await logError(`detail ${rawVideoId} 未找到详情页，尝试 ${tried} 个地址`);
      return { list: [] };
    }
    const $ = cheerio.load(html);

    const finalDetailUrl = absUrl($("meta[property='og:url']").attr("content") || url);
    const title = decodeHtml($("h1.entry-title, h1").first().text());
    const pic = absUrl(
      $("meta[property='og:image']").attr("content") ||
      $("img[src*='upload'], img[data-original]").first().attr("src") ||
      $("img[data-original]").first().attr("data-original") || ""
    );
    const content = decodeHtml($(".item-content").first().text());
    const yearMatch = title.match(/(19|20)\d{2}/);
    const year = yearMatch ? yearMatch[0] : "";
    const cat = detectTypeFromUrl(finalDetailUrl);

    const playInfoMatch = html.match(/window\.playInfo\s*=\s*\{[\s\S]*?pkey\s*:\s*"([^"]+)"/i);
    const pkey = playInfoMatch ? playInfoMatch[1] : "";

    const episodes = [];
    $("a.multilink-btn[data-vid]").each((_, el) => {
      const btn = $(el);
      const vid = String(btn.attr("data-vid") || "").trim();
      const name = decodeHtml(btn.text().replace(/^\s+|\s+$/g, "")) || "在线播放";
      if (!vid || !pkey) return;
      episodes.push({
        name,
        playId: buildPlayId({ videoId, detailUrl: finalDetailUrl, vid, pkey, title }),
      });
    });

    if (!episodes.length) {
      const singlePlayInfoMatch = html.match(/window\.playInfo\s*=\s*\{\s*vid\s*:\s*"([^"]+)"\s*,\s*pkey\s*:\s*"([^"]+)"/i);
      const vid = singlePlayInfoMatch ? singlePlayInfoMatch[1] : "";
      const singlePkey = singlePlayInfoMatch ? singlePlayInfoMatch[2] : pkey;
      if (vid && singlePkey) {
        episodes.push({
          name: "在线播放",
          playId: buildPlayId({ videoId, detailUrl: finalDetailUrl, vid, pkey: singlePkey, title }),
        });
      }
    }

    const vod = {
      vod_id: rawVideoId,
      vod_name: title,
      vod_pic: pic,
      vod_content: content,
      vod_year: year,
      type_id: cat?.type_id || "",
      type_name: cat?.type_name || "",
      vod_play_sources: episodes.length ? [{ name: "NO视频", episodes }] : [],
    };

    await logInfo(`detail ${rawVideoId} episodes=${episodes.length} 请求=${tried} 耗时=${Date.now() - started}ms ${directUrl ? "路径直达" : "?p= 跳转"}`);
    return { list: [vod] };
  } catch (e) {
    await logError(`detail 异常: ${e.message}`);
    return { list: [] };
  }
}

async function search(params, context) {
  try {
    const keyword = String(params.keyword || "").trim();
    const page = Math.max(1, Number(params.page) || 1);
    if (!keyword) return { page: 1, pagecount: 0, total: 0, list: [] };

    const searchUrl = `${HOST}/search/${encodeURIComponent(keyword)}/`;
    const html = await requestHtml(searchUrl);
    const $ = cheerio.load(html || "");
    const cards = [];
    $(".video-item, article.post, .post").each((_, el) => {
      const item = parseCard($, el);
      if (item) cards.push(item);
    });
    const list = uniqueByVodId(cards);
    const hasNext = $("a[href*='/page/']").toArray().some((a) => {
      const href = $(a).attr("href") || "";
      return href.includes(`/page/${page + 1}/`);
    });
    await logInfo(`search ${keyword} 返回 ${list.length} 条`);
    return {
      page,
      pagecount: hasNext ? page + 1 : page,
      total: hasNext ? page * list.length + list.length : page * list.length,
      list,
    };
  } catch (e) {
    await logError(`search 异常: ${e.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

// 站点详情页本身不会自动起播：必须点击 .multilink-btn 才会插入
// player.novipnoad.us/v1/ iframe -> player.php -> enc-vod 配置 -> 真实流。
// 所以播放结果必须保留 SDK 嗅探 + parse=1 页面回退这两条链路；
// 1.2.0 只回 parse=1 详情页、又去掉了嗅探，在网页端/TVBox 上等于给了个空页面。
async function sniffNoVideoPlay(playUrl) {
  if (!OmniBox.sniffVideo) return null;
  const started = Date.now();
  try {
    const sniffed = await OmniBox.sniffVideo(playUrl, {
      "User-Agent": UA,
      Referer: HOST + "/",
    });
    if (sniffed && sniffed.url) {
      await logInfo(`嗅探成功 耗时=${Date.now() - started}ms url=${String(sniffed.url).slice(0, 160)}`);
      return {
        urls: [{ name: "嗅探线路", url: sniffed.url }],
        parse: 0,
        header: {
          "User-Agent": UA,
          Referer: playUrl,
          ...(sniffed.header || {}),
        },
      };
    }
    await logInfo(`嗅探无结果 耗时=${Date.now() - started}ms url=${playUrl}`);
  } catch (e) {
    await logInfo(`嗅探失败 耗时=${Date.now() - started}ms: ${e.message}`);
  }
  return null;
}

async function play(params, context) {
  const started = Date.now();
  try {
    const meta = parsePlayId(params.playId || "");
    const playUrl = meta.detailUrl || (meta.videoId ? `${HOST}/?p=${meta.videoId}` : "");
    if (!playUrl) {
      await logError("play 缺少 detailUrl，无法构造播放页");
      return { urls: [], parse: 1 };
    }
    await logInfo(`play 开始 vid=${meta.vid || ""} url=${playUrl}`);

    // NOVIDEO_SKIP_SNIFF=1 可跳过嗅探，仅保留页面回退（供 ok影视等自带 webview 的端对比测试）
    if (String(process.env.NOVIDEO_SKIP_SNIFF || "") !== "1") {
      const sniffResult = await sniffNoVideoPlay(playUrl);
      if (sniffResult) return sniffResult;
    } else {
      await logInfo("play 按 NOVIDEO_SKIP_SNIFF=1 跳过嗅探");
    }

    // 与 1.0.2 一致的兜底：把详情页交给客户端 webview，由站内播放器完成点击与鉴权
    await logInfo(`play 回退 parse=1 耗时=${Date.now() - started}ms`);
    return {
      urls: [{ name: meta.title || "NO视频", url: playUrl }],
      parse: 1,
      header: {
        Referer: playUrl,
        "User-Agent": UA,
      },
    };
  } catch (e) {
    await logError(`play 异常: ${e.message}`);
    return { urls: [], parse: 1 };
  }
}
