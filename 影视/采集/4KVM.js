// @name 4KVM
// @author 
// @description 刮削：支持，弹幕：支持，嗅探：支持，直取：支持
// @dependencies: axios, cheerio
// @version 1.3.0
// @downloadURL https://gh-proxy.org/https://github.com/tardlk/OmniBox-Spider/raw/refs/heads/main/影视/采集/4KVM.js

/**
* ============================================================================
* 4KVM
* 刮削：支持
* 弹幕：支持
* 嗅探：支持
* 直取：支持（wasm 签名直连，不用开浏览器，比嗅探快一个数量级）
* ============================================================================
*/
const axios = require("axios");
const https = require("https");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const cheerio = require("cheerio");
const OmniBox = require("omnibox_sdk");

// ========== 全局配置 ========== 
// 站点换过域名：.org → .net。默认跟 .net，可用 K4VM_HOST 覆盖回 .org 或新域名
const K4VM_HOST = (process.env.K4VM_HOST || "https://www.4kvm.net").replace(/\/+$/, "");
const config = {
    host: K4VM_HOST,
    headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": `${K4VM_HOST}/`,
        "Cache-Control": "no-cache"
    }
};

// 封面图策略（K4VM_IMG）：
//   baidu  默认。保留站点给的百度图床代理 gimg0.baidu.com/gimg/app=2001&...&src=<真实地址>。
//          站点自己的前端就用这个地址，国内 CDN 直连最快；遇到 image.tmdb.org 这种
//          国内根本连不上的图，会再包一层百度代理，保证客户端一定能拿到图。
//   direct 还原成源站直连（4kvm.staticimgjs.org），海外网络/挂代理时更快。
const K4VM_IMG = String(process.env.K4VM_IMG || "baidu").toLowerCase();

const BAIDU_IMG_RE = /gimg\d*\.baidu\.com/i;
// 判断"这张图是不是 tmdb 的"：代理 URL 里也带 tmdb.org，所以只认域名子串
const TMDB_IMG_RE = /image\.tmdb\.org/i;

// 包一层百度图床代理（国内可达，且按 JPEG 压缩后体积更小）
const baiduWrap = (url) => {
    const u = String(url || "").trim();
    if (!u) return u;
    return `https://gimg0.baidu.com/gimg/app=2001&n=0&g=0n&fmt=jpeg&src=${u.replace(/^https?:\/\//i, "")}`;
};

// 从百度代理 URL 里取回原始地址
const baiduUnwrap = (url) => {
    const m = String(url || "").match(/[?&]src=([^&]+)$/);
    if (!m) return "";
    let real = m[1];
    try { real = decodeURIComponent(real); } catch (_) {}
    if (!/^https?:\/\//i.test(real)) real = `https://${real.replace(/^\/+/, "")}`;
    return real;
};

// 统一封面出口：保证交给客户端的地址一定打得开
const finalizeImage = (url) => {
    const u = String(url || "").trim();
    if (!u) return "";
    if (K4VM_IMG === "direct") {
        return BAIDU_IMG_RE.test(u) ? (baiduUnwrap(u) || u) : u;
    }
    if (BAIDU_IMG_RE.test(u)) return u;            // 站点已经是国内代理，直接用
    if (TMDB_IMG_RE.test(u)) return baiduWrap(u);  // tmdb 国内连不上，套一层国内代理
    return u;
};

// 弹幕 API 地址(优先使用环境变量)
const DANMU_API = process.env.DANMU_API || "";

const axiosInstance = axios.create({
    timeout: 60 * 1000,
    httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
    httpAgent: new http.Agent({ keepAlive: true })
});

const PLAY_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "Referer": `${K4VM_HOST}/`,
    "Origin": K4VM_HOST
};

/**
* 日志工具函数
*/
const logInfo = (message, data = null) => {
    const output = data ? `${message}: ${JSON.stringify(data)}` : message;
    OmniBox.log("info", `[4KVM-DEBUG] ${output}`);
};

const logError = (message, error) => {
    OmniBox.log("error", `[4KVM-DEBUG] ${message}: ${error.message || error}`);
};

const encodeMeta = (obj) => {
    try {
        return Buffer.from(JSON.stringify(obj || {}), "utf8").toString("base64");
    } catch {
        return "";
    }
};

const decodeMeta = (str) => {
    try {
        const raw = Buffer.from(str || "", "base64").toString("utf8");
        return JSON.parse(raw || "{}");
    } catch {
        return {};
    }
};

// ========== 播放地址直取（wasm 签名）==========
// 站点播放页的 HTML 里没有任何 m3u8，播放器是这么干的：
//   import('/static/wasm/nbmovie_wasm.js')
//   build_play_url(dataid, secretKey, quality, userlink) -> "/video/play?p=..&s=..&t=..&k=.."
//   fetch(该地址) -> { data: { quality_urls: [...] } }
// 这里直接在 Node 里跑同一个 wasm，就不必再开无头浏览器嗅探（9s → 0.3s）。
const WASM_DIR = path.join(os.tmpdir(), "k4vm-wasm");
const RUNTIME_FILE = path.join(os.tmpdir(), "k4vm-runtime.json");
// userlink 是每次渲染页面时现生成的（同一秒两次请求都不一样），只能用很短时间，
// 过期就重新抓一次播放页。首页给的是 '0'，拿去签名必然 401，所以必须抓 /play/ 页。
const RUNTIME_TTL = 2 * 60 * 1000;
// q=1 是站点的 4K 档，后面几档是 1080/720/480
const QUALITY_TRY = ["1", "1080", "720", "480"];

let wasmModule = null;
let wasmLoading = null;
let runtimeCache = null;

// 站点发给匿名访客的 userlink，以及带 hash 的 wasm 文件路径（发版会变）
const loadSiteRuntime = async (pageUrl = "", force = false) => {
    const now = Date.now();
    const usable = (r) => r && r.userlink && r.userlink !== "0" && now - (r.ts || 0) < RUNTIME_TTL;
    if (!force && usable(runtimeCache)) return runtimeCache;
    if (!force) {
        try {
            const cached = JSON.parse(fs.readFileSync(RUNTIME_FILE, "utf8"));
            if (usable(cached)) {
                runtimeCache = cached;
                return runtimeCache;
            }
        } catch (_) {}
    }
    // 优先抓播放页（首页的 userlink 恒为 '0'，签出来的地址直接 401）
    const target = pageUrl && /\/play\//.test(pageUrl) ? pageUrl : `${config.host}/`;
    const resp = await axiosInstance.get(target, { headers: { ...config.headers, Referer: `${config.host}/` } });
    const $ = cheerio.load(resp.data);
    const xdata = $("nav[x-data]").attr("x-data") || "";
    const matched = xdata.match(/userlink\s*:\s*['"]([^'"]+)['"]/);
    runtimeCache = {
        userlink: matched ? matched[1] : "0",
        jsPath: $("#wasm-cfg").attr("data-js") || (runtimeCache && runtimeCache.jsPath) || "/static/wasm/nbmovie_wasm.js",
        bgPath: $("#wasm-cfg").attr("data-bg") || (runtimeCache && runtimeCache.bgPath) || "/static/wasm/nbmovie_wasm_bg.wasm",
        ts: now,
    };
    try { fs.writeFileSync(RUNTIME_FILE, JSON.stringify(runtimeCache)); } catch (_) {}
    logInfo("站点运行时参数已刷新", { from: target.replace(config.host, ""), userlink: runtimeCache.userlink });
    return runtimeCache;
};

