# -*- coding: utf-8 -*-
"""
AcFun 4K120FPS 视频下载脚本
功能：
  1. 输入 AC号 (例如 48537624 或 ac48537624)
  2. 自动从 AcFun 网页获取其 videoId
  3. 使用 App 级凭据与 mkey 构造 GET 播放接口，获取最高支持 4K120 帧的 m3u8 地址
  4. 生成或直接调用 ffmpeg 进行高速下载与合并

使用方法：
  python download_4k120.py
  或指定参数：
  python download_4k120.py --ac 48537624
"""

import os
import re
import ssl
import json
import argparse
import subprocess
import urllib.request
import urllib.parse
import gzip

# ==================== 配置区 ====================
# 从抓包中提取的有效凭据 (AcFun App 登录态)
LOGIN_HEADERS = {
  "Host": "api-ipv6.app.acfun.cn",
  "Cookie": "acfun.midground.api_st=ChZhY2Z1bi5taWRncm91bmQuYXBpLnN0EmCn4jUrL9iye3pefvHrQ9WnWgkKnB8D14QDVNxVAyKu8rCCYGi2h83Bas8WsAT0aV1vJWeLtreiNEmmCeBomqMwfEI4nDDkDoiqdgeOE3Wm-MXzlslSY9gy9uNMLlxVzF4aEkBpOCosC8J4j5gogsgfZQW7ESIg-hOJedTrSqDecCXg_2Sk3EhOVIoShHopOHPLPmQrsvcoBTAB; acPasstoken=ChVpbmZyYS5hY2Z1bi5wYXNzdG9rZW4ScGW91IPYeLDQp7ukVWeNrrHg4vhtjUaGjm8_QywbRNFx_R6crVODEV8nxRvmPHh2W-b9stsRlGlHuao6IeyPU-82XW25uzD9cckwB_xiFZvr9kOLJYPDfH8TPkeAipV6HCxVJQY1bxUMK54z_iXaB2kaEnfcCHKF_CPUPpmjyzdSlISnMCIgN8nRaDyCaqjrOOJ0wfNg4FDXQfqNwRHs8Jtj6KO9MFYoBTAB; auth_key=472630; did=225D4030-819A-41FE-8A77-96B578539C3B; old_token=5c4146a3945fab2b7376cd51e3e6a46e; userId=472630; __NSWJ=; acPasstoken=ChVpbmZyYS5hY2Z1bi5wYXNzdG9rZW4ScGW91IPYeLDQp7ukVWeNrrHg4vhtjUaGjm8_QywbRNFx_R6crVODEV8nxRvmPHh2W-b9stsRlGlHuao6IeyPU-82XW25uzD9cckwB_xiFZvr9kOLJYPDfH8TPkeAipV6HCxVJQY1bxUMK54z_iXaB2kaEnfcCHKF_CPUPpmjyzdSlISnMCIgN8nRaDyCaqjrOOJ0wfNg4FDXQfqNwRHs8Jtj6KO9MFYoBTAB; appver=6.80.0.639; auth_key=472630; countryCode=--; did=225D4030-819A-41FE-8A77-96B578539C3B; gid=DFP34EEDFF0C49FB350D7BA5AFDF3F357A2A0452B490B558728D493FA557F400; kpf=IPHONE; kpn=ACFUN_APP; language=zh-Hans-CN; mcc=6553565535; mod=iPhone13%2C4; net=WIFI; old_token=5c4146a3945fab2b7376cd51e3e6a46e; sys=iOS_27.0; userId=472630; ver=6.80; _did=H5_35919160772CF16B",
  "language": "zh-Hans-CN;q=1, en-CN;q=0.9, ja-CN;q=0.8",
  "User-Agent": "AcFun/6.80.0 (iPhone; iOS 27.0; Scale/3.00)",
  "random": "FA77102B-4A5D-405B-9925-B2AB2C3A12D0",
  "deviceType": "0",
  "market": "appstore",
  "url_page": "SEARCH",
  "appVersion": "6.80.0.639",
  "resolution": "1284x2778",
  "acPlatform": "IPHONE",
  "udid": "225D4030-819A-41FE-8A77-96B578539C3B",
  "sign": "8e9fc9dcc55b22d9f3c6c5c47e6b08d648f1e7b6dbd7d9cf",
  "net": "--_5",
  "token": "CAESDTE3ODIxOTgwNDgxNTY=",
  "uid": "472630",
  "mod": "iPhone13,4",
  "Accept-Language": "zh-Hans-CN;q=1, en-CN;q=0.9, ja-CN;q=0.8",
  "productId": "2000",
  "isChildPattern": "false",
  "gid": "DFPC870558EC1698DE46E673C0BEB8EDFF6A584C2FDBF0D55795485279B17289",
  "Accept": "application/json",
  "access_token": "5c4146a3945fab2b7376cd51e3e6a46e",
  "idfa": "225D4030-819A-41FE-8A77-96B578539C3B"
}

