# -*- coding: utf-8 -*-
"""
AcFun 主 playInfo 端点爆破
前提（已由 probe_acfun.py 证实）：服务器不校验 sign，登录 token 有效。
目标：找出能返回 ac48537624 自己的 ksPlayJson（最好含 2160P120/H.265）的端点+参数。
仅发只读请求。
"""
import json, gzip, ssl, sys
import urllib.request, urllib.error
from urllib.parse import urlparse

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HAR_PATH = "Stream-2026-06-23 15_03_57.har"
RID, RTYPE, VID = "48537624", "2", "38844636"

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def load_template():
    """从 HAR 的 spriteVtt POST 请求取一套真实 App 头（含登录态）。"""
    with open(HAR_PATH, "r", encoding="utf-8") as f:
        entries = json.load(f)["log"]["entries"]
    for e in entries:
        if e["request"]["method"] == "POST" and "playInfo/spriteVtt" in e["request"]["url"]:
            headers = {}
            for h in e["request"]["headers"]:
                if h["name"].lower() in (":authority", ":method", ":path", ":scheme", "content-length"):
                    continue
                headers[h["name"]] = h["value"]
            host = urlparse(e["request"]["url"]).netloc
            return host, headers
    raise SystemExit("template not found")


HOST, HEADERS = load_template()


def call(method, path, body=None, qs=""):
    url = f"https://{HOST}{path}" + (("?" + qs) if qs else "")
    data = body.encode() if body else None
    req = urllib.request.Request(url, data=data, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=20) as resp:
            raw = resp.read()
            if resp.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            return resp.status, raw.decode("utf-8", "replace")
    except urllib.error.HTTPError as ex:
        return ex.code, ex.read().decode("utf-8", "replace")
    except Exception as ex:
        return None, f"ERR {type(ex).__name__}: {ex}"


def qualities(body):
    out = []
    try:
        d = json.loads(body)
    except Exception:
        return out

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k == "ksPlayJson" and isinstance(v, str):
                    try:
                        ks = json.loads(v)
                        out.append([r.get("qualityLabel") for r in ks["adaptationSet"][0]["representation"]])
                    except Exception:
                        pass
                else:
                    walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(d)
    return out


base = f"resourceId={RID}&resourceType={RTYPE}&videoId={VID}"
# 一些可能解锁 H.265/更高档的附加参数猜测
h265 = base + "&supportHevc=true&enableHevc=1&playUrlsKwaiPlay=1"

CANDIDATES = [
    ("POST", "/rest/app/play/playInfo/m3u8", base, ""),
    ("POST", "/rest/app/play/playInfo/v2", base, ""),
    ("POST", "/rest/app/play/playInfo", base, ""),
    ("POST", "/rest/app/play/playInfo/adaptiveM3u8", base, ""),
    ("POST", "/rest/app/play/getVideoPlayUrl", base, ""),
    ("GET",  "/rest/app/play/playInfo/m3u8", None, base),
    ("POST", "/rest/app/play/playInfo/m3u8", h265, ""),
    ("POST", "/rest/app/play/playInfo/mp4", base, ""),
    ("POST", "/rest/app/play/playInfo/adaptive", base, ""),
]

print(f"== host={HOST}  target ac{RID} ==\n")
report = []
for method, path, body, qs in CANDIDATES:
    st, b = call(method, path, body, qs)
    rc = None
    try:
        rc = json.loads(b).get("result")
    except Exception:
        pass
    q = qualities(b)
    tag = "  <== KS!" if q else ""
    extra = ("  body[:120]=" + b[:120].replace("\n", " ")) if (rc not in (0, None) or not q) else ""
    print(f"[{method} {path}{('?'+qs) if qs else ''}] http={st} result={rc} ks={len(q)}{tag}")
    if q:
        for ladder in q:
            print("      ->", ladder)
    elif st is not None:
        print("     ", b[:160].replace("\n", " "))
    report.append({"method": method, "path": path, "qs": qs, "body": body,
                   "http": st, "result": rc, "qualities": q, "body_head": b[:400]})

with open("probe2_result.json", "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print("\n== done -> probe2_result.json ==")