// detail 阶段页面已经在手上了，顺手把 userlink 和 wasm 路径存下来，play 时省一次请求
const rememberRuntime = (userlink, jsPath, bgPath) => {
    if (!userlink || userlink === "0") return;
    runtimeCache = {
        userlink,
        jsPath: jsPath || (runtimeCache && runtimeCache.jsPath) || "/static/wasm/nbmovie_wasm.js",
        bgPath: bgPath || (runtimeCache && runtimeCache.bgPath) || "/static/wasm/nbmovie_wasm_bg.wasm",
        ts: Date.now(),
    };
    try { fs.writeFileSync(RUNTIME_FILE, JSON.stringify(runtimeCache)); } catch (_) {}
};

// 下载并初始化 wasm。wasm-bindgen 产物是 ESM，得存成 .mjs 才能 import
const getWasm = async () => {
    if (wasmModule) return wasmModule;
    if (wasmLoading) return wasmLoading;
    wasmLoading = (async () => {
        const rt = await loadSiteRuntime();
        fs.mkdirSync(WASM_DIR, { recursive: true });
        const jsFile = path.join(WASM_DIR, "mod.mjs");
        const wasmFile = path.join(WASM_DIR, "bg.wasm");
        if (!fs.existsSync(jsFile) || !fs.existsSync(wasmFile)) {
            const [jsResp, wasmResp] = await Promise.all([
                axiosInstance.get(`${config.host}${rt.jsPath}`, {
                    headers: config.headers,
                    responseType: "text",
                    transformResponse: [(d) => d],
                }),
                axiosInstance.get(`${config.host}${rt.bgPath}`, {
                    headers: config.headers,
                    responseType: "arraybuffer",
                }),
            ]);
            fs.writeFileSync(jsFile, jsResp.data);
            fs.writeFileSync(wasmFile, Buffer.from(wasmResp.data));
            logInfo("wasm 资源已下载", { js: rt.jsPath, bg: rt.bgPath });
        }
        const mod = await import(pathToFileURL(jsFile).href);
        // Node 下没有 file:// 的 fetch，必须把字节直接喂给 init
        await mod.default({ module_or_path: new Uint8Array(fs.readFileSync(wasmFile)) });
        wasmModule = mod;
        logInfo("wasm 初始化完成");
        return mod;
    })().catch((e) => {
        wasmLoading = null;
        wasmModule = null;
        throw e;
    });
    return wasmLoading;
};

// 抖音系 CDN（douyinbit / douyinvod / byteimg / ixigua）带外站 Referer 会 403
const buildPlayHeaders = (url) => {
    const u = String(url || "");
    if (/douyinbit|douyinvod|byteimg|ixigua|bytedance|bytecdntp/i.test(u)) {
        return { "User-Agent": PLAY_HEADERS["User-Agent"] };
    }
    return { ...PLAY_HEADERS };
};