# 抓包提取的可复用安全凭证 mkey (用于解密与授权播放流)
MKEY = "AAHewK3eIAAzMDg2MzYxMjABzwcAMEP1uwRyiq6JYAAAAE20aF4wmPvQBtcZ0r4c\r\nnIUT4GLvHxUN2JjBFJHUQEpYu3QmUiGDFCOEPhAG0swbNGJj_NUHNu4TMQOQQIX8\r\nFe-l8JuMJiSdemqF2oRknrJ46ki8gUYscTvjYvuU3Y6Kgg=="

# =================================================

# 禁用 SSL 验证
ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE

def get_video_id(ac_id):
    """通过网页抓取 AC号 对应的 videoId"""
    url = f"https://www.acfun.cn/v/ac{ac_id}"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    )
    try:
        with urllib.request.urlopen(req, context=ssl_ctx, timeout=10) as resp:
            html = resp.read().decode("utf-8", "replace")
        
        match = re.search(r'"currentVideoId"\s*:\s*(\d+)', html)
        if match:
            return match.group(1)
            
        match_fallback = re.search(r'videoId\s*:\s*(\d+)', html)
        if match_fallback:
            return match_fallback.group(1)
            
        return None
    except Exception as e:
        print(f"[-] 抓取 videoId 失败: {e}")
        return None

def fetch_play_info(ac_id, video_id):
    """请求 App 独占的 m3u8V2 播放接口获取清晰度阶梯"""
    params = {
        "videoId": video_id,
        "resourceId": ac_id,
        "resourceType": "2",
        "mkey": MKEY,
        
        # 激活 H.265/HEVC、KwaiPlay 及高画质
        "supportHevc": "true",
        "enableHevc": "1",
        "playUrlsKwaiPlay": "1",
        "playType": "2",
        
        # App 公共路由参数
        "market": "appstore",
        "app_version": "6.80.0.639",
        "product": "ACFUN_APP",
        "origin": "ios",
        "egid": "DFPC870558EC1698DE46E673C0BEB8EDFF6A584C2FDBF0D55795485279B17289",
        "sys_name": "ios",
        "npr": "0",
        "sys_version": "27.0",
        "resolution": "1284x2778",
        "access_token": "5c4146a3945fab2b7376cd51e3e6a46e"
    }
    
    query_str = urllib.parse.urlencode(params)
    url = f"https://api-ipv6.app.acfun.cn/rest/app/play/playInfo/m3u8V2?{query_str}"
    
    req = urllib.request.Request(url, headers=LOGIN_HEADERS, method="GET")
    
    try:
        with urllib.request.urlopen(req, context=ssl_ctx, timeout=15) as resp:
            raw = resp.read()
            if resp.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            data = json.loads(raw.decode("utf-8", "replace"))
            return data
    except Exception as e:
        print(f"[-] 请求播放接口失败: {e}")
        return None

