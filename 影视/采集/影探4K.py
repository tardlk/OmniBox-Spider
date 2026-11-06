# -*- coding: utf-8 -*-
# @name 影探4K
# @key yt4k
# @type 4
# @api /video/yt4k
# @searchable 1
# @quickSearch 1
# @changeable 0
# @description 影探4K（lyyytv）：CMS 采集 + 解析接口，线路含腾讯/爱奇艺/优酷/B站/联通云/移动云；解析通道 5/6 自动择优，纯标准库 + 内置 AES，无需 pip 依赖
# @version 1.0.0
# @downloadURL https://gh-proxy.org/https://github.com/tardlk/OmniBox-Spider/raw/refs/heads/main/影视/采集/影探4K.py
#
# 移植自鱼壳 webhtv 版 影探4K.py：
#   1. 协议换成 OmniBox 的 home/category/detail/search/play
#   2. 去掉 requests / pycryptodome 依赖（HTTP 走 urllib，AES 自带实现）
#   3. 原版写死 parsesId=3（该通道已返回 500），改为候选列表择优并缓存命中项

import base64
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from spider_runner import OmniBox, run

HOST = 'http://cms.lyyytv.cn'
CMS_KEY = 'wP5bvxoc3yv7FoBQENFZuAF0EUYr4LTy'

# okhttp UA 是硬性要求：云盘直链换浏览器 UA + Referer 会 400
UA = 'okhttp/4.12.0'
HEADERS = {'User-Agent': UA}
PARSE_HEADERS = {'User-Agent': UA, 'Accept-Encoding': 'identity'}

# 解析通道：5 = 腾讯/爱奇艺/优酷/B站；6 = 联通云/移动云；其余为兜底
PARSE_API_TPL = 'http://fys.lyyytv.cn/api/index?parsesId=%s&appid=10001&videoUrl='
PARSE_IDS = (5, 6, 7, 1, 2, 3, 4)
_PARSE_HITS = []

DEC_PREFIX = 'https://baidu.con/'
PAGE_LIMIT = 18
HOME_CACHE_TTL = 6 * 3600
PLAY_CACHE_TTL = 120

FILTER_NAMES = {
    'class': '类型', 'area': '地区', 'lang': '语言', 'year': '年份',
    'letter': '字母', 'by': '排序', 'sort': '顺序',
}

_BASE64_RE = re.compile(r'(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?')
_LDMAX_RE = re.compile(r'^https?://ldmax\.cooom/', re.I)
_MEDIA_RE = re.compile(r'\.(?:mp4|m3u8?|flv|avi|mkv|ts|mov|wmv|webm|m4v|mpd)$', re.I)

_home_cache = {}
_play_cache = {}


# ==================== 基础工具 ====================

async def slog(level, message):
    """日志失败不能影响主流程（例如缺少 sourceId 时 SDK 会抛错）。"""
    try:
        await OmniBox.log(level, message)
    except Exception:
        pass


def text(value):
    return '' if value is None else str(value).strip()


def to_int(value, default=0):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def list_of(value):
    return value if isinstance(value, list) else []