const resolveViaWasm = async (dataId, secretKey, pageUrl) => {
    if (!dataId || !secretKey) return null;
    const mod = await getWasm();

    const attempt = async (userlink) => {
        for (const quality of QUALITY_TRY) {
            let signed;
            try {
                signed = mod.build_play_url(String(dataId), String(secretKey), quality, userlink || "0");
            } catch (e) {
                logInfo(`wasm 签名失败 q=${quality}: ${e.message}`);
                continue;
            }
            if (!signed) continue;

            const t0 = Date.now();
            let resp;
            try {
                resp = await axiosInstance.get(`${config.host}${signed}`, {
                    headers: {
                        ...config.headers,
                        Referer: pageUrl || `${config.host}/`,
                        Accept: "application/json, text/plain, */*",
                    },
                    responseType: "json",
                });
            } catch (e) {
                logInfo(`wasm 取流失败 q=${quality}: ${e.message}`);
                continue;
            }

            const data = resp.data && resp.data.data;
            const list = (data && data.quality_urls) || [];
            const usable = list.filter((x) => x && x.url && /^https?:\/\//i.test(x.url) && !x.locked);
            logInfo(`直取 q=${quality}: 共 ${list.length} 档，可用 ${usable.length} 档，耗时 ${Date.now() - t0}ms`);
            if (!usable.length) continue;

            usable.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
            return {
                // 站点的 bitrate 字段对 4K 是真码率(2160000)、对 1080 却是分辨率(1080)，
                // 混着显示会变成"1080p 1k"，所以只留 title
                urls: usable.map((x, i) => ({
                    name: x.title || x.description || `线路${i + 1}`,
                    url: x.url,
                })),
                parse: 0,
                header: buildPlayHeaders(usable[0].url),
            };
        }
        return null;
    };

    let rt = await loadSiteRuntime(pageUrl);
    let result = await attempt(rt.userlink);
    if (!result) {
        // 多半是 userlink 过期（它按页面渲染现生成），重抓一次播放页再签
        logInfo("直取未命中，刷新 userlink 重试一次");
        rt = await loadSiteRuntime(pageUrl, true);
        result = await attempt(rt.userlink);
    }
    return result;
};

/**
 * 嗅探播放页，兜底提取真实视频地址
 */
const sniff4kvmPlay = async (playUrl) => {
    if (!playUrl) return null;
    try {
        logInfo("尝试嗅探播放页", playUrl);
        const sniffed = await OmniBox.sniffVideo(playUrl);
        if (sniffed && sniffed.url) {
            logInfo("嗅探成功", sniffed.url);
            return {
                urls: [{ name: "嗅探线路", url: sniffed.url }],
                parse: 0,
                header: sniffed.header || { ...PLAY_HEADERS, "Referer": playUrl }
            };
        }
    } catch (error) {
        logInfo(`嗅探失败: ${error.message}`);
    }
    return null;
};

const buildScrapedEpisodeName = (scrapeData, mapping, originalName) => {
    if (!mapping || mapping.episodeNumber === 0 || (mapping.confidence && mapping.confidence < 0.5)) {
        return originalName;
    }
    if (mapping.episodeName) {
        const epName = mapping.episodeNumber + "." + mapping.episodeName;
        return epName;
    }
    if (scrapeData && Array.isArray(scrapeData.episodes)) {
        const hit = scrapeData.episodes.find(
            (ep) => ep.episodeNumber === mapping.episodeNumber && ep.seasonNumber === mapping.seasonNumber
        );
        if (hit?.name) {
            return `${hit.episodeNumber}.${hit.name}`;
        }
    }
    return originalName;
};

const buildScrapedDanmuFileName = (scrapeData, scrapeType, mapping, fallbackVodName, fallbackEpisodeName) => {
    if (!scrapeData) {
        return buildFileNameForDanmu(fallbackVodName, fallbackEpisodeName);
    }
    if (scrapeType === "movie") {
        return scrapeData.title || fallbackVodName;
    }
    const title = scrapeData.title || fallbackVodName;
    const seasonAirYear = scrapeData.seasonAirYear || "";
    const seasonNumber = mapping?.seasonNumber || 1;
    const episodeNumber = mapping?.episodeNumber || 1;
    return `${title}.${seasonAirYear}.S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
};

/**
* 标准化URL
*/
const normalizeUrl = (url) => {
    if (!url) return url;
    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('/')) return `${config.host}${url}`;
    return url;
};

/**
* 取卡片上的角标文字（"4k" / "全30集" / "更新至12集"）
* 注意：原来的 `.absolute.bottom-0 span` 匹配不到那个 span 自身（它就是容器），
* 于是落到 `.year, .date, span` 兜底，把整段剧情简介当成 remarks 抓了回来。
*/
const pickCardRemarks = ($el) => {
    const raw = (
        $el.find('span.absolute.bottom-0').first().text().trim() ||
        $el.find('span[class*="bottom-0"]').first().text().trim() ||
        $el.find('.text-xs.text-gray-400').last().text().trim() ||
        $el.find('.rating, .imdb, .vote').text().trim() ||
        ''
    );
    const text = raw.replace(/\s+/g, ' ').trim();
    // 超过 20 字基本是简介/简介残段，直接丢掉，别把卡片角标撑爆
    return text && text.length <= 20 ? text : '';
};

/**
* 提取视频基本信息
*/
const extractVideoBasic = ($item) => {
    try {
        const link = normalizeUrl(
            $item.find('a[href*="/play/"]').first().attr('href') ||
            $item.find('a').attr('href') ||
            $item.find('h3 a').attr('href') ||
            $item.find('.data h3 a').attr('href')
        );

        if (!link) return null;

        const title = (
            $item.find('h3').first().text().trim() ||
            $item.find('.data h3').text().trim() ||
            $item.find('img').attr('alt') ||
            $item.find('a').attr('title') ||
            '未知标题'
        );

        const img = finalizeImage(normalizeUrl(
            $item.find('img').attr('data-src') ||
            $item.find('img').attr('src')
        ));

        const remarks = pickCardRemarks($item);

        return {
            vod_id: link,
            vod_name: title,
            vod_pic: img || '',
            vod_remarks: remarks
        };
    } catch (error) {
        logError("提取视频信息失败", error);
        return null;
    }
};

/**
* 获取视频列表
*/
const getVideoList = ($, selector = '.movie-card, article, .items article, .content article') => {
    const videos = [];
    $(selector).each((_, element) => {
        const videoInfo = extractVideoBasic($(element));
        if (videoInfo) {
            videos.push(videoInfo);
        }
    });
    return videos;
};

const getSearchVideoList = ($) => {
    const videos = [];
    const seen = new Set();

    $('a[href^="/play/"]').each((_, element) => {
        const $a = $(element);
        const href = normalizeUrl($a.attr('href'));
        if (!href || seen.has(href)) return;

        const title = (
            $a.find('h3').first().text().trim() ||
            $a.find('img').attr('alt') ||
            $a.attr('title') ||
            ''
        );
        if (!title) return;

        const pic = finalizeImage(normalizeUrl($a.find('img').attr('data-src') || $a.find('img').attr('src')));
        const remarks = pickCardRemarks($a);

        seen.add(href);
        videos.push({
            vod_id: href,
            vod_name: title,
            vod_pic: pic || '',
            vod_remarks: remarks,
        });
    });

    return videos;
};

/**
* 智能检测集数
*/
const getEpisodeCount = ($seasonData, pageHtml) => {
    try {
        // 方法1: 精确容器检测
        const episodeContainer = $seasonData('.jujiepisodios');
        if (episodeContainer.length) {
            const episodeLinks = episodeContainer.find('a');
            const episodeNumbers = [];
            episodeLinks.each((_, el) => {
                const text = $seasonData(el).text().trim();
                if (text) {
                    const num = parseInt(text);
                    if (num >= 1 && num <= 500) {
                        episodeNumbers.push(num);
                    }
                }
            });
            if (episodeNumbers.length > 0) {
                const result = Math.max(...episodeNumbers);
                logInfo("集数检测命中方法1: .jujiepisodios", { count: result, samples: episodeNumbers.slice(0, 10) });
                return result;
            }
            logInfo("集数检测方法1未命中: .jujiepisodios无有效数字");
        }

        // 方法2: JavaScript数据提取
        const videoMatches = pageHtml.match(/video.*?=.*?\[(.*?)\]/gi);
        if (videoMatches) {
            for (const match of videoMatches) {
                const episodeNames = match.match(/"name"\s*:\s*(\d+)/g);
                if (episodeNames && episodeNames.length >= 5) {
                    const numbers = episodeNames.map(m => parseInt(m.match(/\d+/)[0]));
                    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
                    if (sorted[0] === 1 && sorted[sorted.length - 1] - sorted[0] === sorted.length - 1) {
                        const result = Math.max(...sorted);
                        logInfo("集数检测命中方法2: JS数据", { count: result, samples: sorted.slice(0, 10) });
                        return result;
                    }
                }
            }
            logInfo("集数检测方法2未命中: JS数据未形成连续集数");
        }

        // 方法3: 文本模式匹配
        const pageText = $seasonData.text();
        const patterns = [/共(\d+)集/, /全(\d+)集/, /更新至(\d+)集/, /第(\d+)集/];
        for (const pattern of patterns) {
            const matches = pageText.match(pattern);
            if (matches && matches[1]) {
                const result = parseInt(matches[1]);
                logInfo("集数检测命中方法3: 文本模式", { pattern: String(pattern), count: result });
                return result;
            }
        }
        logInfo("集数检测方法3未命中: 文本模式无匹配");

        // 默认值
        const fallbackCount = $seasonData('iframe, video, .player').length ? 24 : 1;
        logInfo("集数检测走默认值", { count: fallbackCount, hasPlayer: $seasonData('iframe, video, .player').length > 0 });
        return fallbackCount;
    } catch (error) {
        logError("检测集数失败", error);
        return 1;
    }
};

/**
* 获取季度集数信息
*/
const getSeasonEpisodes = async ($, detailUrl) => {
    const seasonSources = [];

    try {
        const seasonLinks = $('.seasons-list a, .season-item a, .se-c a, .se-a a, .seasons a');

        let episodeCount = 500;
        const customFields = $(".custom_fields");
        if (customFields.length) {
            const spanText = customFields.last().find("span").last().text().trim();
            const parsed = parseInt(spanText, 10);
            if (!Number.isNaN(parsed) && parsed > 0) {
                episodeCount = parsed;
                OmniBox.log("info", `集数检测命中方法0: .custom_fields span ${episodeCount}`)
            }
        }

        for (let i = 0; i < seasonLinks.length; i++) {
            const $season = seasonLinks.eq(i);
            const seasonTitle = $season.text().trim() || '第1季';
            const seasonUrl = normalizeUrl($season.attr('href'));

            if (!seasonUrl) continue;

            try {
                logInfo(`获取季度信息: ${seasonTitle}，seasonUrl：${seasonUrl}`);
                const seasonResp = await axiosInstance.get(seasonUrl, { headers: config.headers });
                const $seasonData = cheerio.load(seasonResp.data);
                if (seasonLinks.length > 1) {
                    episodeCount = getEpisodeCount($seasonData, seasonResp.data);
                }
                const limitedCount = Math.min(Math.max(episodeCount, 1), episodeCount);

                logInfo(`${seasonTitle} 集数: ${limitedCount}`);

                const episodes = [];
                if (limitedCount === 1) {
                    episodes.push({ name: '第1集', url: seasonUrl });
                } else {
                    for (let epNum = 1; epNum <= limitedCount; epNum++) {
                        const episodeTitle = `第${epNum}集`;
                        const episodeUrl = `${seasonUrl}?ep=${epNum}`;
                        episodes.push({ name: episodeTitle, url: episodeUrl });
                    }
                }

                if (episodes.length > 0) {
                    seasonSources.push({ name: seasonTitle, episodes });
                }
            } catch (error) {
                logError("获取季度失败", error);
                seasonSources.push({ name: seasonTitle, episodes: [{ name: '第1集', url: seasonUrl }] });
            }
        }
    } catch (error) {
        logError("获取季度列表失败", error);
    }

    return seasonSources;
};

/**
* 提取播放选项
*/
const extractPlayOptions = ($, detailUrl) => {
    const playLinks = [];
    const playOptions = $('#playeroptions ul li, .dooplay_player_option');

    playOptions.each((_, element) => {
        const $option = $(element);
        let title = $option.find('.title, span.title').text().trim() || '播放';
        const server = $option.find('.server, span.server').text().trim();

        if (server) {
            title = `${title}-${server}`;
        }

        const dataPost = $option.attr('data-post');
        const dataNume = $option.attr('data-nume');
        const dataType = $option.attr('data-type');

        if (dataPost && dataNume) {
            const playUrl = `${detailUrl}?post=${dataPost}&nume=${dataNume}&type=${dataType || 'movie'}`;
            playLinks.push(`${title}$${playUrl}`);
        }
    });

    return playLinks;
};

/**
* 将播放链接数组转换为 vod_play_sources 格式
* 拼接格式: URL|视频名|集数名
*/
const parsePlaySources = (playLinks, vodName, videoId = "") => {
    if (!playLinks || playLinks.length === 0) {
        return [];
    }
    const episodes = playLinks.map((link, epIndex) => {
        const parts = link.split('$');
        const episodeName = parts[0] || '正片';
        const actualUrl = parts[1] || parts[0];
        const fid = `${videoId}#0#${epIndex}`;
        const combinedId = `${actualUrl}|||${encodeMeta({ sid: String(videoId || ""), fid, d: "", v: vodName || "", e: episodeName })}`;

        return {
            name: episodeName,
            playId: combinedId,
            _fid: fid,
            _rawName: episodeName,
        };
    }).filter(e => e.playId);

    return [{
        name: '4KVM',
        episodes: episodes
    }];
};

