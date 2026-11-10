// @name Gimy剧迷
// @author 梦
// @description 影视站：Gimy / gimyai.tw（MacCMS v10 新版模板），首页、分类筛选、AJAX 搜索、多线路播放
// @dependencies cheerio,opencc-js
// @version 2.1.0
// @downloadURL https://gh-proxy.org/https://github.com/tardlk/OmniBox-Spider/raw/refs/heads/main/影视/采集/Gimy剧迷.js

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");
const cheerio = require("cheerio");

// ==================== 配置开始 ====================
// ⚠️ Cloudflare：站点（gimyai.tw / aigm.tv / gmtv.app）对人机验证要求很高，
// 脚本的裸请求会直接拿到 403 + 「Just a moment...」。若浏览器能正常打开站点，
// 把浏览器里的 Cookie 粘到下面（或设环境变量 GIMY_COOKIE），脚本就能带上它请求。
//
// 取法（Edge/Chrome）：
//   1. 打开 https://gimyai.tw/ ，等页面完全正常显示（不再显示「請稍候...」）
//   2. F12 → Application（应用）→ Cookies → https://gimyai.tw
//   3. 至少复制 cf_clearance 的值；保险起见把整条 Cookie 串都复制过来
//   4. 粘贴到 CF_COOKIE，形如：cf_clearance=xxxx; __cf_bm=yyyy;
//   5. 如果站点识别 UA，把浏览器的 UA 整串贴到 CF_UA（留空则用内置 UA）
//
// 注意：cf_clearance 与「出口 IP + User-Agent」绑定，一般 30 分钟~几小时过期。
//   只有 OmniBox 和浏览器走同一个出口 IP 时才能复用；过期后重新复制一次即可。
const CF_COOKIE = String(process.env.GIMY_COOKIE || "").trim();
const CF_UA = String(process.env.GIMY_UA || "").trim();

// 是否禁用 OpenCC 等外部繁简转换库；环境变量 GIMY_DISABLE_OPENCC=1 时仅使用内置兜底映射。
const DISABLE_OPENCC = String(process.env.GIMY_DISABLE_OPENCC || "").trim() === "1";

// 播放线路排序环境配置；优先读取 GIMY_PLAY_SOURCE_ORDER，GIMY_SOURCE_ORDER 作为兼容别名。
const PLAY_SOURCE_ORDER_CONFIG = String(process.env.GIMY_PLAY_SOURCE_ORDER || process.env.GIMY_SOURCE_ORDER || "").trim();

// 站点基础地址，用于补全相对链接和发起默认请求。
const BASE_URL = "https://gimyai.tw";

// 请求使用的 User-Agent，避免站点返回移动端或拦截页面。
// 带 cf_clearance 时必须与浏览器一致，否则一样 403。
const UA = CF_UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0";

// 未设置播放线路排序环境变量时的默认优先线路，未命中的线路保持站点原始顺序。
const DEFAULT_PLAY_SOURCE_ORDER = ["4K画质线路 ᴴᴰ", "超清线路 ᴴᴰ"];
// ==================== 配置结束 ====================

let simplifyConverter = null;
let simplifyConverterName = "fallback-map";
let simplifyConverterChecked = false;

module.exports = { home, category, detail, search, play };
runner.run(module.exports);

function getBodyText(res) {
  const body = res && typeof res === "object" && "body" in res ? res.body : res;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return body.toString();
  return String(body || "");
}

function isCloudflareChallenge(text) {
  const html = String(text || "");
  return /Just a moment|cf-mitigated|cf_chl_opt|challenge-platform|請稍候|请稍候|Attention Required/i.test(html);
}

function cfError(url) {
  const err = new Error(
    CF_COOKIE
      ? `Cloudflare 人机验证未通过(HTTP 403) @ ${url} —— CF_COOKIE 可能已过期或与当前出口 IP/UA 不匹配`
      : `Cloudflare 人机验证(HTTP 403) @ ${url} —— 请在脚本顶部 CF_COOKIE 填入浏览器 Cookie`
  );
  err.cfChallenge = true;
  return err;
}

async function requestText(url, options = {}) {
  const headers = {
    "User-Agent": UA,
    "Accept-Language": "zh-TW,zh;q=0.9,zh-CN;q=0.8,en;q=0.7",
    Accept: options.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Upgrade-Insecure-Requests": "1",
    "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24", "Microsoft Edge";v="146"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Dest": options.fetchDest || "document",
    "Sec-Fetch-Mode": options.fetchMode || "navigate",
    "Sec-Fetch-Site": options.fetchSite || "same-origin",
    Referer: options.referer || `${BASE_URL}/`,
    ...(options.headers || {}),
  };
  if (CF_COOKIE) headers.Cookie = CF_COOKIE;

  await OmniBox.log("info", `[Gimy剧迷][request] ${options.method || "GET"} ${url}${CF_COOKIE ? " (with cookie)" : ""}`);
  const res = await OmniBox.request(url, {
    method: options.method || "GET",
    headers,
    body: options.body,
    timeout: options.timeout || 20000,
  });
  const statusCode = Number(res?.statusCode || 0);
  const text = getBodyText(res);
  if (!res || statusCode !== 200) {
    if ((statusCode === 403 || statusCode === 503) && isCloudflareChallenge(text)) throw cfError(url);
    throw new Error(`HTTP ${res?.statusCode || "unknown"} @ ${url}`);
  }
  if (isCloudflareChallenge(text) && text.length < 20000) throw cfError(url);
  return text;
}

function absUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `${BASE_URL}${value}`;
  return `${BASE_URL}/${value.replace(/^\.\//, "")}`;
}

function normalizeText(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}