def main():
    parser = argparse.ArgumentParser(description="AcFun 4K120 视频下载器")
    parser.add_argument("--ac", type=str, help="视频 AC 号 (如 48537624)")
    args = parser.parse_args()
    
    ac_input = args.ac
    if not ac_input:
        ac_input = input("请输入 AcFun 视频 AC 号 (如 48537624): ").strip()
        
    # 提取数字
    ac_match = re.search(r'\d+', ac_input)
    if not ac_match:
        print("[-] 输入的 AC 号不合法")
        return
    ac_id = ac_match.group(0)
    
    print(f"[*] 正在解析 AC{ac_id} ...")
    video_id = get_video_id(ac_id)
    if not video_id:
        print("[-] 无法获取该视频的 videoId，请确认该视频是否存在。")
        return
    print(f"[+] 成功获取 videoId: {video_id}")
    
    print("[*] 正在向 App 接口获取播放流链接...")
    play_data = fetch_play_info(ac_id, video_id)
    if not play_data or play_data.get("result") != 0:
        err_msg = play_data.get("error_msg", "未知网络错误") if play_data else "网络连接失败"
        print(f"[-] 播放请求失败: {err_msg}")
        print("[!] 提示: 如果返回错误，可能是由于播放请求频率限制导致。请等待 1-2 分钟后再试。")
        return
        
    play_info = play_data.get("playInfo")
    if not play_info:
        print("[-] 未能获取到有效的播放信息 (playInfo 为 null)。")
        print("[!] 提示: 大概率触发了短时间内的接口防刷限制。请等待 1 分钟后重新运行此脚本。")
        return
        
    ks_play_json_str = play_info.get("ksPlayJson")
    if not ks_play_json_str:
        print("[-] 响应中不含播放地址详情 (ksPlayJson)。")
        return
        
    if isinstance(ks_play_json_str, str):
        ks_play_json = json.loads(ks_play_json_str)
    else:
        ks_play_json = ks_play_json_str
        
    # 获取所有的 representation 流信息
    try:
        reps = ks_play_json["adaptationSet"][0]["representation"]
    except (KeyError, IndexError):
        print("[-] 无法解析播放流的 adaptationSet 格式。")
        return
        
    print(f"\n[+] 成功解析到 {len(reps)} 个播放清晰度流:")
    target_rep = None
    
    for idx, r in enumerate(reps):
        label = r.get("qualityLabel", "未知")
        q_type = r.get("qualityType", "")
        codec = r.get("codecType", "H.264")
        fps = r.get("frameRate", 30)
        avg_bitrate = r.get("avgBitrate", 0)
        print(f"  [{idx}] {label} ({q_type}) | Codec: {codec} | FPS: {fps:.2f} | 码率: {avg_bitrate}kbps")
        
        # 优先寻找 2160p120 流作为最高目标
        if q_type == "2160p120" and not target_rep:
            target_rep = r
            
    # 如果没找到 2160p120，选择默认第一项 (通常是最高清晰度)
    if not target_rep and reps:
        target_rep = reps[0]
        print(f"[!] 未找到专属 2160P120 直链，将默认下载最高清晰度: {target_rep.get('qualityLabel')}")
        
    if not target_rep:
        print("[-] 无法找到任何可下载的流地址。")
        return
        
    m3u8_url = target_rep.get("url")
    if not m3u8_url:
        print("[-] 播放流地址为空。")
        return
        
    print(f"\n[*] 已锁定目标流: {target_rep.get('qualityLabel')} (FPS: {target_rep.get('frameRate'):.2f})")
    print(f"[*] M3U8 直链: {m3u8_url}\n")
    
    # 构造 ffmpeg 命令 (传递 APP 原生 UA 以防防盗链)
    ua = LOGIN_HEADERS.get("User-Agent", "AcFun/6.80.0 (iPhone; iOS 27.0; Scale/3.00)")
    out_filename = f"ac{ac_id}_{target_rep.get('qualityType')}.mp4"
    
    ffmpeg_cmd = [
        "ffmpeg",
        "-headers", f"User-Agent: {ua}\r\n",
        "-i", m3u8_url,
        "-c", "copy",
        out_filename
    ]
    
    cmd_str = f'ffmpeg -headers "User-Agent: {ua}" -i "{m3u8_url}" -c copy "{out_filename}"'
    print("[+] 生成的 ffmpeg 下载命令:")
    print(f"    {cmd_str}\n")
    
    choice = input(f"是否立刻启动 ffmpeg 下载该视频并保存为 '{out_filename}'？(y/n): ").strip().lower()
    if choice == 'y':
        print(f"[*] 启动 ffmpeg 下载中... 文件将保存为 {out_filename}")
        try:
            # 启动并显示进度
            subprocess.run(ffmpeg_cmd, check=True)
            print(f"[+] 下载合并完成！已存为 {out_filename}")
        except FileNotFoundError:
            print("[-] 未在系统中检测到 ffmpeg，请先安装 ffmpeg 并将其添加到 PATH 环境变量中。")
            print("[-] 您也可以复制上面的 ffmpeg 命令在其它配置了环境的终端中运行。")
        except subprocess.CalledProcessError as e:
            print(f"[-] ffmpeg 下载出错: {e}")
    else:
        print("[*] 已取消下载。你可以手动复制命令执行。")

if __name__ == "__main__":
    main()