const buildSeasonPlaySources = (seasonSources, vodName, videoId = "") => {
    if (!seasonSources || seasonSources.length === 0) {
        return [];
    }
    return seasonSources.map((season, seasonIndex) => {
        const episodes = (season.episodes || []).map((ep, epIndex) => {
            const episodeName = ep.name || '正片';
            const actualUrl = ep.url || '';
            const fid = `${videoId}#${seasonIndex}#${epIndex}`;
            const combinedId = `${actualUrl}|||${encodeMeta({ sid: String(videoId || ""), fid, d: "", v: vodName || "", e: episodeName })}`;
            return {
                name: episodeName,
                playId: combinedId,
                _fid: fid,
                _rawName: episodeName,
            };
        }).filter(e => e.playId);

        return {
            name: season.name || `线路${seasonIndex + 1}`,
            episodes: episodes
        };
    }).filter(source => (source.episodes || []).length > 0);
};

const extractEpisodePlaySources = ($, vodName, videoId = "") => {
    const sourcesMap = new Map();

    $('.episode-link[data-line][data-episode]').each((_, element) => {
        const $el = $(element);
        const line = String($el.attr('data-line') || '1');
        const episodeNo = String($el.attr('data-episode') || '').trim();
        const dataId = String($el.attr('dataid') || '').trim();
        const href = normalizeUrl($el.attr('href') || '');
        const rawName = $el.find('span').last().text().trim() || episodeNo || '播放';
        const episodeName = /^\d+$/.test(rawName) ? `第${rawName}集` : rawName;
        if (!href) return;

        const sourceName = `线路${line}`;
        if (!sourcesMap.has(sourceName)) {
            sourcesMap.set(sourceName, []);
        }

        const fid = dataId || `${videoId}#${line}#${episodeNo || sourcesMap.get(sourceName).length + 1}`;
        // d 是本集的 dataid，play 时喂给 wasm 签名用；secretKey 从 href 末段取
        const combinedId = `${href}|||${encodeMeta({ sid: String(videoId || ""), fid, d: dataId, v: vodName || "", e: episodeName })}`;
        sourcesMap.get(sourceName).push({
            name: episodeName,
            playId: combinedId,
            _fid: fid,
            _rawName: rawName || episodeName,
            _episodeNumber: Number(episodeNo) || undefined,
        });
    });

    const sources = [];
    for (const [name, episodes] of sourcesMap.entries()) {
        episodes.sort((a, b) => Number(a._episodeNumber || 0) - Number(b._episodeNumber || 0));
        sources.push({ name, episodes });
    }
    return sources;
};
/**
* 过滤电视剧内容
*/
const filterTVShowsOnly = (videoList) => {
    const movieKeywords = ['/movies/', '/movie/'];
    const tvshowKeywords = ['/tvshows/', '/tvshow/', '/seasons/'];

    return videoList.filter(video => {
        const vodId = video.vod_id || '';
        const isMovie = movieKeywords.some(keyword => vodId.includes(keyword));
        if (isMovie) return false;

        const isTvshow = tvshowKeywords.some(keyword => vodId.includes(keyword));
        return isTvshow || !isMovie;
    });
};