function fallbackTraditionalToSimplified(value) {
  const map = {
    "鬥": "斗", "羅": "罗", "陸": "陆", "龍": "龙", "傳": "传", "說": "说", "絕": "绝", "劍": "剑", "塵": "尘",
    "動": "动", "態": "态", "畫": "画", "劇": "剧", "場": "场", "國": "国", "產": "产", "綜": "综", "藝": "艺",
    "電": "电", "視": "视", "連": "连", "續": "续", "線": "线", "萬": "万", "與": "与", "風": "风", "雲": "云",
    "後": "后", "開": "开", "關": "关", "門": "门", "書": "书", "貓": "猫", "馬": "马", "魚": "鱼", "鳥": "鸟",
    "來": "来", "時": "时", "會": "会", "愛": "爱", "戰": "战", "雙": "双", "無": "无", "盡": "尽", "順": "顺",
    "極": "极", "歲": "岁", "當": "当", "這": "这", "個": "个", "們": "们", "為": "为", "總": "总", "實": "实",
    "陰": "阴", "陽": "阳", "聖": "圣", "靈": "灵", "夢": "梦", "戀": "恋", "網": "网", "寶": "宝", "藍": "蓝",
    "覺": "觉", "經": "经", "終": "终", "貝": "贝", "幾": "几", "體": "体", "頭": "头", "師": "师",
    "慶": "庆", "餘": "余", "館": "馆", "漢": "汉", "趙": "赵", "滄": "沧", "粵": "粤", "語": "语",
    "專": "专", "區": "区", "號": "号", "劃": "划", "燈": "灯", "貴": "贵", "顏": "颜", "廣": "广", "澤": "泽",
    "遲": "迟", "歡": "欢", "鱗": "鳞", "綺": "绮", "紀": "纪", "義": "义", "獄": "狱", "滬": "沪", "灣": "湾",
    "峽": "峡", "層": "层", "樓": "楼", "鹽": "盐", "澀": "涩", "歸": "归", "樂": "乐", "豐": "丰", "俠": "侠",
    "俁": "俣", "優": "优", "偉": "伟", "側": "侧", "僅": "仅", "價": "价", "儀": "仪", "億": "亿", "儲": "储",
    "兒": "儿", "剛": "刚", "劉": "刘", "勁": "劲", "勞": "劳", "勳": "勋", "匯": "汇", "華": "华", "協": "协",
    "單": "单", "衛": "卫", "廳": "厅", "厲": "厉", "壓": "压", "參": "参", "叢": "丛", "吳": "吴", "啟": "启",
    "喬": "乔", "喚": "唤", "嘆": "叹", "嘯": "啸", "噸": "吨", "嚴": "严", "園": "园", "團": "团", "圍": "围",
    "壘": "垒", "壞": "坏", "壯": "壮", "壽": "寿", "夠": "够", "夢": "梦", "奪": "夺", "奮": "奋", "奧": "奥",
    "奬": "奖", "婦": "妇", "媽": "妈", "嫻": "娴", "學": "学", "寧": "宁", "實": "实", "對": "对", "導": "导",
    "將": "将", "專": "专", "尋": "寻", "對": "对", "屆": "届", "岡": "冈", "島": "岛", "峯": "峰", "峽": "峡",
    "巔": "巅", "幣": "币", "幫": "帮", "幹": "干", "庫": "库", "廢": "废", "彈": "弹", "強": "强", "彥": "彦",
    "徑": "径", "徹": "彻", "憂": "忧", "應": "应", "懷": "怀", "懸": "悬", "懲": "惩", "戶": "户", "拋": "抛",
    "挾": "挟", "捨": "舍", "掃": "扫", "掄": "抡", "揚": "扬", "換": "换", "揮": "挥", "損": "损", "搖": "摇",
    "攝": "摄", "擁": "拥", "據": "据", "擇": "择", "擊": "击", "擋": "挡", "擾": "扰", "擴": "扩", "攝": "摄",
    "擺": "摆", "斂": "敛", "斃": "毙", "斕": "斓", "於": "于", "暈": "晕", "曉": "晓", "曆": "历", "曠": "旷",
    "曬": "晒", "曉": "晓", "書": "书", "朧": "胧", "殺": "杀", "條": "条", "梟": "枭", "棄": "弃", "榮": "荣",
    "槍": "枪", "槓": "杠", "樁": "桩", "橋": "桥", "機": "机", "檔": "档", "檢": "检", "歡": "欢", "歐": "欧",
    "歲": "岁", "殘": "残", "殿": "殿", "氣": "气", "決": "决", "沒": "没", "沖": "冲", "況": "况", "滾": "滚",
    "滿": "满", "潔": "洁", "潛": "潜", "澤": "泽", "濃": "浓", "濤": "涛", "濟": "济", "濱": "滨", "瀾": "澜",
    "灣": "湾", "營": "营", "爍": "烁", "爐": "炉", "爭": "争", "爾": "尔", "獨": "独", "獅": "狮", "獻": "献",
    "璣": "玑", "環": "环", "瓊": "琼", "甄": "甄", "產": "产", "當": "当", "瘋": "疯", "盜": "盗", "盤": "盘",
    "盧": "卢", "監": "监", "盪": "荡", "矚": "瞩", "矯": "矫", "硤": "硖", "礎": "础", "禍": "祸", "禦": "御",
    "禪": "禅", "種": "种", "稱": "称", "穀": "谷", "窩": "窝", "競": "竞", "筆": "笔", "築": "筑", "籃": "篮",
    "糰": "团", "糾": "纠", "紀": "纪", "約": "约", "級": "级", "紋": "纹", "納": "纳", "純": "纯", "紙": "纸",
    "紛": "纷", "素": "素", "紮": "扎", "紹": "绍", "終": "终", "組": "组", "細": "细", "結": "结", "絃": "弦",
    "給": "给", "絕": "绝", "統": "统", "絲": "丝", "經": "经", "綁": "绑", "維": "维", "綱": "纲", "網": "网",
    "緊": "紧", "緒": "绪", "練": "练", "縣": "县", "縱": "纵", "總": "总", "績": "绩", "織": "织", "繞": "绕",
    "繼": "继", "續": "续", "罷": "罢", "羋": "芈", "習": "习", "翹": "翘", "翻": "翻", "聯": "联", "聲": "声",
    "職": "职", "肅": "肃", "腦": "脑", "腳": "脚", "脈": "脉", "腫": "肿", "臺": "台", "艦": "舰", "艱": "艰",
    "艷": "艳", "藝": "艺", "節": "节", "莊": "庄", "蒼": "苍", "蓋": "盖", "蓮": "莲", "蔣": "蒋", "蕭": "萧",
    "薩": "萨", "藥": "药", "虜": "虏", "號": "号", "蛻": "蜕", "蝕": "蚀", "衛": "卫", "補": "补", "裝": "装",
    "複": "复", "襲": "袭", "覈": "核", "覓": "觅", "覽": "览", "觸": "触", "訂": "订", "訃": "讣", "計": "计",
    "訊": "讯", "託": "托", "記": "记", "訓": "训", "訴": "诉", "診": "诊", "詐": "诈", "詔": "诏", "評": "评",
    "詞": "词", "詠": "咏", "詢": "询", "試": "试", "詩": "诗", "話": "话", "該": "该", "詳": "详", "誅": "诛",
    "誠": "诚", "誤": "误", "說": "说", "誰": "谁", "課": "课", "調": "调", "談": "谈", "請": "请", "諒": "谅",
    "諜": "谍", "諾": "诺", "謀": "谋", "謊": "谎", "謎": "谜", "講": "讲", "謝": "谢", "譚": "谭", "譜": "谱",
    "譯": "译", "議": "议", "護": "护", "讀": "读", "變": "变", "讓": "让", "豐": "丰", "貓": "猫", "貫": "贯",
    "責": "责", "貧": "贫", "貨": "货", "販": "贩", "貪": "贪", "貫": "贯", "賀": "贺", "賈": "贾", "資": "资",
    "賊": "贼", "賓": "宾", "賜": "赐", "賞": "赏", "賠": "赔", "賢": "贤", "賣": "卖", "質": "质", "賴": "赖",
    "贈": "赠", "贏": "赢", "趕": "赶", "趙": "赵", "跡": "迹", "踐": "践", "踴": "踊", "蹟": "迹", "車": "车",
    "軌": "轨", "軍": "军", "軟": "软", "較": "较", "輛": "辆", "輝": "辉", "輩": "辈", "輪": "轮", "輯": "辑",
    "輸": "输", "轟": "轰", "辦": "办", "邁": "迈", "還": "还", "邊": "边", "郵": "邮", "鄉": "乡", "鄧": "邓",
    "鄭": "郑", "醜": "丑", "醫": "医", "醬": "酱", "釀": "酿", "釋": "释", "針": "针", "鈴": "铃", "鈺": "钰",
    "鉅": "巨", "鉤": "钩", "銀": "银", "銃": "铳", "銅": "铜", "銘": "铭", "銳": "锐", "鋒": "锋", "錘": "锤",
    "錦": "锦", "鍋": "锅", "鎖": "锁", "鐘": "钟", "鐵": "铁", "鑄": "铸", "鑑": "鉴", "長": "长", "門": "门",
    "開": "开", "閃": "闪", "閉": "闭", "問": "问", "聞": "闻", "閩": "闽", "閣": "阁", "闖": "闯", "關": "关",
    "陣": "阵", "陽": "阳", "際": "际", "雜": "杂", "離": "离", "難": "难", "雲": "云", "雷": "雷", "霧": "雾",
    "靜": "静", "響": "响", "頂": "顶", "頃": "顷", "項": "项", "順": "顺", "須": "须", "頑": "顽", "頓": "顿",
    "頒": "颁", "頗": "颇", "領": "领", "頭": "头", "頰": "颊", "顆": "颗", "顧": "顾", "顫": "颤", "顯": "显",
    "顱": "颅", "顴": "颧", "風": "风", "飛": "飞", "飯": "饭", "飲": "饮", "飼": "饲", "館": "馆", "駁": "驳",
    "駕": "驾", "騎": "骑", "騙": "骗", "騰": "腾", "驅": "驱", "驗": "验", "驚": "惊", "髒": "脏", "鬚": "须",
    "鬧": "闹", "鬱": "郁", "魚": "鱼", "魯": "鲁", "鮑": "鲍", "鮮": "鲜", "鯨": "鲸", "鳴": "鸣", "鷹": "鹰",
    "麗": "丽", "麥": "麦", "黃": "黄", "點": "点", "黨": "党", "齊": "齐", "齒": "齿", "龍": "龙"
  };
  return String(value || "").split("").map((ch) => map[ch] || ch).join("");
}

