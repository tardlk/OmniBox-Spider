// @name Auete影视
// @author 梦
// @description 站点 www.au1080.top（Auete影视网：电影/剧集/综艺/动漫，云播 m3u8 直链）：支持首页、分类、搜索、详情与直链播放；播放页地址 base64 编码，解码即得 m3u8；站内搜索的算术验证码由脚本自动识别（Playwright 取像素 + 模板匹配），失败才回退扫列表页；封面默认直连，失效图床（如 502 的 dyttimage）与站点占位符自动剔除（AU_IMG_PROXY=off|wsrv|server|site）
// @dependencies cheerio
// @version 2.2.1
// @downloadURL https://gh-proxy.org/https://github.com/tardlk/OmniBox-Spider/raw/refs/heads/main/影视/采集/Auete影视.js

const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");
const cheerio = require("cheerio");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

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

// ================= 站内搜索：算术验证码自动求解 =================
// /auete4so.php 每次搜索都要一张 56x20 的算术验证码（形如 7+5=?）。
// OmniBox.request 会把响应体按 UTF-8 解码，JPEG 直接损坏，脚本里拿不到像素，
// 所以交给容器的 python + playwright：取像素 -> 归一化模板匹配 -> 提交，
// 把结果页 HTML 交回来，JS 侧继续用 cheerio 解析。
const SOLVER_FILE = path.join(os.tmpdir(), "ob_auete_solver.py");
const SOLVER_SRC = `# -*- coding: utf-8 -*-
"""Auete 站内搜索验证码求解（供 OmniBox 脚本通过 child_process 调用）
用法: python3 ob_auete_solver.py <keyword>
输出: 单行 JSON {"ok":bool,"session":"","answer":"","html":"","why":""}
"""
import asyncio
import base64
import http.cookiejar
import json
import sys
import time
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
BASE = "https://www.au1080.top"
CELLS = [(6, 13), (26, 33)]
NW, NH, TH = 8, 10, 145

TPL = {
    "1": [0.0, 0.0, 0.38, 1.0, 1.0, 0.38, 0.0, 0.0, 0.0, 0.62, 1.0, 1.0, 1.0, 0.38, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0,
          1.0, 0.38, 0.0, 0.0, 0.0, 0.0, 0.38, 1.0, 1.0, 0.38, 0.0, 0.0, 0.0, 0.0, 0.38, 1.0, 1.0, 0.38, 0.0, 0.0,
          0.0, 0.0, 0.38, 1.0, 1.0, 0.38, 0.0, 0.0, 0.0, 0.0, 0.38, 1.0, 1.0, 0.38, 0.0, 0.0, 0.0, 0.0, 0.38, 1.0,
          1.0, 0.38, 0.0, 0.0, 0.0, 0.0, 0.38, 1.0, 1.0, 0.38, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
    "2": [0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0,
          0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0,
          0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0,
          0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
    "3": [0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0,
          0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0, 0.0,
          0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0,
          0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0,
          0.0, 0.0],
    "4": [0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
          1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0,
          1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0,
          0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0],
    "5": [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0,
          0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0,
          0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0,
          0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0],
    "6": [0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0,
          0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 0.0, 0.0,
          1.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0,
          0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0],
    "7": [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0,
          0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0,
          0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0,
          0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    "8": [0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0,
          0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0,
          0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0,
          0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0],
    "9": [0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0,
          0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0,
          0.0, 0.0, 1.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 0.0,
          0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0],
}

JS = """
async (b64) => {
  const img = new Image();
  img.src = 'data:image/jpeg;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const rows = [];
  for (let y = 0; y < c.height; y++) {
    const row = [];
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      row.push(Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114));
    }
    rows.push(row);
  }
  return { w: c.width, h: c.height, px: rows };
}
"""


def trim(m):
    rows = [i for i, r in enumerate(m) if any(r)]
    cols = [j for j in range(len(m[0])) if any(r[j] for r in m)]
    if not rows or not cols:
        return []
    return [r[cols[0]:cols[-1] + 1] for r in m[rows[0]:rows[-1] + 1]]


def norm(m):
    h, w = len(m), len(m[0])
    out = []
    for y in range(NH):
        sy = (y + 0.5) * h / NH - 0.5
        y0 = max(0, min(h - 1, int(sy)))
        y1 = max(0, min(h - 1, y0 + 1))
        fy = sy - int(sy) if 0 <= sy < h else 0.0
        for x in range(NW):
            sx = (x + 0.5) * w / NW - 0.5
            x0 = max(0, min(w - 1, int(sx)))
            x1 = max(0, min(w - 1, x0 + 1))
            fx = sx - int(sx) if 0 <= sx < w else 0.0
            v = (m[y0][x0] * (1 - fx) + m[y0][x1] * fx) * (1 - fy) + \\
                (m[y1][x0] * (1 - fx) + m[y1][x1] * fx) * fy
            out.append(v)
    return out


def classify(cell):
    m = trim(cell)
    if not m:
        return "?", 999.0
    f = norm(m)
    best = sorted(((sum((f[i] - t[i]) ** 2 for i in range(NW * NH)), d) for d, t in TPL.items()))
    return best[0][1], best[0][0]


def pixels(jpeg):
    async def run():
        from playwright.async_api import async_playwright
        async with async_playwright() as p:
            b = await p.chromium.launch(headless=True, args=["--no-sandbox"])
            pg = await b.new_page()
            await pg.goto("about:blank")
            data = await pg.evaluate(JS, base64.b64encode(jpeg).decode())
            await b.close()
            return data

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(run())
    finally:
        loop.close()


def attempt(keyword):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    page_url = BASE + "/auete4so.php?searchword=" + urllib.parse.quote(keyword)
    headers = {"User-Agent": UA, "Referer": BASE + "/"}
    opener.open(urllib.request.Request(page_url, headers=headers), timeout=20).read()
    cap_url = BASE + "/include/vdimgck.php?get=" + str(int(time.time() * 1000))
    cap = opener.open(urllib.request.Request(cap_url, headers=headers), timeout=20).read()

    data = pixels(cap)
    px, h = data["px"], data["h"]
    digits, confs = [], []
    for (x0, x1) in CELLS:
        cell = [[1 if px[y][x] < TH else 0 for x in range(x0, x1 + 1)] for y in range(h)]
        d, c = classify(cell)
        digits.append(d)
        confs.append(round(c, 2))
    if not all(d.isdigit() for d in digits) or max(confs) > 4.0:
        return {"ok": False, "why": "low_confidence", "digits": digits, "conf": confs}

    answer = str(int(digits[0]) + int(digits[1]))
    body = urllib.parse.urlencode({"validate": answer, "searchword": keyword}).encode()
    post_url = (BASE + "/auete4so.php?scheckAC=check&page=&searchtype=&order=&tid=&area=&year="
                "&letter=&yuyan=&state=&money=&ver=&jq=")
    req = urllib.request.Request(post_url, data=body, headers={
        "User-Agent": UA,
        "Referer": page_url,
        "Content-Type": "application/x-www-form-urlencoded",
    })
    html = opener.open(req, timeout=25).read().decode("utf-8", "ignore")
    session = ""
    for c in jar:
        if c.name == "PHPSESSID":
            session = c.value
    if "搜索限制" in html:
        return {"ok": False, "why": "rate_limited", "session": session}
    if "验证码不正确" in html or "系统安全验证" in html:
        return {"ok": False, "why": "captcha_wrong", "digits": digits}
    return {"ok": True, "session": session, "answer": "+".join(digits) + "=" + answer, "html": html}


def solve(keyword, tries=3):
    last = {"ok": False, "why": "no_attempt"}
    for _ in range(tries):
        try:
            last = attempt(keyword)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "why": type(exc).__name__ + ": " + str(exc)[:120]}
        if last.get("ok") or last.get("why") == "rate_limited":
            return last
        time.sleep(1.0)
    return last


def main():
    keyword = sys.argv[1] if len(sys.argv) > 1 else ""
    out = solve(keyword)
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
`;