/**
* 过滤搜索结果
*/
const filterSearchResults = (results, searchKey) => {
    if (!results || !searchKey) return results;

    const searchKeyLower = searchKey.toLowerCase().trim();
    const searchWords = searchKeyLower.split(/\s+/);
    const scoredResults = [];

    for (const result of results) {
        const title = (result.vod_name || '').toLowerCase();
        let score = 0;

        // 计算相关性分数
        if (searchKeyLower === title) {
            score = 100;
        } else if (title.includes(searchKeyLower)) {
            score = 80;
        } else if (title.startsWith(searchKeyLower)) {
            score = 70;
        } else if (searchWords.every(word => title.includes(word))) {
            score = 60;
        } else {
            const wordMatches = searchWords.filter(word => title.includes(word)).length;
            if (wordMatches > 0) {
                score = 30 + (wordMatches * 10);
            } else {
                continue;
            }
        }

        // 内容类型加分
        if (searchKeyLower.includes('剧') && result.vod_id.includes('tvshows')) {
            score += 5;
        } else if (searchKeyLower.includes('电影') && result.vod_id.includes('movies')) {
            score += 5;
        }

        scoredResults.push({ score, result });
    }

    // 排序
    scoredResults.sort((a, b) => b.score - a.score);

    // 过滤低分结果
    const minScore = searchWords.length > 1 ? 30 : 40;
    let filtered = scoredResults.filter(item => item.score >= minScore).map(item => item.result);

    // 如果结果太少,放宽标准
    if (filtered.length < 3 && scoredResults.length > 3) {
        filtered = scoredResults.slice(0, 10).map(item => item.result);
    }

    return filtered;
};

/**
 * 预处理标题，去掉常见干扰项
 */
function preprocessTitle(title) {
    if (!title) return "";
    return title
        .replace(/4[kK]|[xX]26[45]|720[pP]|1080[pP]|2160[pP]|1280x720|1920x1080/g, " ")
        .replace(/[hH]\.?26[45]/g, " ")
        .replace(/BluRay|WEB-DL|HDR|REMUX/gi, " ")
        .replace(/\.mp4|\.mkv|\.avi|\.flv/gi, " ");
}

/**
 * 将中文数字转换为阿拉伯数字 (简单实现)
 */
function chineseToArabic(cn) {
    const map = { '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
    if (!isNaN(cn)) return parseInt(cn);
    if (cn.length === 1) return map[cn] || cn;
    if (cn.length === 2) {
        if (cn[0] === '十') return 10 + map[cn[1]];
        if (cn[1] === '十') return map[cn[0]] * 10;
    }
    if (cn.length === 3) return map[cn[0]] * 10 + map[cn[2]];
    return cn;
}

/**
 * 核心：从标题中提取集数数字
 */
function extractEpisode(title) {
    if (!title) return "";

    const processedTitle = preprocessTitle(title).trim();

    // 1. S01E03 格式
    const seMatch = processedTitle.match(/[Ss](?:\d{1,2})?[-._\s]*[Ee](\d{1,3})/i);
    if (seMatch) return seMatch[1];

    // 2. 中文格式：第XX集/话
    const cnMatch = processedTitle.match(/第\s*([零一二三四五六七八九十0-9]+)\s*[集话章节回期]/);
    if (cnMatch) return String(chineseToArabic(cnMatch[1]));

    // 3. EP/E 格式
    const epMatch = processedTitle.match(/\b(?:EP|E)[-._\s]*(\d{1,3})\b/i);
    if (epMatch) return epMatch[1];

    // 4. 括号格式 [03]
    const bracketMatch = processedTitle.match(/[\[\(【（](\d{1,3})[\]\)】）]/);
    if (bracketMatch) {
        const num = bracketMatch[1];
        // 排除常见分辨率
        if (!["720", "1080", "480"].includes(num)) return num;
    }

    // 5. 独立的数字 (排除常见的视频参数)
    const standaloneMatches = processedTitle.match(/(?:^|[\s\-\._\[\]])(\d{1,3})(?![0-9pP])/g);
    if (standaloneMatches) {
        const candidates = standaloneMatches
            .map(m => m.match(/\d+/)[0])
            .filter(num => {
                const n = parseInt(num);
                return n > 0 && n < 300 && !["720", "480", "264", "265"].includes(num);
            });

        if (candidates.length > 0) {
            // 优先取 1-99 之间的
            const normalEp = candidates.find(n => parseInt(n) < 100);
            return normalEp || candidates[0];
        }
    }

    return "";
}

/**
* 根据播放URL推断文件名(用于弹幕匹配)
*/
function inferFileNameFromURL(url) {
    try {
        const urlObj = new URL(url);
        let base = urlObj.pathname.split("/").pop() || "";

        // 去掉扩展名
        const dotIndex = base.lastIndexOf(".");
        if (dotIndex > 0) {
            base = base.substring(0, dotIndex);
        }

        // 清理分隔符
        base = base.replace(/[_-]/g, " ").replace(/\./g, " ").trim();

        return base || url;
    } catch (error) {
        return url;
    }
}

/**
* 匹配弹幕
*/
async function matchDanmu(fileName) {
    if (!DANMU_API || !fileName) {
        return [];
    }

    try {
        logInfo(`匹配弹幕: ${fileName}`);

        const matchUrl = `${DANMU_API}/api/v2/match`;
        const response = await OmniBox.request(matchUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
            body: JSON.stringify({ fileName: fileName }),
        });

        if (response.statusCode !== 200) {
            logInfo(`弹幕匹配失败: HTTP ${response.statusCode}`);
            return [];
        }

        const matchData = JSON.parse(response.body);

        // 检查是否匹配成功
        if (!matchData.isMatched) {
            logInfo("弹幕未匹配到");
            return [];
        }

        // 获取matches数组
        const matches = matchData.matches || [];
        if (matches.length === 0) {
            return [];
        }

        // 取第一个匹配项
        const firstMatch = matches[0];
        const episodeId = firstMatch.episodeId;
        const animeTitle = firstMatch.animeTitle || "";
        const episodeTitle = firstMatch.episodeTitle || "";

        if (!episodeId) {
            return [];
        }

        // 构建弹幕名称
        let danmakuName = "弹幕";
        if (animeTitle && episodeTitle) {
            danmakuName = `${animeTitle} - ${episodeTitle}`;
        } else if (animeTitle) {
            danmakuName = animeTitle;
        } else if (episodeTitle) {
            danmakuName = episodeTitle;
        }

        // 构建弹幕URL
        const danmakuURL = `${DANMU_API}/api/v2/comment/${episodeId}?format=xml`;

        logInfo(`弹幕匹配成功: ${danmakuName}`);

        return [
            {
                name: danmakuName,
                url: danmakuURL,
            },
        ];
    } catch (error) {
        logInfo(`弹幕匹配失败: ${error.message}`);
        return [];
    }
}