function getSimplifyConverter() {
  if (simplifyConverterChecked) return simplifyConverter;
  simplifyConverterChecked = true;

  if (DISABLE_OPENCC) {
    simplifyConverterName = "fallback-map";
    simplifyConverter = fallbackTraditionalToSimplified;
    return simplifyConverter;
  }

  try {
    const conv = require("chinese-conv");
    if (conv && typeof conv.sify === "function") {
      simplifyConverterName = "chinese-conv";
      simplifyConverter = (text) => conv.sify(String(text || ""));
      return simplifyConverter;
    }
  } catch (_) {}

  try {
    const rsOpencc = require("@node-rs/opencc");
    if (rsOpencc && typeof rsOpencc.t2s === "function") {
      simplifyConverterName = "@node-rs/opencc:t2s";
      simplifyConverter = (text) => rsOpencc.t2s(String(text || ""));
      return simplifyConverter;
    }
    if (rsOpencc && typeof rsOpencc.OpenCC === "function") {
      const cc = new rsOpencc.OpenCC("t2s.json");
      if (typeof cc.convertSync === "function") {
        simplifyConverterName = "@node-rs/opencc:OpenCC";
        simplifyConverter = (text) => cc.convertSync(String(text || ""));
        return simplifyConverter;
      }
    }
  } catch (_) {}

  try {
    const openccJs = require("opencc-js");
    if (openccJs && typeof openccJs.Converter === "function") {
      const converter = openccJs.Converter({ from: "t", to: "cn" });
      if (typeof converter === "function") {
        simplifyConverterName = "opencc-js";
        simplifyConverter = (text) => converter(String(text || ""));
        return simplifyConverter;
      }
    }
  } catch (_) {}

  try {
    const opencc = require("opencc");
    if (opencc && typeof opencc.OpenCC === "function") {
      const cc = new opencc.OpenCC("t2s.json");
      if (typeof cc.convertSync === "function") {
        simplifyConverterName = "opencc:convertSync";
        simplifyConverter = (text) => cc.convertSync(String(text || ""));
        return simplifyConverter;
      }
    }
    if (opencc && typeof opencc.t2s === "function") {
      simplifyConverterName = "opencc:t2s";
      simplifyConverter = (text) => opencc.t2s(String(text || ""));
      return simplifyConverter;
    }
  } catch (_) {}

  simplifyConverterName = "fallback-map";
  simplifyConverter = fallbackTraditionalToSimplified;
  return simplifyConverter;
}

