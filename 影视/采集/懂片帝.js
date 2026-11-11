// @name 懂片帝
// @author tardlk
// @description 懂片帝首页、分类、搜索、分季分集及多线路播放；含游客可用的官方4K线路，不接入成人专区
// @version 1.0.1
// @dependencies axios,cheerio
// @downloadURL https://gh-proxy.org/https://github.com/tardlk/OmniBox-Spider/raw/refs/heads/main/影视/采集/懂片帝.js

const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
let OmniBox, runner;
try { OmniBox = require('omnibox_sdk'); } catch (_) { OmniBox = { log: (l,m) => console.error(`[${l}] ${m}`) }; }
try { runner = require('spider_runner'); } catch (_) { runner = { run() {} }; }

const SITE = (process.env.DONGPIAN_HOST || 'https://dongpian24.com').replace(/\/$/, '');
const ORIGIN = new URL(SITE).origin;
const COOKIE = String(process.env.DONGPIAN_COOKIE || '').trim();
const TICKETS = process.env.DONGPIAN_TICKET_LINES !== '0';
const TIMEOUT = 15000;
const PAGE_SIZE = 20;
const CATEGORIES = { movie: '电影', series: '电视剧', short_drama: '短剧', anime: '动漫', variety: '综艺', documentary: '纪录片', sports: '体育' };
const ADULT = /成人|色情|情色|伦理|倫理|三级|三級|里番|裏番|写真|寫真|无码|無碼|福利|擦边|擦邊|两性课堂|理論片|理论片|18\+|🔞/i;
const signatureMemory = new Map();
const sessionMemory = new Map();
const digest = x => crypto.createHash('sha256').update(String(x)).digest('hex');
const pack = (p, x) => p + Buffer.from(JSON.stringify(x)).toString('base64url');
function unpack(p, id) {
  if (!String(id || '').startsWith(p) || id.length > 12000) throw new Error('无效资源标识');
  return JSON.parse(Buffer.from(id.slice(p.length), 'base64url').toString());
}
function validId(id) {
  if (typeof id !== 'string' || !/^(?:av_[\w-]+|variant:[\w:-]+)$/.test(id) || id.length > 1024) throw new Error('无效站点ID');
  return id;
}
function pageOf(p) { return Math.max(1, Math.min(10000, Math.floor(Number(p) || 1))); }
function empty(page = 1) { return { page, pagecount: page, total: 0, list: [] }; }
function text(v) { return cheerio.load(String(v ?? '')).text().trim(); }
function array(v) { return Array.isArray(v) ? v : []; }
function http(raw, base = SITE) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try { const u = new URL(raw, base); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch (_) { return ''; }
}
async function log(method, message, level = 'info') { try { await OmniBox.log(level, `[懂片帝][${method}] ${message}`); } catch (_) {} }
function clean(v) {
  return v && !v.is_adult && !v.isAdult && v.content_kind !== 'adult'
    && !ADULT.test([v.title, v.label, v.content_kind, ...array(v.genres)].join(' '));
}
async function readCache(key) { try { return await OmniBox.getCache?.(key); } catch (_) { return null; } }
async function writeCache(key, value, ttl, context) {
  if (context.prefetch || Buffer.byteLength(JSON.stringify(value)) > 480 * 1024) return;
  try { await OmniBox.setCache?.(key, value, ttl); } catch (_) {}
}
function cacheKey(url) { return `dongpian:v100:${digest(ORIGIN + url)}`; }
async function raw(url, options = {}) {
  const r = await axios({ url, timeout: TIMEOUT, maxContentLength: 8 * 1024 * 1024, validateStatus: () => true,
    headers: { 'User-Agent': 'Mozilla/5.0', ...options.headers }, ...options,
    transformResponse: [x => x] });
  return { status: r.status, headers: r.headers || {}, body: typeof r.data === 'string' ? r.data : JSON.stringify(r.data) };
}
async function signatureConfig(context) {
  const key = cacheKey('signature'), memory = signatureMemory.get(ORIGIN), cached = memory || await readCache(key);
  if (cached?.key && cached.expires > Date.now()) return cached;
  const home = await raw(SITE + '/');
  if (home.status !== 200) throw new Error(`站点首页 HTTP ${home.status}`);
  const $ = cheerio.load(home.body);
  const assets = $('script[src],link[rel="modulepreload"]').map((_, el) => $(el).attr('src') || $(el).attr('href')).get();
  let runtime = assets.find(a => /\/movie-card-runtime-[\w-]+\.js/.test(a));
  if (!runtime) {
    const main = assets.find(a => /\/main-[\w-]+\.js/.test(a));
    if (!main) throw new Error('站点入口脚本已变更');
    const entry = await raw(new URL(main, SITE).href);
    runtime = entry.body.match(/(?:\.\/|assets\/)(movie-card-runtime-[\w-]+\.js)/)?.[1];
    if (runtime) runtime = '/assets/' + runtime;
  }
  const runtimeURL = runtime && new URL(runtime, SITE);
  if (!runtimeURL || runtimeURL.origin !== ORIGIN) throw new Error('未找到站点签名配置');
  // 仅读取公开前端的配置，不执行站点 JavaScript。
  const script = await raw(runtimeURL.href);
  const signing = script.body.match(/"x-ai-movie-signature"[^;]{0,240}?"([a-f\d]{64})"\.trim/);
  if (!signing) throw new Error('站点请求签名格式已变更');
  const config = { key: signing[1], build: script.body.match(/"(dongpiandi-v[^"\s]+)"/)?.[1] || '',
    protocol: script.body.match(/"(\d{4}-\d{2}-\d{2}\.library-v\d+\.playback-v\d+)"/)?.[1] || '', expires: Date.now() + 3600000 };
  if (!context.prefetch) signatureMemory.set(ORIGIN, config);
  await writeCache(key, config, 3600, context);
  return config;
}
function sessionKey(context) { return digest(`${ORIGIN}:${context.sourceId || 'local'}`); }
function sessionPath(context) { return path.join(os.tmpdir(), 'omnibox-dongpian', sessionKey(context) + '.json'); }
function readSession(context) {
  if (COOKIE) return { cookie: COOKIE, expires: Infinity };
  const memory = sessionMemory.get(sessionKey(context));
  if (memory) return memory;
  try {
    const file = sessionPath(context), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return {}; }
}
function saveSession(value, context) {
  if (context.prefetch || COOKIE) return;
  sessionMemory.set(sessionKey(context), value);
  // Cookie 不写公开 SDK 缓存、日志、播放ID。跨 runner 进程仅通过私有临时文件复用。
  const file = sessionPath(context), dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('会话目录权限异常');
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); } finally { fs.closeSync(fd); }
  } catch (_) { log('会话', '无法持久保存游客会话；跨进程使用时可配置 DONGPIAN_COOKIE', 'error'); }
}
function signedHeaders(config, method, url, cookie = '') {
  const u = new URL(url), timestamp = String(Date.now()), nonce = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', config.key).update(`${method}\n${u.pathname}${u.search}\n${timestamp}\n${nonce}`).digest('hex');
  return { Accept: 'application/json', 'Content-Type': 'application/json', Origin: ORIGIN, Referer: SITE + '/',
    'User-Agent': 'Mozilla/5.0', 'x-ai-movie-client-name': 'movie-search-frontend', 'x-ai-movie-client-version': '1.0.0',
    'x-ai-movie-build-version': config.build, 'x-ai-movie-protocol-version': config.protocol,
    'x-ai-movie-timestamp': timestamp, 'x-ai-movie-nonce': nonce, 'x-ai-movie-signature': signature,
    ...(cookie ? { Cookie: cookie } : {}) };
}
async function ensureSession(context, config, allowCreate) {
  const previous = readSession(context);
  if (previous.cookie && previous.expires > Date.now() + 30000) return previous.cookie;
  if (!allowCreate || context.prefetch) throw new Error('游客会话未就绪，请先打开首页或配置 DONGPIAN_COOKIE');
  const anonymousId = previous.anonymousId || 'web_' + crypto.randomUUID();
  const url = SITE + '/v1/users/anonymous';
  const r = await raw(url, { method: 'POST', headers: signedHeaders(config, 'POST', url), data: JSON.stringify({ anonymous_id: anonymousId }) });
  if (r.status !== 200 && r.status !== 201) throw new Error(`游客初始化 HTTP ${r.status}`);
  const data = JSON.parse(r.body), setCookie = r.headers['set-cookie'];
  const cookies = array(typeof setCookie === 'string' ? [setCookie] : setCookie).map(c => c.split(';')[0]).filter(c => /^ai_movie_session=/.test(c));
  if (!cookies.length) throw new Error('站点未返回游客会话');
  const expires = Date.parse(data.expires_at);
  saveSession({ anonymousId, cookie: cookies.join('; '), expires: Number.isFinite(expires) ? expires : Date.now() + 3600000 }, context);
  await log('会话', '游客初始化成功');
  return cookies.join('; ');
}
async function api(route, params, context, { ttl = 0, allowCreate = true, method = 'GET', body } = {}) {
  if (!route.startsWith('/v1/') || /midnight|adult-access/.test(route)) throw new Error('不支持的接口');
  const url = new URL(route, SITE);
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') url.searchParams.set(k, String(v));
  const key = cacheKey(url.pathname + url.search);
  if (ttl && !COOKIE) { const data = await readCache(key); if (data) { await log('请求', `${route.split('/').slice(0,3).join('/')} 缓存命中`); return data; } }
  const config = await signatureConfig(context);
  let cookie = await ensureSession(context, config, allowCreate);
  await log('请求', `${method} ${route.split('/').slice(0,3).join('/')} ${params?.page ? 'page=' + params.page : ''}`);
  let r = await raw(url.href, { method, headers: signedHeaders(config, method, url, cookie), ...(body ? { data: JSON.stringify(body) } : {}) });
  let data;
  try { data = JSON.parse(r.body); } catch (_) { throw new Error(`API 返回非 JSON，HTTP ${r.status}`); }
  if (r.status === 401 && !COOKIE && allowCreate && !context.prefetch && data.error?.code !== 'invalid_request_signature') {
    const old = readSession(context); saveSession({ ...old, cookie: '', expires: 0 }, context);
    cookie = await ensureSession(context, config, true);
    r = await raw(url.href, { method, headers: signedHeaders(config, method, url, cookie), ...(body ? { data: JSON.stringify(body) } : {}) });
    data = JSON.parse(r.body);
  }
  if (r.status < 200 || r.status >= 300 || data.error) {
    const code = data.error?.code || `http_${r.status}`;
    if (code === 'invalid_request_signature' && !context.prefetch) {
      signatureMemory.delete(ORIGIN);
      try { await OmniBox.deleteCache?.(cacheKey('signature')); } catch (_) {}
    }
    throw new Error(`站点请求失败 HTTP ${r.status} (${code})`);
  }
  if (ttl && !COOKIE) await writeCache(key, data, ttl, context);
  return data;
}
function cover(url, context) {
  const image = http(url);
  return image && http(context.baseURL) ? `${context.baseURL.replace(/\/$/, '')}/api/proxy/image?url=${encodeURIComponent(image)}` : image;
}
function mapVod(card, context) {
  return { vod_id: validId(card.selected_variant_id || card.variant_id || card.id), vod_name: text(card.title),
    vod_pic: cover(card.poster_url, context), vod_content: text(card.description || card.overview),
    vod_remarks: text(card.episode_progress_text || card.remarks), vod_year: String(card.year || ''), vod_area: text(card.area),
    vod_actor: array(card.actors).map(a => text(a.name || a)).join(' / '), vod_director: array(card.directors).map(a => text(a.name || a)).join(' / '),
    type_name: CATEGORIES[card.content_kind] || '', vod_douban_score: String(card.rating?.value || card.rating || '') };
}
function cardsOf(cards, context) {
  const unique = new Map();
  for (const card of array(cards)) if (clean(card)) {
    // 将同一作品的各季展开成可选择条目，不丢失默认季以外的入口。
    const seasons = array(card.seasons).filter(s => s.has_playback !== false && s.variant_id && clean(s));
    const rows = seasons.length > 1 ? seasons.map(s => ({ ...card, ...s, id: s.variant_id, selected_variant_id: s.variant_id })) : [card];
    for (const row of rows) { try { const item = mapVod(row, context); if (item.vod_name) unique.set(item.vod_id, item); } catch (_) {} }
  }
  return [...unique.values()];
}
function pageResult(data, page, context) {
  if (!Array.isArray(data.cards)) throw new Error('影片列表格式已变更');
  const list = cardsOf(data.cards, context), more = data.pagination?.has_more === true;
  return { page, pagecount: more ? page + 1 : page, total: data.pagination?.total || list.length, list };
}
async function home(_params, context) {
  const data = await api('/v1/feed/home', { scope: 'public', mode: 'preview', sections: 3, cards: 10 }, context, { ttl: 120 });
  if (!Array.isArray(data.sections)) throw new Error('首页数据格式已变更');
  return { class: Object.entries(CATEGORIES).map(([type_id,type_name]) => ({ type_id,type_name })),
    list: cardsOf(data.sections.filter(clean).flatMap(s => array(s.cards)), context) };
}
async function category(params, context) {
  const page = pageOf(params.page), kind = params.categoryId;
  if (!Object.hasOwn(CATEGORIES, kind)) return empty(page);
  return pageResult(await api('/v1/browse/catalog', { intent: 'latest_catalog', kind, page, limit: PAGE_SIZE }, context, { ttl: 60 }), page, context);
}
async function search(params, context) {
  const page = pageOf(params.page), q = String(params.keyword || '').trim();
  if (!q || ADULT.test(q)) return empty(page);
  return pageResult(await api('/v1/browse/catalog', { q, page, limit: PAGE_SIZE }, context, { ttl: 60 }), page, context);
}
async function catalog(id, context, allowCreate = true) {
  validId(id);
  const data = await api('/v1/catalog/' + encodeURIComponent(id), {}, context, { ttl: 120, allowCreate });
  if (data.object !== 'catalog.detail' || !clean(data) || (data.id !== id && data.variant_id !== id)) throw new Error('影片不存在或属于排除内容');
  return data;
}
async function allEpisodes(data, context, allowCreate = true) {
  let episodes = array(data.episodes), pagination = data.episode_pagination;
  const id = data.variant_id || data.id;
  while (pagination?.has_more) {
    const offset = Number(pagination.offset || 0) + Number(pagination.returned_count ?? episodes.length);
    if (!Number.isSafeInteger(offset) || offset <= Number(pagination.offset || 0) || offset > 10000) throw new Error('分集分页异常');
    const next = await api('/v1/catalog/' + encodeURIComponent(id) + '/episodes', { offset, limit: 100 }, context, { ttl: 120, allowCreate });
    if (next.variant_id !== id || !Array.isArray(next.episodes) || Number(next.episode_pagination?.offset) !== offset) throw new Error('分集分页返回异常');
    episodes = episodes.concat(next.episodes); pagination = next.episode_pagination;
  }
  return [...new Map(episodes.filter(e => e.id && e.token).map(e => [e.id,e])).values()];
}
function lineAllowed(line) {
  if (!clean(line) || !line.playback_source_id) return false;
  if (line.url_kind === 'resolve_ticket' || String(line.url).startsWith('resolve://')) return TICKETS;
  return !!http(line.url);
}
async function resolve(token, line, context, allowCreate = true) {
  validId(token);
  const data = await api('/v1/playback/resolve/' + encodeURIComponent(token), { ...(line ? { line } : {}), view: 'compact' }, context, { allowCreate });
  if (data.is_adult || !Array.isArray(data.line_options)) throw new Error('播放线路格式已变更或属于成人内容');
  return { ...data, line_options: data.line_options.map(l => ({ ...l, playback_source_id: l.playback_source_id || l.id })) };
}
function episodeId(v, e) { return `${v}:${e.id}`; }
async function detail(params, context) {
  const data = await catalog(params.videoId, context), episodes = await allEpisodes(data, context), item = mapVod(data, context);
  if (!episodes.length) return { list: [{ ...item, vod_play_sources: [] }] };
  const playback = await resolve(episodes[0].token, '', context);
  const lines = playback.line_options.filter(lineAllowed), unique = new Map(lines.map(l => [l.playback_source_id,l]));
  item.vod_play_sources = [...unique.values()].map(line => ({ name: line.display_label || line.label || line.play_from || '播放线路',
    episodes: episodes.map(e => ({ name: text(e.title || e.display_name) || `第${e.number || 1}集`,
      playId: pack('dpp1_', { v: item.vod_id, e: e.id, l: line.playback_source_id }) })) }));
  await log('detail', `分集=${episodes.length} 可用线路=${item.vod_play_sources.length} 解析线路开关=${TICKETS}`);
  if (!context.prefetch && process.env.ENABLE_SCRAPE !== '0' && item.vod_play_sources.length && OmniBox.processScraping) {
    try {
      await OmniBox.processScraping(item.vod_id, item.vod_name, item.vod_name, episodes.map(e => ({ file_id: episodeId(item.vod_id,e), file_name: `${item.vod_name} ${e.title || e.number}` })));
      const meta = await OmniBox.getScrapeMetadata?.(item.vod_id), mappings = new Map(array(meta?.videoMappings).map(m => [m.fileId,m]));
      for (const line of item.vod_play_sources) for (const e of line.episodes) { const id = unpack('dpp1_',e.playId), m = mappings.get(`${id.v}:${id.e}`); if (m?.episodeName) e.name = m.episodeName; }
    } catch (e) { await log('刮削', e.message, 'error'); }
  }
  return { list: [item] };
}
function mediaHeaders(headers) {
  return Object.fromEntries(Object.entries(headers || {}).filter(([k,v]) => /^(user-agent|referer|origin|range)$/i.test(k) && typeof v === 'string'));
}
async function play(params, context) {
  const id = unpack('dpp1_', params.playId), data = await catalog(id.v, context, false);
  validId(id.e);
  const known = array(data.episodes).find(e => e.id === id.e);
  const episodes = known ? [known] : await allEpisodes(data, context, false), ep = episodes.find(e => e.id === id.e);
  if (!ep) throw new Error('分集不存在');
  const playback = await resolve(ep.token, id.l, context, false);
  let line = playback.line_options.find(l => l.playback_source_id === id.l && lineAllowed(l));
  if (!line) throw new Error('所选线路不可用，请切换其他线路');
  if (line.url_kind === 'resolve_ticket' || String(line.url).startsWith('resolve://')) {
    if (context.prefetch) throw new Error('预热跳过需要额外解析的线路');
    const ticket = line.resolve_ticket || String(line.url).replace(/^resolve:\/\//,'');
    const resolved = await api('/v1/playback/resolve-line', { view: 'compact' }, context, { allowCreate: false, method: 'POST', body: { ticket } });
    line = resolved.line;
    if (!line || line.url_kind === 'resolve_ticket') throw new Error('站点未返回解析地址');
  }
  const url = http(line.url);
  if (!url) throw new Error('站点未返回有效媒体地址');
  const header = mediaHeaders(line.headers || line.header);
  if (/douyinvod|byteimg|ixigua/.test(new URL(url).hostname)) { delete header.Referer; delete header.referer; delete header.Origin; delete header.origin; }
  const main = async () => {
    if (/m3u8|hls|mp4|media/.test(line.url_kind || '') || /\.(m3u8|mp4|mkv|flv|mpd)(?:[?#]|$)/i.test(url)) return { urls: [{ name: line.label || params.flag || '播放', url }], flag: params.flag || line.label || '', header, parse: 0 };
    try { const r = await OmniBox.sniffVideo?.(url, header); if (http(r?.url)) return { urls: [{ name: '嗅探', url: r.url }], flag: params.flag || '', header: r.header || header, parse: 0 }; } catch (_) {}
    return { urls: [{ name: '网页播放', url }], flag: params.flag || '', header, parse: 1 };
  };
  const danmaku = async () => {
    if (!OmniBox.getDanmakuByFileName) return [];
    const meta = await OmniBox.getScrapeMetadata?.(id.v), mapping = array(meta?.videoMappings).find(m => m.fileId === episodeId(id.v,ep));
    return await OmniBox.getDanmakuByFileName(`${data.title} ${mapping?.episodeName || ep.title || ''}`) || [];
  };
  const [result, dm] = await Promise.allSettled([main(), danmaku()]);
  if (result.status !== 'fulfilled') throw result.reason;
  return { ...result.value, danmaku: dm.status === 'fulfilled' ? dm.value : [] };
}
function wrap(name, fn) {
  return async (params = {}, context = {}) => {
    await log(name, `开始${params.page ? ' page=' + params.page : ''}`);
    try { const result = await fn(params, context); await log(name, `完成 结果=${result.list?.length ?? result.urls?.length ?? 0}`); return result; }
    catch (e) { await log(name, e.message, 'error'); return name === 'home' ? { class: [], list: [] } : name === 'detail' ? { list: [] } : name === 'play' ? { urls: [], flag: params.flag || '', parse: 0 } : empty(pageOf(params.page)); }
  };
}
module.exports = Object.fromEntries(Object.entries({ home, category, search, detail, play }).map(([name, fn]) => [name, wrap(name,fn)]));
runner.run(module.exports);