/**
* 构建用于弹幕匹配的文件名
*/
function buildFileNameForDanmu(vodName, episodeTitle) {
    if (!vodName) return "";

    // 如果没有集数信息，直接返回视频名（电影）
    if (!episodeTitle || episodeTitle === '正片' || episodeTitle === '播放') {
        return vodName;
    }

    // 提取集数
    const digits = extractEpisode(episodeTitle);
    if (digits) {
        const epNum = parseInt(digits, 10);
        if (epNum > 0) {
            // 构建标准格式：视频名 S01E01
            if (epNum < 10) {
                return `${vodName} S01E0${epNum}`;
            } else {
                return `${vodName} S01E${epNum}`;
            }
        }
    }

    // 无法提取集数，返回视频名
    return vodName;
}

// ========== 接口实现 ==========

/**
* 首页
*/
async function home(params) {
    logInfo("进入首页");

    try {
        const response = await axiosInstance.get(config.host, { headers: config.headers });
        const $ = cheerio.load(response.data);

        const classes = [];
        const seen = new Set();
        $('nav a.nav-item').each((_, element) => {
            const $el = $(element);
            const rawHref = $el.attr('href') || '';
            const link = normalizeUrl(rawHref);
            const name = $el.text().trim();
            if (!link || !name || ['首页', '影片下载', '片单'].includes(name)) return;
            // 不能写死域名（.org 已换 .net），只看路径
            let navPath = rawHref;
            if (/^https?:\/\//i.test(rawHref)) {
                try { navPath = new URL(rawHref).pathname; } catch (_) { navPath = rawHref; }
            }
            if (!/^\/(movie|tv|anime|filter)/.test(navPath)) return;
            if (seen.has(link)) return;
            seen.add(link);
            classes.push({ type_id: link, type_name: name });
        });

        const homeList = getVideoList($, '.movie-card');

        logInfo(`分类获取完成,共 ${classes.length} 个`);

        return {
            class: classes,
            list: homeList
        };
    } catch (error) {
        logError("首页获取失败", error);
        return {
            class: [
                { 'type_id': `${config.host}/movie`, 'type_name': '电影' },
                { 'type_id': `${config.host}/tv`, 'type_name': '电视剧' },
                { 'type_id': `${config.host}/anime`, 'type_name': '动漫' },
                { 'type_id': `${config.host}/filter`, 'type_name': '筛选' }
            ],
            list: []
        };
    }
}

/**
* 分类
*/
async function category(params) {
    const { categoryId, page } = params;
    const pg = parseInt(page) || 1;
    logInfo(`请求分类: ${categoryId}, 页码: ${pg}`);

    try {
        let url = categoryId;
        if (pg > 1) {
            url = categoryId.includes('?')
                ? `${categoryId}&page=${pg}`
                : `${categoryId}?page=${pg}`;
        }

        const response = await axiosInstance.get(url, { headers: config.headers });
        const $ = cheerio.load(response.data);

        let videoList = getVideoList($, '.movie-card');

        if (categoryId.includes('/tv')) {
            videoList = filterTVShowsOnly(videoList);
        }

        logInfo(`获取到 ${videoList.length} 个视频`);

        return {
            list: videoList,
            page: pg,
            pagecount: videoList.length > 0 ? pg + 1 : pg
        };
    } catch (error) {
        logError("分类请求失败", error);
        return { list: [], page: pg, pagecount: 0 };
    }
}