const SESS_KEY = "auete:sess:v2";     // 已验证会话（PHPSESSID）
const TS_KEY = "auete:srch:ts:v2";    // 上次成功搜索时间戳
const RATE_GAP = 10500;               // 站点限制「10 秒一次」
const SESS_TTL = 10800; // 3 小时；失效时命中验证页会自动重解

async function cacheGet(key) {
  try {
    return await OmniBox.getCache(key);
  } catch (_) {
    return null;
  }
}

async function cachePut(key, value, ttl) {
  try {
    await OmniBox.setCache(key, String(value), ttl);
  } catch (_) {
    /* 缓存失败不影响主流程 */
  }
}

function ensureSolver() {
  try {
    if (!fs.existsSync(SOLVER_FILE) || fs.readFileSync(SOLVER_FILE, "utf8") !== SOLVER_SRC) {
      fs.writeFileSync(SOLVER_FILE, SOLVER_SRC, "utf8");
    }
    return true;
  } catch (error) {
    return false;
  }
}

// 返回 { ok, session, html, answer, why }
function runSolver(keyword) {
  const started = Date.now();
  if (!ensureSolver()) {
    return { ok: false, why: "写不了求解器文件（沙箱只读）" };
  }
  try {
    const out = execFileSync("python3", [SOLVER_FILE, keyword], {
      encoding: "utf8",
      timeout: 90000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const line = String(out || "").trim().split("\n").filter(Boolean).pop() || "{}";
    const data = JSON.parse(line);
    data.cost = Date.now() - started;
    return data;
  } catch (error) {
    return { ok: false, why: `求解器异常: ${String(error.message || error).slice(0, 120)}` };
  }
}

async function requestRaw(url, referer, extra = {}) {
  const res = await OmniBox.request(absUrl(url), {
    method: "GET",
    headers: { ...BASE_HEADERS, Referer: referer, ...extra },
  });
  const status = Number(res && res.statusCode);
  if (status !== 200) throw new Error(`HTTP ${status} @ ${url}`);
  return String((res && res.body) || "");
}

// 站点限制 10 秒一次，排队而不是直接失败
async function waitRateGap() {
  const ts = Number((await cacheGet(TS_KEY)) || 0);
  const gap = RATE_GAP - (Date.now() - ts);
  if (ts && gap > 0) {
    await logInfo(`search 距上次搜索 ${Math.round((Date.now() - ts) / 1000)}s，等 ${Math.ceil(gap / 1000)}s`);
    await sleep(gap);
  }
}

// 走站内搜索，拿不到就返回 null（由调用方回退本地扫描）
const COOKIE_SESSION = String(process.env.AU_COOKIE || "").replace(/^\s*PHPSESSID=/i, "").trim();

async function searchViaSite(keyword) {
  const session = COOKIE_SESSION || String((await cacheGet(SESS_KEY)) || "");
  if (session) {
    try {
      await waitRateGap();
      const html = await requestRaw(
        `/auete4so.php?searchword=${encodeURIComponent(keyword)}`,
        `${HOST}/`,
        { Cookie: `PHPSESSID=${session}` }
      );
      if (!/系统安全验证|搜索限制/.test(html)) {
        await cachePut(TS_KEY, Date.now(), 600);
        const list = parseCards(html);
        await logInfo(`search 已验证会话直取 keyword=${keyword} list=${list.length}`);
        return list;
      }
      await logInfo("search 会话已过期，重新识别验证码");
    } catch (error) {
      await logInfo(`search 会话直取失败: ${error.message}`);
    }
  }

  await waitRateGap();
  let solved = runSolver(keyword);
  if (!solved.ok && solved.why === "rate_limited") {
    await sleep(RATE_GAP);
    solved = runSolver(keyword);
  }
  if (!solved.ok) {
    await logInfo(`search 验证码识别失败: ${solved.why || "unknown"}${solved.digits ? " 识别为 " + solved.digits.join("+") : ""}`);
    if (solved.why === "rate_limited") await cachePut(TS_KEY, Date.now(), 600);
    return null;
  }
  if (solved.session) await cachePut(SESS_KEY, solved.session, SESS_TTL);
  await cachePut(TS_KEY, Date.now(), 600);
  const list = parseCards(String(solved.html || ""));
  await logInfo(`search 验证码已解 ${solved.answer || ""} 耗时=${solved.cost || 0}ms keyword=${keyword} list=${list.length}`);
  return list;
}


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

// ===== 封面 =====
// 站点自身的封面来自多个第三方图床，其中：
// - img3.doubanio.com 直连返回 418（防盗链），站点用 /img.php?url= 包一层，
//   但这个代理很不稳（同样 URL 多次请求会返回 200 + 0 字节）
// - pic.rmb.bdstatic.com 在部分网络下完全打不开（站点自己也会 fallback 到 loading.gif）
// 所以默认把这类封面转给 wsrv.nl 图片代理（它去取原图再回传，绕开防盗链与线路问题）。
// AU_IMG_PROXY=auto（默认）| wsrv | site | off
const IMG_PROXY = String(process.env.AU_IMG_PROXY || "off").trim().toLowerCase();
const IMG_BAIDU = /(bdstatic\.com|(^|\.)baidu\.com)/i;
// OmniBox 自带服务端图片代理：由 NAS 拉图再回给客户端，客户端网络再差也能显示
let IMG_BASE = "";

function setImgBase(context) {
  const base = String((context && context.baseURL) || "").replace(/\/+$/, "");
  if (base) IMG_BASE = base;
}

function unwrapImgProxy(url = "") {
  // 站点自带的 /img.php?url=<原图> 包装
  const m = String(url).match(/\/img\.php\?url=(.+)$/i);
  if (!m) return "";
  let inner = m[1];
  try {
    inner = decodeURIComponent(inner);
  } catch (_) {
    /* 没编码就直接用 */
  }
  if (!/^https?:\/\//i.test(inner)) inner = `https://${inner}`;
  return inner;
}

function toWsrv(url) {
  // output=jpg 是为了兼容不认 webp 的播放端，w=320 顺带把体积压下来
  return `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=320&output=jpg&q=80`;
}

// 服务端代理：/api/proxy/image?url=<原图>，由 OmniBox 自己把图拉回来
function serverProxy(url) {
  if (!IMG_BASE) return "";
  return `${IMG_BASE}/api/proxy/image?url=${encodeURIComponent(url)}`;
}

// 站点自己的脏数据：模板未渲染的 ${r.cover}、懒加载占位、以及已经 502 的图床
const IMG_JUNK = /(\$\{|\{r\.cover\}|loading\.gif|statics\/picture\/logo)/i;
const IMG_DEAD_HOST = /(vod\.dyttimage\.com)/i;

function finalizeImage(raw) {
  const abs = absUrl(raw);
  if (!abs) return "";
  if (IMG_JUNK.test(abs) || IMG_DEAD_HOST.test(abs)) return ""; // 宁可留空让客户端显示默认图
  if (IMG_PROXY === "off") return abs;
  const inner = unwrapImgProxy(abs);
  const target = inner || abs;
  if (IMG_PROXY === "site") return `${HOST}/img.php?url=${encodeURIComponent(target)}`;
  if (IMG_PROXY === "wsrv") return toWsrv(target);
  if (IMG_PROXY === "server") return serverProxy(target) || toWsrv(target);
  // auto：站点自己包过的（基本都是豆瓣图，直连 418、站点 img.php 稳定）原样保留；
  // 百度图床（pic.rmb.bdstatic.com 等）客户端常打不开，交给服务端代理拉图
  if (inner) return abs;
  if (IMG_BAIDU.test(target)) return serverProxy(target) || toWsrv(target);
  return target;
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
    const pic = finalizeImage($el.find("a.pic img, img").first().attr("src") || "");
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
  setImgBase(context);
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
  setImgBase(context);
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
  const vodPic = finalizeImage($('meta[property="og:image"]').attr("content") || $(".poster img").first().attr("src") || "");
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
  setImgBase(context);
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
  setImgBase(context);
  const page = Math.max(1, Number(params?.page || params?.pg || 1) || 1);
  const keyword = String(params?.wd || params?.keyword || params?.key || "").trim();
  if (!keyword) return { page, pagecount: 0, total: 0, list: [] };
  // 站内搜索本身一页就够（结果通常个位数），翻页直接回空，避免重复请求
  if (page > 1) return { page, pagecount: page, total: 0, list: [] };

  const hitKey = `auete:hit:v2:${keyword.toLowerCase()}`;
  const hit = await cacheGet(hitKey);
  if (hit) {
    try {
      const list = JSON.parse(String(hit));
      if (Array.isArray(list) && list.length) {
        await logInfo(`search 命中缓存 keyword=${keyword} list=${list.length}`);
        return { page: 1, pagecount: 1, total: list.length, list };
      }
    } catch (_) {
      /* 缓存坏了就当没命中 */
    }
  }

  try {
    const list = await searchViaSite(keyword);
    if (list && list.length) {
      await cachePut(hitKey, JSON.stringify(list), SEARCH_CACHE_TTL);
      return { page: 1, pagecount: 1, total: list.length, list };
    }
  } catch (error) {
    await logInfo(`search 站内搜索异常: ${error.message}`);
  }

  // 兜底：扫分类列表页做本地匹配（只覆盖最新内容，冷门老片搜不到）
  const all = await scanSearch(keyword, context);
  const pagecount = Math.max(1, Math.ceil(all.length / 30));
  const list = page > pagecount ? [] : all.slice((page - 1) * 30, page * 30);
  await logInfo(`search 本地扫描 keyword=${keyword} total=${all.length} list=${list.length}`);
  return { page, pagecount, total: all.length, list };
}

module.exports = { home, category, detail, search, play };
runner.run(module.exports);