function convertTraditionalToSimplified(value) {
  const text = String(value || "");
  try {
    const converter = getSimplifyConverter();
    const result = converter ? converter(text) : text;
    return String(result || text);
  } catch (_) {
    simplifyConverterName = "fallback-map";
    return fallbackTraditionalToSimplified(text);
  }
}

function toDisplayText(value) {
  return convertTraditionalToSimplified(normalizeText(value));
}

function parsePlaySourceOrderConfig() {
  const raw = PLAY_SOURCE_ORDER_CONFIG;
  if (!raw) return DEFAULT_PLAY_SOURCE_ORDER;

  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item || "").trim()).filter(Boolean);
    } catch (_) {}
  }

  return raw.split(/[,\n|;]+/).map((item) => item.trim()).filter(Boolean);
}

function normalizePlaySourceKey(value) {
  return toDisplayText(value)
    .replace(/[ᴴＨｈ]/g, "H")
    .replace(/[ᴰＤｄ]/g, "D")
    .replace(/\s+/g, "")
    .replace(/HD$/i, "")
    .toLowerCase();
}

function getPlaySourceOrderMap() {
  const orderMap = new Map();
  parsePlaySourceOrderConfig().forEach((name, index) => {
    const key = normalizePlaySourceKey(name);
    if (key && !orderMap.has(key)) orderMap.set(key, index);
  });
  return orderMap;
}

function sortPlaySources(playSources) {
  const orderMap = getPlaySourceOrderMap();
  if (!orderMap.size) return playSources;

  return playSources
    .map((source, index) => ({ source, index, order: orderMap.get(normalizePlaySourceKey(source.name)) }))
    .sort((a, b) => {
      const aConfigured = Number.isInteger(a.order);
      const bConfigured = Number.isInteger(b.order);
      if (aConfigured && bConfigured) return a.order - b.order || a.index - b.index;
      if (aConfigured) return -1;
      if (bConfigured) return 1;
      return a.index - b.index;
    })
    .map((item) => item.source);
}

function normalizeSearchKeyword(value) {
  return convertTraditionalToSimplified(String(value || ""))
    .replace(/[\s\-_—–·•:：,，.。!?！？'"“”‘’()（）\[\]【】{}]/g, "")
    .toLowerCase();
}

function buildSearchTokens(keyword) {
  const base = normalizeSearchKeyword(keyword);
  if (!base) return [];
  const tokens = new Set([base]);
  const simplified = base
    .replace(/線上看|线上看|全集|連續劇|连续剧|電視劇|电视剧|動漫|动漫|電影|电影|綜藝|综艺/g, "")
    .trim();
  if (simplified) tokens.add(simplified);
  const digitStripped = simplified.replace(/第\d+[集季部篇]?$/g, "").replace(/\d+$/g, "");
  if (digitStripped) tokens.add(digitStripped);
  return [...tokens].filter(Boolean).sort((a, b) => b.length - a.length);
}

function scoreSearchResult(vodName, keyword) {
  const name = normalizeSearchKeyword(vodName);
  const tokens = buildSearchTokens(keyword);
  if (!name || !tokens.length) return 0;

  let score = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (name === token) score = Math.max(score, 1000 + token.length);
    else if (name.startsWith(token)) score = Math.max(score, 800 + token.length);
    else if (name.includes(token)) score = Math.max(score, 600 + token.length);
    else if (token.includes(name) && name.length >= 2) score = Math.max(score, 450 + name.length);
  }
  return score;
}

function extractCards($, scope) {
  const list = [];
  const seen = new Set();
  const $scope = scope && scope.length ? scope : $.root();

  $scope.find("a[href*='/detail/']").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href") || "";
    const vod_id = absUrl(href);
    if (!/\/detail\/\d+\.html/i.test(vod_id) || seen.has(vod_id)) return;

    const title = toDisplayText(
      $el.attr("title")
      || $el.find("img").attr("alt")
      || $el.find(".title, .video-text, .module-poster-item-title, h3, h4, h5").first().text()
      || $el.text()
    );
    if (!title) return;

    const pic = absUrl(
      $el.attr("data-original")
      || $el.attr("data-src")
      || $el.attr("data-bg")
      || $el.find("img").attr("data-original")
      || $el.find("img").attr("data-src")
      || $el.find("img").attr("src")
      || $el.closest(".module-item, li, .public-list-box, .video-item, .item, .col-md-2, .col-sm-3, .col-xs-4").find("a.video-pic").first().attr("data-original")
      || $el.closest(".module-item, li, .public-list-box, .video-item, .item, .col-md-2, .col-sm-3, .col-xs-4").find("a.video-pic").first().attr("data-src")
      || $el.closest(".module-item, li, .public-list-box, .video-item, .item, .col-md-2, .col-sm-3, .col-xs-4").find("img").first().attr("data-original")
      || $el.closest(".module-item, li, .public-list-box, .video-item, .item, .col-md-2, .col-sm-3, .col-xs-4").find("img").first().attr("data-src")
      || $el.closest(".module-item, li, .public-list-box, .video-item, .item, .col-md-2, .col-sm-3, .col-xs-4").find("img").first().attr("src")
      || ""
    );
    const parentHtml = $el.closest("li, .module-item, .public-list-box, .video-item, .item, .module-poster-item, .myui-vodlist__box").html() || $el.parent().html() || "";
    const remarksMatch = String(parentHtml).match(/(?:更新至第?\d+集|更新第?\d+集|\(?\d+全\)?|全\d+集|已完結|已完结|HD中字|HD|TC|HC|搶先版|抢先版)/i);
    const vod_remarks = remarksMatch ? toDisplayText(remarksMatch[0]) : "";

    seen.add(vod_id);
    list.push({ vod_id, vod_name: title, vod_pic: pic, vod_remarks });
  });

  return list;
}