def object_of(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except Exception:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def http_get(url, headers=None, timeout=15):
    """标准库 GET，返回 (状态码, 文本)。"""
    req = urllib.request.Request(url, headers=headers or HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as rsp:
            raw = rsp.read()
            return rsp.getcode(), raw.decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode('utf-8', 'replace')
        except Exception:
            body = ''
        return e.code, body
    except Exception:
        return 0, ''


def b64u_encode(obj):
    raw = json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def b64u_decode(value):
    s = text(value)
    if not s:
        return {}
    s += '=' * ((4 - len(s) % 4) % 4)
    try:
        return object_of(base64.urlsafe_b64decode(s.encode('ascii')).decode('utf-8', 'replace'))
    except Exception:
        return {}


# ==================== CMS ====================

def cms(path, params=None):
    params = params or {}
    query = urllib.parse.urlencode(params)
    url = '%s/api.php/app/%s?%s' % (HOST, path, query)
    status, body = http_get(url)
    if status != 200 or not body.strip():
        raise RuntimeError('影探4K：CMS 请求失败 HTTP %s' % status)
    data = object_of(body)
    if not data:
        raise RuntimeError('影探4K：CMS 未返回有效 JSON')
    code = data.get('code')
    if code is not None and to_int(code, -1) not in (1, 200):
        raise RuntimeError('影探4K：CMS 返回 code=%s msg=%s' % (code, data.get('msg')))
    return data


def map_vod(v):
    return {
        'vod_id': text(v.get('vod_id')),
        'vod_name': text(v.get('vod_name')),
        'vod_pic': text(v.get('vod_pic')),
        'type_id': text(v.get('type_id')),
        'type_name': text(v.get('type_name')),
        'vod_remarks': text(v.get('vod_remarks')),
        'vod_year': text(v.get('vod_year')),
        'vod_douban_score': text(v.get('vod_douban_score')),
    }


# ==================== 解密 ====================

def decode_base64(value):
    clean = re.sub(r'\s+', '', text(value))
    if not clean or not _BASE64_RE.fullmatch(clean):
        return None
    try:
        return base64.b64decode(clean)
    except Exception:
        return None


def decrypt_lvdou(value):
    """站点自家 lvdou+ 前缀：前 16 位 key / 后 16 位 iv，AES-CBC/PKCS7。"""
    original = text(value)
    if not original.startswith('lvdou+'):
        return original
    try:
        encrypted = decode_base64(original[6:])
        if not encrypted:
            return original
        key = CMS_KEY[:16].encode('utf-8')
        iv = CMS_KEY[16:32].encode('utf-8') if len(CMS_KEY) >= 32 else key
        result = aes_cbc_decrypt(key, iv, encrypted).decode('utf-8', 'replace').strip()
        if result.startswith('http'):
            return result
    except Exception:
        pass
    return original


def decrypt_ldmax(value, depth=0):
    """老加密：ldmax.cooom 前缀，key = 前 16 位倒序，iv 同 key。"""
    if depth > 5:
        return ''
    url = text(value)
    decoded = decode_base64(url)
    if decoded:
        url = re.sub(r'\s+', '', decoded.decode('utf-8', 'replace'))
    if not _LDMAX_RE.match(url):
        return url
    path = _LDMAX_RE.sub('', url)
    if len(path) <= 16:
        return ''
    try:
        key = path[:16][::-1].encode('utf-8')
        encrypted = decode_base64(path[16:])
        if not encrypted or len(encrypted) % 16:
            return ''
        result = aes_cbc_decrypt(key, key, encrypted).decode('utf-8', 'replace').strip()
        return decrypt_ldmax(result, depth + 1) if _LDMAX_RE.match(result) else result
    except Exception:
        return ''


def is_http_url(value):
    try:
        parsed = urllib.parse.urlparse(text(value))
        return parsed.scheme in ('http', 'https') and bool(parsed.netloc)
    except Exception:
        return False


def find_url(value):
    if not isinstance(value, dict):
        return ''
    for key in ('url', 'playUrl', 'link'):
        if value.get(key):
            return text(value.get(key))
    return find_url(value.get('data'))


def resolve_parse(body):
    """解析接口响应 → 真实地址。支持 JSON 包裹 / baidu.con 前缀密文 / 明文。"""
    body = text(body)
    if not body or body.startswith('<'):
        return ''

    candidate = body
    if body.startswith('{'):
        try:
            found = find_url(json.loads(body))
            if found:
                candidate = found
        except Exception:
            pass

    if candidate.startswith(DEC_PREFIX):
        rest = candidate[len(DEC_PREFIX):]
        if len(rest) <= 16:
            return ''
        key = rest[:16].encode('utf-8')
        for raw in (decode_base64(rest[16:]), rest[16:].encode('latin-1', 'ignore')):
            if not raw or len(raw) % 16:
                continue
            try:
                result = aes_cbc_decrypt(key, key, raw).decode('utf-8', 'replace').strip()
                if result.startswith('http'):
                    return result
            except Exception:
                continue
        return ''

    return candidate if candidate.startswith('http') else ''


def remember_hit(pid):
    if pid in _PARSE_HITS:
        _PARSE_HITS.remove(pid)
    _PARSE_HITS.insert(0, pid)


def parse_url(raw):
    """按候选 parsesId 依次尝试，解出真实播放地址。"""
    if not raw:
        return ''
    query = urllib.parse.quote(raw, safe="!'()*")
    order = list(dict.fromkeys(list(_PARSE_HITS) + list(PARSE_IDS)))
    for pid in order:
        target = (PARSE_API_TPL % pid) + query
        for _ in (0, 1):
            status, body = http_get(target, PARSE_HEADERS, timeout=30)
            if status != 200 or not body:
                break  # 5xx 通道坏了，直接换下一个 id
            resolved = resolve_parse(body)
            if resolved and resolved.startswith('http') and DEC_PREFIX not in resolved:
                remember_hit(pid)
                return resolved
            break
    return ''


# ==================== handlers ====================

async def home(params, context):
    try:
        cached = _home_cache.get('home')
        if cached and cached[0] > time.time():
            return cached[1]

        data = cms('nav', {'token': ''})
        classes = []
        filters = {}
        for item in list_of(data.get('list')):
            if not isinstance(item, dict) or item.get('type_id') is None:
                continue
            name = text(item.get('type_name'))
            if not name:
                continue
            tid = text(item['type_id'])
            classes.append({'type_id': tid, 'type_name': name})

            ext = object_of(item.get('type_extend'))
            groups = []
            for key, label in FILTER_NAMES.items():
                values = [v for v in (text(x) for x in text(ext.get(key)).split(',')) if v]
                values = list(dict.fromkeys(values))
                if values:
                    groups.append({
                        'key': key,
                        'name': label,
                        'init': '',
                        'value': [{'n': '全部', 'v': ''}] + [{'n': v, 'v': v} for v in values],
                    })
            if groups:
                filters[tid] = groups

        vlist = []
        try:
            idx = cms('index_video', {'token': ''})
            for block in list_of(idx.get('list')):
                if isinstance(block, dict):
                    vlist.extend([map_vod(v) for v in list_of(block.get('vlist')) if isinstance(v, dict)])
        except Exception as e:
            await slog('warn', '[影探4K] 首页推荐失败: %s' % e)

        result = {'class': classes, 'filters': filters, 'list': vlist}
        if classes:
            _home_cache['home'] = (time.time() + HOME_CACHE_TTL, result)
        return result
    except Exception as e:
        await slog('error', '[影探4K] home 失败: %s' % e)
        return {'class': [], 'filters': {}, 'list': []}


async def category(params, context):
    page = max(1, to_int(params.get('page') or params.get('pg') or 1, 1))
    tid = text(params.get('categoryId') or params.get('typeId') or params.get('tid'))
    extend = params.get('filters') or params.get('extend') or {}
    if not isinstance(extend, dict):
        extend = {}
    if not tid:
        return {'page': 1, 'pagecount': 0, 'total': 0, 'list': []}

    try:
        query = {'tid': tid, 'pg': str(page), 'limit': str(PAGE_LIMIT)}
        for key in FILTER_NAMES:
            value = text(extend.get(key))
            if value and value != 'all':
                query[key] = value
        data = cms('video', query)
        lst = [map_vod(v) for v in list_of(data.get('list')) if isinstance(v, dict)]
        pagecount = to_int(data.get('pagecount'))
        if pagecount <= 0:
            pagecount = page + (1 if len(lst) >= PAGE_LIMIT else 0)
        total = to_int(data.get('total'), (page - 1) * PAGE_LIMIT + len(lst))
        return {'page': page, 'pagecount': pagecount, 'total': total, 'list': lst}
    except Exception as e:
        await slog('error', '[影探4K] category 失败: %s' % e)
        return {'page': page, 'pagecount': 0, 'total': 0, 'list': []}


async def search(params, context):
    keyword = text(params.get('keyword') or params.get('wd'))
    page = max(1, to_int(params.get('page') or 1, 1))
    if not keyword:
        return {'page': 1, 'pagecount': 0, 'total': 0, 'list': []}

    try:
        data = cms('search', {'text': keyword, 'pg': str(page)})
        lst = [map_vod(v) for v in list_of(data.get('list')) if isinstance(v, dict)]
        pagecount = to_int(data.get('pagecount'))
        if pagecount <= 0:
            pagecount = page + (1 if len(lst) >= PAGE_LIMIT else 0)
        total = to_int(data.get('total'), (page - 1) * PAGE_LIMIT + len(lst))
        return {'page': page, 'pagecount': pagecount, 'total': total, 'list': lst}
    except Exception as e:
        await slog('error', '[影探4K] search 失败: %s' % e)
        return {'page': page, 'pagecount': 0, 'total': 0, 'list': []}


async def detail(params, context):
    video_id = text(params.get('videoId') or params.get('id'))
    if not video_id:
        return {'list': []}

    try:
        data = object_of(cms('video_detail', {'id': video_id}).get('data'))
        if not data:
            return {'list': []}

        players = data.get('vod_url_with_player')
        if isinstance(players, list):
            sources = players
        else:
            names = text(data.get('vod_play_from')).split('$$$')
            sources = [
                {'name': names[i] if i < len(names) else '', 'url': u}
                for i, u in enumerate(text(data.get('vod_play_url')).split('$$$'))
            ]

        play_sources = []
        for index, source in enumerate(sources):
            if not isinstance(source, dict):
                continue
            line_name = text(source.get('name')) or text(source.get('code')) or ('线路%d' % (index + 1))
            episodes = []
            for entry in text(source.get('url')).split('#'):
                sep = entry.find('$')
                if sep <= 0:
                    continue
                ep_name = text(entry[:sep])
                ep_url = decrypt_lvdou(entry[sep + 1:])
                if not ep_name or not ep_url:
                    continue
                episodes.append({
                    'name': ep_name,
                    'playId': b64u_encode({'u': ep_url, 'f': line_name, 'n': ep_name}),
                })
            if episodes:
                play_sources.append({'name': re.sub(r'[$#]', ' ', line_name), 'episodes': episodes})

        vod = map_vod(data)
        vod.update({
            'vod_content': text(data.get('vod_content')),
            'vod_actor': text(data.get('vod_actor')),
            'vod_director': text(data.get('vod_director')),
            'vod_area': text(data.get('vod_area')),
        })
        if play_sources:
            vod['vod_play_sources'] = play_sources
        return {'list': [vod]}
    except Exception as e:
        await slog('error', '[影探4K] detail 失败: %s' % e)
        return {'list': []}


async def play(params, context):
    flag = text(params.get('flag'))
    meta = b64u_decode(params.get('playId') or params.get('id'))
    raw = text(meta.get('u'))
    if not raw:
        # 兼容直接传明文地址
        candidate = text(params.get('playId') or params.get('id'))
        raw = candidate if is_http_url(candidate) else ''
    if not flag:
        flag = text(meta.get('f')) or '影探4K'

    empty = {'parse': 0, 'urls': [], 'header': dict(PARSE_HEADERS)}
    if not raw:
        await slog('error', '[影探4K] play 缺少地址')
        return empty

    try:
        target = decrypt_lvdou(raw)
        if _LDMAX_RE.match(target):
            target = decrypt_ldmax(target) or target

        cache_key = '%s|%s' % (flag, target)
        cached = _play_cache.get(cache_key)
        if cached and cached[0] > time.time():
            return {'parse': 0, 'urls': [{'name': flag, 'url': cached[1]}], 'header': dict(PARSE_HEADERS)}

        started = time.time()
        resolved = parse_url(target)
        if not resolved:
            await slog('error', '[影探4K] play 解析失败 flag=%s url=%s' % (flag, target[:80]))
            return empty

        _play_cache[cache_key] = (time.time() + PLAY_CACHE_TTL, resolved)
        await slog('info', '[影探4K] play 成功 flag=%s %.1fs %s' % (flag, time.time() - started, resolved[:80]))
        return {'parse': 0, 'urls': [{'name': flag, 'url': resolved}], 'header': dict(PARSE_HEADERS)}
    except Exception as e:
        await slog('error', '[影探4K] play 异常: %s' % e)
        return empty


# ==================== AES-CBC 解密（无第三方依赖）====================

def _xtime(a):
    a <<= 1
    if a & 0x100:
        a ^= 0x11B
    return a & 0xFF


def _mul(a, b):
    r = 0
    while b:
        if b & 1:
            r ^= a
        a = _xtime(a)
        b >>= 1
    return r


def _build_tables():
    exp = [0] * 512
    log = [0] * 256
    x = 1
    for i in range(255):
        exp[i] = x
        log[x] = i
        x = _mul(x, 3)
    for i in range(255, 512):
        exp[i] = exp[i - 255]

    sbox = [0] * 256
    for a in range(256):
        b = 0 if a == 0 else exp[255 - log[a]]
        s = b
        r = b
        for _ in range(4):
            r = ((r << 1) | (r >> 7)) & 0xFF
            s ^= r
        sbox[a] = s ^ 0x63
    inv = [0] * 256
    for i, v in enumerate(sbox):
        inv[v] = i
    return sbox, inv, [_mul(i, 0x09) for i in range(256)], [_mul(i, 0x0B) for i in range(256)], \
        [_mul(i, 0x0D) for i in range(256)], [_mul(i, 0x0E) for i in range(256)]


_SBOX, _INV_SBOX, _M9, _M11, _M13, _M14 = _build_tables()


def _expand_key(key):
    nk = len(key) // 4
    nr = nk + 6
    w = [list(key[4 * i:4 * i + 4]) for i in range(nk)]
    rcon = 1
    for i in range(nk, 4 * (nr + 1)):
        t = list(w[i - 1])
        if i % nk == 0:
            t = t[1:] + t[:1]
            t = [_SBOX[b] for b in t]
            t[0] ^= rcon
            rcon = _xtime(rcon)
        elif nk > 6 and i % nk == 4:
            t = [_SBOX[b] for b in t]
        w.append([w[i - nk][j] ^ t[j] for j in range(4)])
    return w, nr


def _decrypt_block(block, w, nr):
    s = [[block[r + 4 * c] for r in range(4)] for c in range(4)]

    def add_round_key(rnd):
        for c in range(4):
            for r in range(4):
                s[c][r] ^= w[rnd * 4 + c][r]

    add_round_key(nr)
    for rnd in range(nr - 1, -1, -1):
        for r in range(1, 4):
            row = [s[c][r] for c in range(4)]
            row = row[-r:] + row[:-r]
            for c in range(4):
                s[c][r] = row[c]
        for c in range(4):
            for r in range(4):
                s[c][r] = _INV_SBOX[s[c][r]]
        add_round_key(rnd)
        if rnd:
            for c in range(4):
                a0, a1, a2, a3 = s[c]
                s[c][0] = _M14[a0] ^ _M11[a1] ^ _M13[a2] ^ _M9[a3]
                s[c][1] = _M9[a0] ^ _M14[a1] ^ _M11[a2] ^ _M13[a3]
                s[c][2] = _M13[a0] ^ _M9[a1] ^ _M14[a2] ^ _M11[a3]
                s[c][3] = _M11[a0] ^ _M13[a1] ^ _M9[a2] ^ _M14[a3]
    out = bytearray(16)
    for c in range(4):
        for r in range(4):
            out[4 * c + r] = s[c][r]
    return bytes(out)


def aes_cbc_decrypt(key, iv, data):
    """AES-CBC 解密并去除 PKCS7 填充。"""
    if not data:
        return b''
    w, nr = _expand_key(key)
    prev = iv
    out = bytearray()
    for i in range(0, len(data) - len(data) % 16, 16):
        block = data[i:i + 16]
        plain = _decrypt_block(block, w, nr)
        out.extend(bytes(a ^ b for a, b in zip(plain, prev)))
        prev = block
    if not out:
        return b''
    pad = out[-1]
    if 0 < pad <= 16 and pad <= len(out):
        out = out[:-pad]
    return bytes(out)


if __name__ == '__main__':
    run({'home': home, 'category': category, 'detail': detail, 'search': search, 'play': play})