/**
* 详情
*/
async function detail(params) {
    const videoId = params.videoId;
    logInfo(`请求详情 ID: ${videoId}`);

    try {
        const response = await axiosInstance.get(videoId, { headers: config.headers });
        const $ = cheerio.load(response.data);

        const detailMap = {};
        $('.grid .text-gray-500').each((_, el) => {
            const key = $(el).text().trim();
            const value = $(el).next('div').text().trim();
            if (key && value) detailMap[key] = value;
        });

        const metaDesc = $('meta[name="description"]').attr('content') || '';
        const metaPic = $('meta[property="og:image"]').attr('content') || '';
        const metaKeywords = $('meta[name="keywords"]').attr('content') || '';
        const keywordParts = metaKeywords.split(',').map((s) => s.trim()).filter(Boolean);

        // 顺手把播放要用的站点运行时参数存下来（userlink + wasm 路径），play 时省一次请求
        const navXData = $('nav[x-data]').attr('x-data') || '';
        const userlinkMatched = navXData.match(/userlink\s*:\s*['"]([^'"]+)['"]/);
        if (userlinkMatched) {
            rememberRuntime(
                userlinkMatched[1],
                $('#wasm-cfg').attr('data-js'),
                $('#wasm-cfg').attr('data-bg')
            );
            logInfo("已缓存站点 userlink", { userlink: userlinkMatched[1] });
        }

        const vod = {
            vod_id: videoId,
            vod_name: $('h1.text-xl, h1').first().text().trim() || $('meta[property="og:title"]').attr('content')?.replace(/\s*-\s*第\d+集.*$/, '') || '未知标题',
            // 详情页的 data-poster 是 tmdb 原图（820KB+，国内还连不上），
            // og:image 才是站点自己的竖版海报（300x450，几十 KB），优先用它。
            vod_pic: finalizeImage(normalizeUrl(
                metaPic ||
                $('.video-player').attr('data-poster') ||
                $('.video-player img').attr('src')
            )),
            vod_content: $('.bg-dark-800 p.text-xs.text-gray-300.leading-relaxed').first().text().trim() || metaDesc.trim(),
            vod_year: detailMap['年份'] || '',
            vod_area: detailMap['地区'] || detailMap['国家/地区'] || '',
            vod_remarks: detailMap['状态'] || $('.text-xs.text-gray-500').filter((_, el) => $(el).text().includes('更新')).first().text().trim() || '',
            vod_actor: detailMap['主演'] || '',
            vod_director: detailMap['导演'] || ''
        };

        const genres = [];
        if (detailMap['类型']) genres.push(...detailMap['类型'].split('/').map((s) => s.trim()).filter(Boolean));
        if (genres.length === 0 && keywordParts.length > 1) {
            const maybeType = keywordParts.filter((s) => !/^\d+(\.\d+)?$/.test(s) && s !== vod.vod_name && s !== vod.vod_director);
            if (maybeType.length > 0) genres.push(maybeType[0]);
        }
        if (genres.length > 0) {
            vod.type_name = genres.join(', ');
        }

        logInfo(`视频标题: ${vod.vod_name}`);

        // 获取播放链接：优先使用新前端已渲染好的选集锚点
        let playLinks = extractPlayOptions($, videoId);
        let seasonSources = [];
        const videoIdForScrape = String(videoId || "");
        let playSources = extractEpisodePlaySources($, vod.vod_name, videoIdForScrape);

        // 旧结构兜底
        if (playSources.length === 0) {
            const seasonLinks = $('.seasons-list a, .season-item a, .se-c a, .se-a a, .seasons a');
            if (playLinks.length === 0 && seasonLinks.length > 0) {
                seasonSources = await getSeasonEpisodes($, videoId);
                if (seasonSources.length === 0) {
                    playLinks = [`播放$${videoId}`];
                }
            } else if (playLinks.length === 0) {
                playLinks = [`播放$${videoId}`];
            }

            playSources = seasonSources.length > 0
                ? buildSeasonPlaySources(seasonSources, vod.vod_name, videoIdForScrape)
                : parsePlaySources(playLinks, vod.vod_name, videoIdForScrape);
        }

        let scrapeData = null;
        let videoMappings = [];
        let scrapeType = "";
        const scrapeCandidates = [];

        for (const source of playSources) {
            for (const ep of source.episodes || []) {
                if (!ep._fid) continue;
                scrapeCandidates.push({
                    fid: ep._fid,
                    file_id: ep._fid,
                    file_name: ep._rawName || ep.name || "正片",
                    name: ep._rawName || ep.name || "正片",
                    format_type: "video",
                });
            }
        }

        if (scrapeCandidates.length > 0) {
            try {
                const scrapingResult = await OmniBox.processScraping(videoIdForScrape, vod.vod_name || "", vod.vod_name || "", scrapeCandidates);
                OmniBox.log("info", `[4KVM-DEBUG] 刮削处理完成,结果: ${JSON.stringify(scrapingResult || {}).substring(0, 200)}`);

                const metadata = await OmniBox.getScrapeMetadata(videoIdForScrape);
                scrapeData = metadata?.scrapeData || null;
                videoMappings = metadata?.videoMappings || [];
                scrapeType = metadata?.scrapeType || "";
                logInfo("刮削元数据读取完成", { hasScrapeData: !!scrapeData, mappingCount: videoMappings.length, scrapeType });
            } catch (error) {
                logError("刮削处理失败", error);
            }
        }

        for (const source of playSources) {
            for (const ep of source.episodes || []) {
                const mapping = videoMappings.find((m) => m?.fileId === ep._fid);
                if (!mapping) continue;
                const oldName = ep.name;
                const newName = buildScrapedEpisodeName(scrapeData, mapping, oldName);
                if (newName && newName !== oldName) {
                    ep.name = newName;
                    OmniBox.log("info", `[4KVM-DEBUG] 应用刮削后源文件名: ${oldName} -> ${newName}`);
                }
                ep._seasonNumber = mapping.seasonNumber;
                ep._episodeNumber = mapping.episodeNumber;
            }

            const hasEpisodeNumber = (source.episodes || []).some(
                (ep) => ep._episodeNumber !== undefined && ep._episodeNumber !== null
            );
            if (hasEpisodeNumber) {
                source.episodes.sort((a, b) => {
                    const seasonA = a._seasonNumber || 0;
                    const seasonB = b._seasonNumber || 0;
                    if (seasonA !== seasonB) return seasonA - seasonB;
                    const episodeA = a._episodeNumber || 0;
                    const episodeB = b._episodeNumber || 0;
                    return episodeA - episodeB;
                });
            }
        }

        vod.vod_play_sources = playSources.map((source) => ({
            name: source.name,
            episodes: (source.episodes || []).map((ep) => ({
                name: ep.name,
                playId: ep.playId,
            })),
        }));

        if (scrapeData) {
            vod.vod_name = scrapeData.title || vod.vod_name;
            if (scrapeData.posterPath) {
                // 站点已经有自己的封面就留着（更快、更贴站点）；
                // 只有站点没封面、或封面来自 tmdb 时，才用刮削图（w500 比 original 小得多）。
                const tmdbPoster = `https://image.tmdb.org/t/p/w500${scrapeData.posterPath}`;
                if (!vod.vod_pic || TMDB_IMG_RE.test(vod.vod_pic)) {
                    vod.vod_pic = finalizeImage(tmdbPoster);
                }
            }
            if (scrapeData.overview) {
                vod.vod_content = scrapeData.overview;
            }
            if (scrapeData.releaseDate) {
                vod.vod_year = String(scrapeData.releaseDate).substring(0, 4) || vod.vod_year;
            }
            const actors = (scrapeData.credits?.cast || []).slice(0, 5).map((c) => c?.name).filter(Boolean).join(",");
            if (actors) {
                vod.vod_actor = actors;
            }
            const directors = (scrapeData.credits?.crew || [])
                .filter((c) => c?.job === "Director" || c?.department === "Directing")
                .slice(0, 3)
                .map((c) => c?.name)
                .filter(Boolean)
                .join(",");
            if (directors) {
                vod.vod_director = directors;
            }
        }

        const totalEpisodes = playSources.reduce((sum, source) => sum + (source.episodes || []).length, 0);
        logInfo(`播放线路数: ${playSources.length}, 总集数: ${totalEpisodes}`);

        // 详情页常常没有"状态"字段，用总集数补一个，卡片上至少有个标签
        if (!vod.vod_remarks) {
            vod.vod_remarks = totalEpisodes > 1 ? `全${totalEpisodes}集` : '';
        }

        return {
            list: [vod]
        };
    } catch (error) {
        logError("详情获取失败", error);
        return { list: [] };
    }
}

/**
* 搜索
*/
async function search(params) {
    const wd = params.keyword || params.wd || "";
    const pg = parseInt(params.page) || 1;
    logInfo(`搜索关键词: ${wd}, 页码: ${pg}`);

    try {
        let searchUrl = `${config.host}/search?q=${encodeURIComponent(wd)}`;
        if (pg > 1) {
            searchUrl += `&page=${pg}`;
        }

        const response = await axiosInstance.get(searchUrl, { headers: config.headers });
        const $ = cheerio.load(response.data);

        const rawResults = getSearchVideoList($);
        const filteredResults = filterSearchResults(rawResults, wd);

        logInfo(`搜索到 ${filteredResults.length} 个结果`);

        return {
            list: filteredResults,
            page: pg,
            pagecount: filteredResults.length > 0 ? pg + 1 : pg
        };
    } catch (error) {
        logError("搜索失败", error);
        return { list: [], page: pg, pagecount: 0 };
    }
}