// ==================== 分类 / 筛选 ====================
// 站点是 MacCMS v10 改版模板，分类 id 见下方（來自站方欄目與第三方實現的實際取值）。
const CATEGORIES = [
  { type_id: "1", type_name: "電影" },
  { type_id: "2", type_name: "電視劇" },
  { type_id: "13", type_name: "陸劇" },
  { type_id: "20", type_name: "韓劇" },
  { type_id: "16", type_name: "美劇" },
  { type_id: "15", type_name: "日劇" },
  { type_id: "14", type_name: "台劇" },
  { type_id: "21", type_name: "港劇" },
  { type_id: "31", type_name: "海外劇" },
  { type_id: "4", type_name: "動漫" },
  { type_id: "29", type_name: "綜藝" },
  { type_id: "34", type_name: "短劇" },
  { type_id: "38", type_name: "AI漫劇" },
  { type_id: "22", type_name: "紀錄片" },
];

const AREA_FILTER = [
  { name: "全部", value: "" }, { name: "大陸", value: "大陸" }, { name: "韓國", value: "韓國" },
  { name: "日本", value: "日本" }, { name: "台灣", value: "台灣" }, { name: "香港", value: "香港" },
  { name: "美國", value: "美國" }, { name: "歐美", value: "歐美" }, { name: "泰國", value: "泰國" },
  { name: "英國", value: "英國" }, { name: "其他", value: "其他" },
];

const YEAR_FILTER = [{ name: "全部", value: "" }].concat(
  [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017].map((y) => ({ name: String(y), value: String(y) }))
);

function buildClassAndFilters() {
  const filters = {};
  for (const cat of CATEGORIES) {
    filters[cat.type_id] = [
      { key: "area", name: "地區", init: "", value: AREA_FILTER },
      { key: "year", name: "年份", init: "", value: YEAR_FILTER },
    ];
  }
  return { class: CATEGORIES.map((c) => ({ type_id: c.type_id, type_name: c.type_name })), filters };
}

// /explore/{type}-{area}-{9×空}-{year}.html —— 12 段、11 个连字符，比 /genre/ 页小 7 倍
function buildExploreUrl(typeId, area, year) {
  const safeArea = String(area || "").trim();
  const safeYear = String(year || "").trim();
  const parts = [String(typeId || ""), safeArea, "", "", "", "", "", "", "", "", "", safeYear];
  return `${BASE_URL}/explore/${parts.join("-")}.html`;
}

// ==================== 首页 ====================
async function home(params, context) {
  try {
    getSimplifyConverter();
    const config = buildClassAndFilters();
    const html = await requestText(`${BASE_URL}/`);
    const $ = cheerio.load(html);
    const list = extractCards($).slice(0, 30);
    await OmniBox.log("info", `[Gimy剧迷][home] 推荐数=${list.length} 简繁=${simplifyConverterName}`);
    return { class: config.class, filters: config.filters, list };
  } catch (e) {
    await OmniBox.log("error", `[Gimy剧迷][home] ${e.message}`);
    const config = buildClassAndFilters();
    return { class: config.class, filters: config.filters, list: [] };
  }
}

