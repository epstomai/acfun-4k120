# -*- coding: utf-8 -*-
"""
AcFun App 接口探针
目的：
  1) 验证 HAR 里捕获的登录凭据是否仍然有效
  2) 实测 AcFun App 读接口是否真的校验 `sign` 头
     -> 若"篡改 sign 后仍 200"，则证明 sign 无需逆向，整个方案大幅简化
  3) 预留：尝试候选 playInfo 端点，dump 任何 ksPlayJson 的清晰度阶梯

用法：
  python probe_acfun.py

说明：
  - 脚本直接读取同目录下的 HAR，重放其中已捕获的真实请求（不伪造任何字段），
    因此是对"当前凭据/sign 校验"的忠实测试。
  - 只发只读请求（spriteVtt 缩略图、feed 相关推荐），不做任何写操作。
"""
import json
import gzip
import ssl
import sys
import urllib.request
import urllib.error
from urllib.parse import urlparse

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HAR_PATH = "Stream-2026-06-23 15_03_57.har"
REPORT = []   # 收集详细结果，最后写入 UTF-8 文件
TARGET_AC = 48537624          # 4K120 样本视频 ac号
SPRITE_PATH = "/rest/app/play/playInfo/spriteVtt"  # 已捕获、属于目标视频的小请求，用于 sign 校验测试

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def load_har():
    with open(HAR_PATH, "r", encoding="utf-8") as f:
        return json.load(f)["log"]["entries"]


def find_entry(entries, method, path_contains):
    for e in entries:
        if e["request"]["method"] == method and path_contains in urlparse(e["request"]["url"]).path:
            return e
    return None


def build_request(entry, sign_override=None, body_override=None):
    req = entry["request"]
    url = req["url"]
    headers = {}
    for h in req["headers"]:
        name = h["name"]
        if name.lower() in (":authority", ":method", ":path", ":scheme", "content-length"):
            continue
        headers[name] = h["value"]
    if sign_override is not None:
        # 找到原 sign 头的真实键名（大小写无关）并覆盖
        key = next((k for k in headers if k.lower() == "sign"), "sign")
        headers[key] = sign_override
    data = None
    if req.get("postData"):
        text = body_override if body_override is not None else req["postData"].get("text", "")
        data = text.encode("utf-8")
    return url, headers, data


def result_code(body):
    try:
        return json.loads(body).get("result")
    except Exception:
        return None


def do(url, headers, data, label):
    method = "POST" if data is not None else "GET"
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, context=ctx, timeout=20) as resp:
            raw = resp.read()
            if resp.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            body = raw.decode("utf-8", "replace")
            rc = result_code(body)
            print(f"[{label}] HTTP {resp.status} len={len(body)} result={rc}")
            REPORT.append({"label": label, "http": resp.status, "len": len(body),
                           "result": rc, "body_head": body[:800]})
            return resp.status, body
    except urllib.error.HTTPError as ex:
        b = ex.read().decode("utf-8", "replace")
        print(f"[{label}] HTTP {ex.code} (HTTPError) len={len(b)}")
        REPORT.append({"label": label, "http": ex.code, "len": len(b),
                       "result": result_code(b), "body_head": b[:800]})
        return ex.code, b
    except Exception as ex:
        print(f"[{label}] ERROR {type(ex).__name__}: {ex}")
        REPORT.append({"label": label, "error": f"{type(ex).__name__}: {ex}"})
        return None, ""


def show_qualities(body):
    """在响应里挖出所有 ksPlayJson 的清晰度标签。"""
    try:
        data = json.loads(body)
    except Exception:
        print("    (非 JSON 响应)")
        return
    found = []

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k == "ksPlayJson" and isinstance(v, str):
                    try:
                        ks = json.loads(v)
                        reps = ks["adaptationSet"][0]["representation"]
                        found.append([r.get("qualityLabel") for r in reps])
                    except Exception:
                        pass
                else:
                    walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(data)
    if found:
        for i, labels in enumerate(found):
            print(f"    ksPlayJson[{i}] -> {labels}")
    else:
        print("    (响应中无 ksPlayJson)")


def main():
    entries = load_har()
    print("== load HAR: %d entries ==\n" % len(entries))

    sprite = find_entry(entries, "POST", SPRITE_PATH)
    if not sprite:
        print("spriteVtt request not found")
        return

    # TEST 1: replay spriteVtt as-is -> credentials still valid?
    print("[TEST 1] replay spriteVtt as-is (target ac%d) -> creds valid?" % TARGET_AC)
    url, headers, data = build_request(sprite)
    st1, b1 = do(url, headers, data, "orig-sign")
    rc1 = result_code(b1)
    creds_ok = (rc1 == 0) or ("WEBVTT" in b1)
    print("   -> creds VALID" if creds_ok else "   -> creds EXPIRED/REJECTED")
    print()

    # TEST 2: tamper sign -> is sign validated?
    print("[TEST 2] replay same request with TAMPERED sign -> is sign checked?")
    url, headers, data = build_request(sprite, sign_override="00000000000000000000000000000000000000000000dead")
    st2, b2 = do(url, headers, data, "tampered-sign")
    rc2 = result_code(b2)
    if creds_ok and rc2 == 0 and "WEBVTT" in b2:
        verdict = "SIGN NOT VALIDATED -> no need to reverse sign; login-token is enough"
    elif creds_ok and rc2 != 0:
        verdict = "SIGN VALIDATED (tampered -> result=%s) -> must reverse sign (APK route)" % rc2
    else:
        verdict = "INCONCLUSIVE (baseline failed; creds may be expired -> re-capture)"
    print("   -> " + verdict)
    print()

    # TEST 3: also try WITHOUT any sign header at all
    print("[TEST 3] replay spriteVtt with sign header REMOVED entirely")
    url, headers, data = build_request(sprite)
    for k in [k for k in headers if k.lower() == "sign"]:
        headers.pop(k)
    st3, b3 = do(url, headers, data, "no-sign")
    rc3 = result_code(b3)
    print("   -> no-sign result=%s (%s)" % (rc3, "OK" if rc3 == 0 else "rejected"))
    print()

    # TEST 4: related feed (embeds ksPlayJson) -> see quality ladder it returns
    print("[TEST 4] replay related-feed as-is -> quality ladders in ksPlayJson")
    feed = find_entry(entries, "GET", "/rest/app/feed/related/general")
    if feed:
        url, headers, data = build_request(feed)
        st4, b4 = do(url, headers, data, "feed")
        if result_code(b4) == 0:
            show_qualities(b4)

    with open("probe_result.json", "w", encoding="utf-8") as f:
        json.dump({"verdict": verdict, "creds_ok": creds_ok, "details": REPORT},
                  f, ensure_ascii=False, indent=2)
    print("\n== done. full report -> probe_result.json ==")


if __name__ == "__main__":
    main()