/**
* 播放
*/
async function play(params) {
    let playId = params.playId;
    const flag = params.flag || "";
    logInfo(`准备播放 ID: ${playId}, flag: ${flag}`);

    let vodName = "";
    let episodeName = "";
    let playMeta = {};

    // 关键修改：解析透传参数
    if (playId && playId.includes("|||")) {
        const [mainPlayId, metaB64] = playId.split("|||");
        playId = mainPlayId;
        playMeta = decodeMeta(metaB64 || "");
        vodName = playMeta.v || "";
        episodeName = playMeta.e || "";
        logInfo(`解析透传信息 - 视频: ${vodName}, 集数: ${episodeName}`);
    } else if (playId && playId.includes('|')) {
        // 兼容旧格式
        const parts = playId.split('|');
        playId = parts[0];      // 真正的 URL
        vodName = parts[1] || "";
        episodeName = parts[2] || "";
        logInfo(`解析透传信息 - 视频: ${vodName}, 集数: ${episodeName}`);
    }

    let scrapedDanmuFileName = "";
    try {
        const videoIdFromParam = params.vodId ? String(params.vodId) : "";
        const videoIdFromMeta = playMeta?.sid ? String(playMeta.sid) : "";
        const videoIdForScrape = videoIdFromParam || videoIdFromMeta;
        if (videoIdForScrape) {
            const metadata = await OmniBox.getScrapeMetadata(videoIdForScrape);
            if (metadata && metadata.scrapeData) {
                const mapping = (metadata.videoMappings || []).find((m) => m?.fileId === playMeta?.fid);
                scrapedDanmuFileName = buildScrapedDanmuFileName(
                    metadata.scrapeData,
                    metadata.scrapeType || "",
                    mapping,
                    vodName,
                    episodeName
                );
                if (metadata.scrapeData.title) {
                    vodName = metadata.scrapeData.title;
                }
                if (mapping?.episodeName) {
                    episodeName = mapping.episodeName;
                }
            }
        }
    } catch (error) {
        logInfo(`读取刮削元数据失败: ${error.message}`);
    }

    try {
        // ① 首选：wasm 签名直取。站点播放页靠 build_play_url 算签名接口，
        //    在 Node 里跑同一个 wasm 就能直接拿到 m3u8，不必开无头浏览器（9s → 0.3s）。
        let fastResponse = null;
        const secretKey = (String(playId || "").match(/\/play\/([^/?#]+)/) || [])[1] || "";
        const dataId = playMeta && playMeta.d ? String(playMeta.d) : "";
        if (secretKey && dataId) {
            try {
                fastResponse = await resolveViaWasm(dataId, secretKey, playId);
                if (fastResponse) {
                    logInfo(`直取命中: ${fastResponse.urls[0].url}`);
                } else {
                    logInfo("直取没有可用线路，回退嗅探");
                }
            } catch (error) {
                logInfo(`直取失败，回退嗅探: ${error.message}`);
            }
        } else {
            logInfo("缺少 dataid 或 secretKey，跳过直取", { secretKey, dataId });
        }

        // 解析参数
        let dataPost = null;
        let dataNume = null;
        let dataType = null;
        let baseUrl = playId;

        if (playId.includes('?')) {
            const [url, queryParams] = playId.split('?', 2);
            baseUrl = url;
            const paramPairs = queryParams.split('&');
            for (const pair of paramPairs) {
                const [key, value] = pair.split('=');
                if (key === 'post') dataPost = value;
                if (key === 'nume') dataNume = value;
                if (key === 'type') dataType = value;
            }
        }

        let playResponse = fastResponse || {
            urls: [{ name: "4KVM", url: playId }],
            parse: 1,
            header: PLAY_HEADERS
        };

        // API调用
        if (!fastResponse && dataPost && dataNume) {
            try {
                const apiUrl = `${config.host}/wp-json/dooplayer/v1/post/${dataPost}`;
                const apiResponse = await axiosInstance.get(apiUrl, {
                    headers: config.headers,
                    params: {
                        type: dataType || 'movie',
                        source: dataNume
                    }
                });

                if (apiResponse.status === 200 && apiResponse.data.embed_url) {
                    const embedUrl = apiResponse.data.embed_url;
                    const parseFlag = ['.m3u8', '.mp4', '.flv', '.avi'].some(ext =>
                        embedUrl.toLowerCase().includes(ext)
                    ) ? 0 : 1;

                    logInfo(`API解析成功: ${embedUrl}`);
                    playResponse.urls = [{ name: "4KVM", url: embedUrl }];
                    playResponse.parse = parseFlag;
                }
            } catch (error) {
                logError("API调用失败", error);
            }
        }

        // 如果API调用失败，页面解析回退
        if (playResponse.urls[0].url === playId) {
            const response = await axiosInstance.get(baseUrl, { headers: config.headers });
            const $ = cheerio.load(response.data);

            // 查找iframe
            const iframe = $('iframe.metaframe, .dooplay_player iframe, .player iframe').first().attr('src');
            if (iframe) {
                const iframeUrl = normalizeUrl(iframe);
                const parseFlag = ['.m3u8', '.mp4', '.flv'].some(ext =>
                    iframeUrl.toLowerCase().includes(ext)
                ) ? 0 : 1;

                logInfo(`Iframe解析: ${iframeUrl}`);
                playResponse.urls = [{ name: "4KVM", url: iframeUrl }];
                playResponse.parse = parseFlag;
            } else {
                // 查找video标签
                const videoSrc = normalizeUrl($('video source, video').first().attr('src'));
                if (videoSrc) {
                    logInfo(`Video标签解析: ${videoSrc}`);
                    playResponse.urls = [{ name: "4KVM", url: videoSrc }];
                    playResponse.parse = 0;
                }
            }
        }

        if (playResponse.urls[0]?.url && !playResponse.urls[0]?.url.match(/\.(m3u8|mp4|flv|avi|mkv|ts)/i)) {
            const sniffResult = await sniff4kvmPlay(playResponse.urls[0].url);
            if (sniffResult) {
                playResponse = sniffResult;
            }
        }

        OmniBox.log("info", `使用默认播放：${playId}`);

        OmniBox.log("info", `DANMU_API: ${DANMU_API}, params.vodName：${params.vodName}`);

        // 弹幕匹配
        if (DANMU_API && (vodName || params.vodName)) {
            const finalVodName = vodName || params.vodName;
            const finalEpisodeName = episodeName || params.episodeName || '';

            const fileName = scrapedDanmuFileName || buildFileNameForDanmu(finalVodName, finalEpisodeName);
            logInfo(`尝试匹配弹幕文件名: ${fileName}`);

            if (fileName) {
                const danmakuList = await matchDanmu(fileName);
                if (danmakuList && danmakuList.length > 0) {
                    playResponse.danmaku = danmakuList;
                }
            }
        }

        return playResponse;
    } catch (error) {
        logError("播放解析失败", error);
        const fallbackSniff = await sniff4kvmPlay(playId);
        if (fallbackSniff) {
            return fallbackSniff;
        }
        return {
            urls: [{ name: "4KVM", url: playId }],
            parse: 1,
            header: PLAY_HEADERS
        };
    }
}

module.exports = { home, category, search, detail, play };

const runner = require("spider_runner");
runner.run(module.exports);