// ==================== 分类列表 ====================
async function category(params, context) {
  try {
    const page = Math.max(Number(params.page || 1) || 1, 1);
    let typeId = String(params.categoryId || params.type_id || params.tid || "1").trim();
    if (typeId && !/^\d+$/.test(typeId)) {
      const hit = CATEGORIES.find((c) => c.type_name === typeId);
      if (hit) typeId = hit.type_id;
      else typeId = "1";
    }

    let ext = params.filters || params.extend || {};
    if (typeof ext === "string") {
      try {
        ext = JSON.parse(ext);
      } catch (_) {
        ext = {};
      }
    }
    const area = String(ext.area || "").trim();
    const year = String(ext.year || "").trim();

    const url = buildExploreUrl(typeId, area, year) + (page > 1 ? `?page=${page}` : "");
    const html = await requestText(url);
    const $ = cheerio.load(html);
    const list = extractCards($);

    // 有页码链接就以最大页码为准，否则按「满 36 条还有下一页」估算
    let pagecount = 1;
    const pageNums = String(html).match(/\/explore\/[^"']*?-(\d+)-\d+\.html|[?&]page=(\d+)/g) || [];
    const nums = [];
    for (const raw of pageNums) {
      const m = String(raw).match(/(\d+)(?:\.html)?$/);
      if (m) nums.push(Number(m[1]));
    }
    if (nums.length) pagecount = Math.max(page, ...nums);
    else pagecount = list.length >= 36 ? page + 1 : page;

    await OmniBox.log("info", `[Gimy剧迷][category] type=${typeId} area=${area} year=${year} page=${page} list=${list.length} pagecount=${pagecount}`);
    return { page, pagecount, limit: 36, total: pagecount * 36, list };
  } catch (e) {
    await OmniBox.log("error", `[Gimy剧迷][category] ${e.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

// ==================== 详情 ====================
// 新模板线路结构：
//   <div class="route-title">4K线路 <span class="hd">HD</span></div>
//   <div class="eps episodes-route..." data-route-sid="12"><a class="ep" href="/play/{vid}-{sid}-{nid}.html">第1集</a>…</div>
function parsePlaySourcesNew($) {
  const sources = [];
  $("[data-route-sid]").each((_, el) => {
    const $eps = $(el);
    const sid = String($eps.attr("data-route-sid") || "");
    let $title = $eps.prevAll(".route-title").first();
    if (!$title.length) $title = $eps.parent().find(".route-title").first();
    const $titleClone = $title.clone();
    $titleClone.find(".hd, .badge, .label, .tag").remove();
    const name = toDisplayText($titleClone.text()) || `線路${sid || sources.length + 1}`;

    const episodes = [];
    const seen = new Set();
    $eps.find("a.ep, a[href*='/play/']").each((__, a) => {
      const $a = $(a);
      const href = $a.attr("href") || "";
      if (!/\/play\/\d+-\d+-\d+\.html/i.test(href)) return;
      const playId = absUrl(href);
      if (seen.has(playId)) return;
      seen.add(playId);
      episodes.push({ name: toDisplayText($a.text()) || "正片", playId });
    });
    if (episodes.length) sources.push({ name, episodes });
  });
  return sources;
}

function parsePlaySourcesOld($) {
  const tabs = [];
  const seenTabs = new Set();
  $("#playTab a[href^='#con_playlist_']").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href") || "";
    const tabId = href.replace(/^#/, "");
    const name = toDisplayText($el.text()) || tabId;
    if (tabId && !seenTabs.has(tabId)) {
      seenTabs.add(tabId);
      tabs.push({ tabId, name });
    }
  });

  const sources = [];
  for (const tab of tabs) {
    let episodes = [];
    $("[id]").filter((_, el) => String($(el).attr("id") || "") === tab.tabId).each((_, playlist) => {
      const found = [];
      const seen = new Set();
      $(playlist).find("a[href*='/play/']").each((__, a) => {
        const playId = absUrl($(a).attr("href") || "");
        if (!playId || seen.has(playId)) return;
        seen.add(playId);
        found.push({ name: toDisplayText($(a).text()) || "正片", playId });
      });
      if (found.length > episodes.length) episodes = found;
    });
    if (episodes.length) sources.push({ name: tab.name, episodes });
  }
  return sources;
}

function parsePlaySources($, html) {
  let sources = parsePlaySourcesNew($);
  if (!sources.length) sources = parsePlaySourcesOld($);
  if (!sources.length) {
    // 兜底：整页抓 /play/x-y-z.html，按 sid 分组
    const bySid = new Map();
    const re = /href=["']\/play\/(\d+)-(\d+)-(\d+)\.html["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(String(html || ""))) !== null) {
      const sid = m[2];
      if (!bySid.has(sid)) bySid.set(sid, []);
      bySid.get(sid).push({ name: toDisplayText(m[4]) || `第${m[3]}集`, playId: `${BASE_URL}/play/${m[1]}-${m[2]}-${m[3]}.html` });
    }
    for (const [sid, eps] of bySid) {
      const seen = new Set();
      const uniq = eps.filter((e) => (seen.has(e.playId) ? false : (seen.add(e.playId), true)));
      sources.push({ name: `線路${sid}`, episodes: uniq });
    }
  }
  return sortPlaySources(sources);
}

function pickInfo(html, labels) {
  const list = Array.isArray(labels) ? labels : [labels];
  for (const label of list) {
    // 新模板：<span class="k">地區：</span>中國大陸 </div>
    let m = String(html || "").match(
      new RegExp(`<span class="k">\\s*${label}\\s*[：:]\\s*</span>\\s*([\\s\\S]*?)</div>`, "i")
    );
    if (m) return toDisplayText(m[1]);
    // 老模板：<li><span>地區：</span>xxx</li>
    m = String(html || "").match(new RegExp(`<span[^>]*>${label}[：:]</span>([\\s\\S]*?)</li>`, "i"));
    if (m) return toDisplayText(m[1]);
  }
  return "";
}

async function detail(params, context) {
  try {
    const videoId = String(params.videoId || params.id || params.vod_id || "").trim();
    if (!videoId) return { list: [] };

    let url = videoId;
    let vid = videoId;
    const idMatch = videoId.match(/\/detail\/(\d+)\.html/) || videoId.match(/^(\d+)$/);
    if (idMatch) {
      vid = idMatch[1];
      url = `${BASE_URL}/detail/${vid}.html`;
    } else if (!/^https?:\/\//i.test(videoId)) {
      url = absUrl(videoId);
    }

    const html = await requestText(url);
    const $ = cheerio.load(html);

    let vod_name = toDisplayText(
      $("meta[property='og:title']").attr("content") || ""
    ).replace(/\s*線上看\s*[-–]\s*Gimy.*$/i, "").trim();
    if (!vod_name) vod_name = toDisplayText($("h1").first().text() || $("title").text().split("線上看")[0]);

    const vod_pic = absUrl(
      $("meta[property='og:image']").attr("content")
      || $(".details-pic .video-pic").attr("style")?.match(/url\(([^)]+)\)/)?.[1]
      || $("img").first().attr("src")
      || ""
    );
    let vod_content = toDisplayText($("meta[property='og:description']").attr("content") || "");
    if (!vod_content) {
      vod_content = toDisplayText($(".switch-box .text, .details-content .text, .details-content, .detail-sketch").first().text());
    }

    const vod_remarks = pickInfo(html, ["狀態", "状态", "更新"]);
    let type_name = pickInfo(html, ["類別", "类别"]);
    // 站方格式「陸劇 · 2019」，只留类型名
    if (type_name) type_name = type_name.replace(/\s*·\s*\d{4}.*$/, "").trim();
    const vod_year = pickInfo(html, ["年份", "年代"]);
    const vod_area = pickInfo(html, ["地區", "地区", "國家/地區", "国家/地区"]);
    let vod_actor = pickInfo(html, ["演員", "演员", "主演"]);
    let vod_director = pickInfo(html, ["導演", "导演"]);
    if (!vod_actor) vod_actor = toDisplayText($("li:contains('主演') a").map((_, el) => $(el).text()).get().join(" / "));
    if (!vod_director) vod_director = toDisplayText($("li:contains('導演') a, li:contains('导演') a").map((_, el) => $(el).text()).get().join(" / "));

    const vod_play_sources = parsePlaySources($, html);

    await OmniBox.log("info", `[Gimy剧迷][detail] ${url} 线路=${vod_play_sources.length} 集数=${vod_play_sources.map((s) => `${s.name}:${s.episodes.length}`).join(",")}`);
    return {
      list: [{
        vod_id: vid,
        vod_name,
        vod_pic,
        vod_content,
        vod_remarks,
        type_name,
        vod_year,
        vod_area,
        vod_actor,
        vod_director,
        vod_play_sources,
      }],
    };
  } catch (e) {
    await OmniBox.log("error", `[Gimy剧迷][detail] ${e.message}`);
    return { list: [] };
  }
}

// ==================== 搜索 ====================
// 站点新版：/find/ 已被 CF 重点照顾，走 MacCMS 自带的 ajax/suggest（返回 JSON）
async function searchBySuggest(keyword, page) {
  const url = `${BASE_URL}/index.php/ajax/suggest?mid=1&wd=${encodeURIComponent(keyword)}&limit=20&page=${page}`;
  const text = await requestText(url, {
    accept: "application/json, text/javascript, */*; q=0.01",
    fetchMode: "cors",
    fetchDest: "empty",
    timeout: 15000,
  });
  const json = JSON.parse(text);
  if (!json || Number(json.code) !== 1) return [];
  return (json.list || []).map((it) => ({
    vod_id: String(it.id || ""),
    vod_name: toDisplayText(it.name || ""),
    vod_pic: absUrl(it.pic || ""),
    vod_remarks: "",
  })).filter((it) => it.vod_id);
}

async function searchByFind(keyword, page) {
  const url = `${BASE_URL}/find/-------------.html?wd=${encodeURIComponent(keyword)}&page=${page}`;
  const html = await requestText(url);
  const $ = cheerio.load(html);
  const scope = $(".box-main-content").first();
  return extractCards($, scope.length ? scope : null);
}

async function search(params, context) {
  const keyword = String(params.keyword || params.key || params.wd || "").trim();
  const page = Math.max(Number(params.page || 1) || 1, 1);
  if (!keyword) return { page, pagecount: 0, total: 0, list: [] };

  let list = [];
  try {
    list = await searchBySuggest(keyword, page);
    await OmniBox.log("info", `[Gimy剧迷][search] ajax/suggest keyword=${keyword} page=${page} list=${list.length}`);
  } catch (e) {
    await OmniBox.log("warn", `[Gimy剧迷][search] ajax/suggest 失败: ${e.message}`);
  }

  if (!list.length) {
    try {
      list = await searchByFind(keyword, page);
      await OmniBox.log("info", `[Gimy剧迷][search] find 兜底 keyword=${keyword} page=${page} list=${list.length}`);
    } catch (e) {
      await OmniBox.log("error", `[Gimy剧迷][search] ${e.message}`);
    }
  }

  return {
    page,
    pagecount: list.length >= 20 ? page + 1 : page,
    limit: 20,
    total: list.length,
    list,
  };
}

// ==================== 播放解析 ====================
// 说明：旧版走的 play.gimyai.tw 已整域无 DNS；现在播放地址在播放页的
// var player_data = {url, from, encrypt} 里，encrypt=1 是 URL 编码、=2 是 base64+URL 编码。
// 直链（.m3u8/.mp4）直接返回；芒果/腾讯/优酷这类需要解析器的，交给公开解析站。
const MEDIA_RE = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4|flv)(?:\?[^\s"'<>\\]*)?/gi;

function isDirectMedia(url) {
  const value = String(url || "").trim();
  if (!/^https?:\/\//i.test(value)) return false;
  const path = value.split("?")[0].split("#")[0];
  return /\.(m3u8|mp4|flv)$/i.test(path);
}

function pickMediaUrl(text) {
  const normalized = String(text || "").replace(/\\\//g, "/");
  const re = new RegExp(MEDIA_RE.source, "gi");
  let m;
  while ((m = re.exec(normalized)) !== null) {
    const candidate = m[0];
    if (/[?&](url|u|v|link|jx)=/i.test(candidate)) continue;
    if (!isDirectMedia(candidate)) continue;
    return candidate;
  }
  return "";
}

function parseInlinePlayer(html) {
  const text = String(html || "");
  const patterns = [
    /var\s+player_data\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
    /var\s+player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
    /player_data\s*=\s*(\{[\s\S]*?\})\s*;/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    try {
      return JSON.parse(m[1].replace(/\\\//g, "/"));
    } catch (_) {}
  }
  return null;
}

function extractIframe(html) {
  const m = String(html || "").match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (!m) return "";
  return absUrl(m[1].replace(/&amp;/g, "&"));
}

function buildPlayResult(url, from, referer) {
  const header = { "User-Agent": UA, Referer: referer || `${BASE_URL}/`, Origin: BASE_URL };
  return {
    parse: 0,
    url,
    urls: [{ name: toDisplayText(from) || "直链播放", url }],
    header,
    headers: header,
  };
}

// 站方对非直链线路（mgtt/qq/优酷/qsvip/JD4K…）用公开解析站，这里保持同样口径
function buildParserUrl(rawUrl, from) {
  const flag = String(from || "");
  let prefix = "lb";
  if (flag === "qsvip" || flag === "qq" || flag === "mgtv") prefix = "qs";
  if (/^JD/.test(flag)) prefix = "jd";
  return `https://v.attzy.com/ap/${prefix}/?url=${encodeURIComponent(rawUrl)}`;
}

async function resolveIframe(iframeUrl, referer, depth) {
  if (!iframeUrl || depth > 1) return "";
  try {
    await OmniBox.log("info", `[Gimy剧迷][play] 进 iframe(depth=${depth}) ${iframeUrl.slice(0, 150)}`);
    const html = await requestText(iframeUrl, { referer, timeout: 12000 });
    const direct = pickMediaUrl(html);
    if (direct) return direct;
    const data = parseInlinePlayer(html);
    if (data && data.url) {
      let rawUrl = String(data.url).replace(/\\\//g, "/");
      const enc = Number(data.encrypt || 0);
      if (enc === 1) rawUrl = decodeURIComponent(rawUrl);
      else if (enc === 2) {
        try {
          rawUrl = decodeURIComponent(Buffer.from(rawUrl, "base64").toString("utf8"));
        } catch (_) {}
      }
      if (isDirectMedia(rawUrl)) return rawUrl;
      const parsed = await tryParserEndpoint(rawUrl, String(data.from || ""), iframeUrl);
      if (parsed) return parsed;
    }
    const nextIframe = extractIframe(html);
    if (nextIframe && nextIframe !== iframeUrl) return resolveIframe(nextIframe, iframeUrl, depth + 1);
  } catch (e) {
    await OmniBox.log("warn", `[Gimy剧迷][play] iframe 解析失败: ${e.message}`);
  }
  return "";
}

async function tryParserEndpoint(rawUrl, from, referer) {
  const parserUrl = buildParserUrl(rawUrl, from);
  try {
    const text = await requestText(parserUrl, {
      referer: `${BASE_URL}/`,
      accept: "text/html,application/json,*/*",
      timeout: 12000,
    });
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {}
    const candidate = String((json && (json.url || json.video || json.playurl)) || "").trim() || pickMediaUrl(text);
    if (isDirectMedia(candidate)) {
      await OmniBox.log("info", `[Gimy剧迷][play] 解析站命中 ${parserUrl.slice(0, 80)} -> ${candidate.slice(0, 110)}`);
      return candidate;
    }
    await OmniBox.log("warn", `[Gimy剧迷][play] 解析站无直链 ${parserUrl.slice(0, 80)}`);
  } catch (e) {
    await OmniBox.log("warn", `[Gimy剧迷][play] 解析站失败: ${e.message}`);
  }
  return "";
}

async function play(params, context) {
  try {
    const playId = String(params.playId || params.id || params.url || "").trim();
    if (!playId) return { parse: 0, urls: [], url: "", header: {}, headers: {} };

    if (isDirectMedia(playId)) {
      return buildPlayResult(playId, "直链", `${BASE_URL}/`);
    }

    // playId 可能是 /play/{vid}-{sid}-{nid}.html，也可能只有 {vid}-{sid}-{nid}
    let pageUrl = playId;
    if (!/^https?:\/\//i.test(playId)) {
      pageUrl = /^\/?play\//i.test(playId)
        ? absUrl(playId.startsWith("/") ? playId : `/${playId}`)
        : `${BASE_URL}/play/${playId.replace(/^.*\//, "")}${/\.html$/i.test(playId) ? "" : ".html"}`;
    }
    const baseHeaders = { "User-Agent": UA, Referer: pageUrl, Origin: BASE_URL };
    await OmniBox.log("info", `[Gimy剧迷][play] start pageUrl=${pageUrl}`);

    let html = "";
    try {
      html = await requestText(pageUrl, { referer: `${BASE_URL}/`, timeout: 15000 });
    } catch (e) {
      await OmniBox.log("warn", `[Gimy剧迷][play] 读取播放页失败: ${e.message}`);
    }

    if (html) {
      const player = parseInlinePlayer(html);
      if (player && player.url) {
        let rawUrl = String(player.url).replace(/\\\//g, "/");
        const from = String(player.from || "");
        const enc = Number(player.encrypt === undefined ? player.encrypt || 0 : player.encrypt || 0) || 0;
        if (enc === 1) {
          try {
            rawUrl = decodeURIComponent(rawUrl);
          } catch (_) {}
        } else if (enc === 2) {
          try {
            rawUrl = decodeURIComponent(Buffer.from(rawUrl, "base64").toString("utf8"));
          } catch (_) {}
        }
        await OmniBox.log("info", `[Gimy剧迷][play] player_data url=${rawUrl.slice(0, 130)} from=${from} encrypt=${enc}`);

        if (isDirectMedia(rawUrl)) return buildPlayResult(rawUrl, from || "直链", pageUrl);

        const parsed = await tryParserEndpoint(rawUrl, from, pageUrl);
        if (parsed) return buildPlayResult(parsed, from || "解析线路", pageUrl);

        // 解析站没吐出直链时，把解析页交给客户端（它内置解析器能处理）
        const parserUrl = buildParserUrl(rawUrl, from);
        await OmniBox.log("warn", `[Gimy剧迷][play] 回退解析页 ${parserUrl.slice(0, 120)}`);
        return {
          parse: 1,
          url: parserUrl,
          urls: [{ name: toDisplayText(from) || "解析播放", url: parserUrl }],
          header: { "User-Agent": UA, Referer: `${BASE_URL}/` },
          headers: { "User-Agent": UA, Referer: `${BASE_URL}/` },
        };
      }

      const inline = pickMediaUrl(html);
      if (inline) {
        await OmniBox.log("info", `[Gimy剧迷][play] 页内直链 ${inline.slice(0, 130)}`);
        return buildPlayResult(inline, "页内直链", pageUrl);
      }

      const iframe = extractIframe(html);
      if (iframe) {
        const inner = await resolveIframe(iframe, pageUrl, 0);
        if (inner) return buildPlayResult(inner, "iframe", pageUrl);
      }
    }

    try {
      const sniffed = await OmniBox.sniffVideo(pageUrl, { "User-Agent": UA, Referer: pageUrl });
      await OmniBox.log("info", `[Gimy剧迷][play] sniff=${JSON.stringify(sniffed || {}).slice(0, 200)}`);
      if (sniffed && sniffed.url) {
        const header = sniffed.header || baseHeaders;
        return { parse: 0, url: sniffed.url, urls: [{ name: "嗅探播放", url: sniffed.url }], header, headers: header };
      }
    } catch (e) {
      await OmniBox.log("warn", `[Gimy剧迷][play] sniffVideo failed: ${e.message}`);
    }

    await OmniBox.log("warn", "[Gimy剧迷][play] 未解析到直链，回退播放页");
    return { parse: 1, url: pageUrl, urls: [{ name: "播放页", url: pageUrl }], header: baseHeaders, headers: baseHeaders };
  } catch (e) {
    await OmniBox.log("error", `[Gimy剧迷][play] ${e.message}`);
    return { parse: 0, urls: [], url: "", header: {}, headers: {} };
  }
}
