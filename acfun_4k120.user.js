// ==UserScript==
// @name         AcFun 4K120 解锁直链
// @namespace    https://github.com/local/acfun-4k120
// @version      1.0.0
// @description  在 AcFun 网页视频页拉取 App 独占的 4K120 (2160P120) 直链。原理：复刻已验证可用的 App m3u8V2 接口请求，用抓包得到的 App 登录态 + mkey，通过 GM_xmlhttpRequest 跨域请求，把网页被砍掉的高码率阶梯还原出来。
// @author       reverse-skill
// @match        https://www.acfun.cn/v/ac*
// @match        https://www.acfun.cn/bangumi/*
// @icon         https://www.acfun.cn/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      api-ipv6.app.acfun.cn
// @run-at       document-idle
// ==/UserScript==

/* eslint-disable no-undef */
(function () {
  'use strict';

  // ============================================================
  // 配置区：App 登录态（来自抓包，会过期，失效后到菜单里更新）
  // ============================================================
  // 默认值取自 download_4k120.py 中已验证可用的那套凭据。
  // 失效后用油猴菜单「⚙️ 更新 AcFun 凭据」粘贴新抓包的 Cookie / mkey。
  const DEFAULTS = {
    cookie:
      'acfun.midground.api_st=ChZhY2Z1bi5taWRncm91bmQuYXBpLnN0EmCn4jUrL9iye3pefvHrQ9WnWgkKnB8D14QDVNxVAyKu8rCCYGi2h83Bas8WsAT0aV1vJWeLtreiNEmmCeBomqMwfEI4nDDkDoiqdgeOE3Wm-MXzlslSY9gy9uNMLlxVzF4aEkBpOCosC8J4j5gogsgfZQW7ESIg-hOJedTrSqDecCXg_2Sk3EhOVIoShHopOHPLPmQrsvcoBTAB; acPasstoken=ChVpbmZyYS5hY2Z1bi5wYXNzdG9rZW4ScGW91IPYeLDQp7ukVWeNrrHg4vhtjUaGjm8_QywbRNFx_R6crVODEV8nxRvmPHh2W-b9stsRlGlHuao6IeyPU-82XW25uzD9cckwB_xiFZvr9kOLJYPDfH8TPkeAipV6HCxVJQY1bxUMK54z_iXaB2kaEnfcCHKF_CPUPpmjyzdSlISnMCIgN8nRaDyCaqjrOOJ0wfNg4FDXQfqNwRHs8Jtj6KO9MFYoBTAB; auth_key=472630; did=225D4030-819A-41FE-8A77-96B578539C3B; userId=472630; kpf=IPHONE; kpn=ACFUN_APP',
    mkey:
      'AAHewK3eIAAzMDg2MzYxMjABzwcAMEP1uwRyiq6JYAAAAE20aF4wmPvQBtcZ0r4c\r\nnIUT4GLvHxUN2JjBFJHUQEpYu3QmUiGDFCOEPhAG0swbNGJj_NUHNu4TMQOQQIX8\r\nFe-l8JuMJiSdemqF2oRknrJ46ki8gUYscTvjYvuU3Y6Kgg==',
    accessToken: '5c4146a3945fab2b7376cd51e3e6a46e',
    token: 'CAESDTE3ODIxOTgwNDgxNTY=',
    uid: '472630',
    gid: 'DFPC870558EC1698DE46E673C0BEB8EDFF6A584C2FDBF0D55795485279B17289',
    egid: 'DFPC870558EC1698DE46E673C0BEB8EDFF6A584C2FDBF0D55795485279B17289',
    udid: '225D4030-819A-41FE-8A77-96B578539C3B',
    ua: 'AcFun/6.80.0 (iPhone; iOS 27.0; Scale/3.00)',
    appVersion: '6.80.0.639',
  };

  const CFG = {};
  for (const k of Object.keys(DEFAULTS)) CFG[k] = GM_getValue(k, DEFAULTS[k]);

  GM_registerMenuCommand('⚙️ 更新 AcFun 凭据 (Cookie / mkey)', () => {
    const cookie = prompt('粘贴新的 App Cookie（至少含 acfun.midground.api_st）:', CFG.cookie);
    if (cookie !== null) { CFG.cookie = cookie.trim(); GM_setValue('cookie', CFG.cookie); }
    const mkey = prompt('粘贴新的 mkey:', CFG.mkey);
    if (mkey !== null) { CFG.mkey = mkey.trim(); GM_setValue('mkey', CFG.mkey); }
    alert('已保存。重新点页面右下角按钮再试。');
  });

  // ============================================================
  // 上下文解析：从页面拿 acId 与当前分P的 videoId
  // ============================================================
  function getAcId() {
    const m = location.pathname.match(/ac(\d+)/);
    return m ? m[1] : null;
  }

  function getVideoId() {
    // 1) 优先读页面注入的 pageInfo（最准，跟随分P切换）
    try {
      const pi = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).pageInfo;
      const vid = pi && pi.currentVideoInfo && pi.currentVideoInfo.currentVideoId;
      if (vid) return String(vid);
    } catch (e) { /* ignore */ }
    // 2) 退而求其次：正则扫整页 HTML
    const html = document.documentElement.innerHTML;
    let m = html.match(/"currentVideoId"\s*:\s*(\d+)/);
    if (m) return m[1];
    m = html.match(/"videoId"\s*:\s*(\d+)/);
    return m ? m[1] : null;
  }

  // ============================================================
  // 调用 App m3u8V2 接口（与 download_4k120.py 等价）
  // ============================================================
  function gmGet(url, headers) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers,
        timeout: 20000,
        onload: (r) => resolve(r),
        onerror: (e) => reject(new Error('网络错误: ' + JSON.stringify(e))),
        ontimeout: () => reject(new Error('请求超时')),
      });
    });
  }

  async function fetchPlayInfo(acId, videoId) {
    const params = new URLSearchParams({
      videoId,
      resourceId: acId,
      resourceType: '2',
      mkey: CFG.mkey,
      // 公共路由参数（服务器对未知参数忽略，照搬以贴近真实 App 请求）
      market: 'appstore',
      app_version: CFG.appVersion,
      product: 'ACFUN_APP',
      origin: 'ios',
      egid: CFG.egid,
      sys_name: 'ios',
      npr: '0',
      sys_version: '27.0',
      resolution: '1284x2778',
      access_token: CFG.accessToken,
    });
    const url = 'https://api-ipv6.app.acfun.cn/rest/app/play/playInfo/m3u8V2?' + params.toString();

    const headers = {
      Cookie: CFG.cookie,
      'User-Agent': CFG.ua,
      acPlatform: 'IPHONE',
      appVersion: CFG.appVersion,
      market: 'appstore',
      deviceType: '0',
      access_token: CFG.accessToken,
      token: CFG.token,
      uid: CFG.uid,
      gid: CFG.gid,
      udid: CFG.udid,
      idfa: CFG.udid,
      productId: '2000',
      isChildPattern: 'false',
      net: '--_5',
      Accept: 'application/json',
      'Accept-Language': 'zh-Hans-CN;q=1, en-CN;q=0.9, ja-CN;q=0.8',
    };

    const r = await gmGet(url, headers);
    let data;
    try { data = JSON.parse(r.responseText); }
    catch (e) { throw new Error('返回非 JSON（HTTP ' + r.status + '）: ' + r.responseText.slice(0, 200)); }
    return data;
  }

  function parseQualities(data) {
    if (!data || data.result !== 0) {
      throw new Error('接口返回错误 result=' + (data && data.result) + ' ' + (data && data.error_msg || ''));
    }
    const pi = data.playInfo;
    if (!pi) throw new Error('playInfo 为 null —— 多半是短时间内请求过频（防刷），等 1 分钟再点。');
    let ks = pi.ksPlayJson;
    if (typeof ks === 'string') ks = JSON.parse(ks);
    const reps = ks.adaptationSet[0].representation;
    // transcodeInfos 里有各档体积
    const sizeMap = {};
    (pi.transcodeInfos || []).forEach((t) => { sizeMap[t.qualityType] = t.sizeInBytes; });
    return reps.map((r) => ({
      label: r.qualityLabel,
      type: r.qualityType,
      fps: r.frameRate,
      w: r.width,
      h: r.height,
      bitrate: r.avgBitrate,
      url: r.url,
      sizeMB: sizeMap[r.qualityType] ? (sizeMap[r.qualityType] / 1048576).toFixed(1) : null,
    }));
  }

  // ============================================================
  // UI
  // ============================================================
  function el(tag, style, text) {
    const e = document.createElement(tag);
    if (style) e.style.cssText = style;
    if (text != null) e.textContent = text;
    return e;
  }

  function showPanel(list, acId) {
    document.getElementById('ac4k-panel')?.remove();
    const panel = el('div', `position:fixed;right:20px;bottom:70px;z-index:999999;width:460px;max-height:70vh;
      overflow:auto;background:#1f1f23;color:#eee;border:1px solid #fd4c5c;border-radius:10px;
      box-shadow:0 8px 30px rgba(0,0,0,.5);font-size:13px;padding:12px;font-family:system-ui,Arial`);
    panel.id = 'ac4k-panel';

    const head = el('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px');
    head.appendChild(el('b', 'color:#fd4c5c;font-size:15px', `ac${acId} 全清晰度直链`));
    const close = el('span', 'cursor:pointer;color:#aaa;font-size:18px', '×');
    close.onclick = () => panel.remove();
    head.appendChild(close);
    panel.appendChild(head);

    list.forEach((q) => {
      const is4k120 = q.type === '2160p120';
      const row = el('div', `border:1px solid ${is4k120 ? '#fd4c5c' : '#3a3a40'};border-radius:6px;
        padding:8px;margin:6px 0;background:${is4k120 ? 'rgba(253,76,92,.12)' : '#26262b'}`);
      const title = `${q.label}  ·  ${q.w}x${q.h} @ ${q.fps.toFixed(0)}fps  ·  ${q.bitrate}kbps` +
        (q.sizeMB ? `  ·  ~${q.sizeMB}MB` : '') + (is4k120 ? '   ⭐4K120' : '');
      row.appendChild(el('div', 'margin-bottom:6px;font-weight:600', title));

      const btns = el('div', 'display:flex;gap:6px;flex-wrap:wrap');
      const mk = (label, fn, bg) => {
        const b = el('button', `cursor:pointer;border:0;border-radius:5px;padding:4px 10px;color:#fff;
          background:${bg};font-size:12px`, label);
        b.onclick = fn;
        return b;
      };
      btns.appendChild(mk('复制 m3u8', () => { GM_setClipboard(q.url); toast('已复制 m3u8 直链'); }, '#fd4c5c'));
      btns.appendChild(mk('复制 ffmpeg', () => {
        const out = `ac${acId}_${q.type}.mp4`;
        GM_setClipboard(`ffmpeg -headers "User-Agent: ${CFG.ua}" -i "${q.url}" -c copy "${out}"`);
        toast('已复制 ffmpeg 命令');
      }, '#555'));
      btns.appendChild(mk('复制 N_m3u8DL-RE', () => {
        const out = `ac${acId}_${q.type}`;
        GM_setClipboard(`N_m3u8DL-RE "${q.url}" --save-name "${out}" -H "User-Agent: ${CFG.ua}" -M format=mp4`);
        toast('已复制 N_m3u8DL-RE 命令');
      }, '#555'));
      btns.appendChild(mk('打开', () => window.open(q.url, '_blank'), '#555'));
      row.appendChild(btns);
      panel.appendChild(row);
    });

    panel.appendChild(el('div', 'margin-top:8px;color:#888;font-size:11px',
      '提示：直链含时效性 pkey，请尽快下载；接口有防刷，频繁点会返回 null，等 1 分钟再试。'));
    document.body.appendChild(panel);
  }

  let toastTimer;
  function toast(msg) {
    document.getElementById('ac4k-toast')?.remove();
    const t = el('div', `position:fixed;left:50%;top:80px;transform:translateX(-50%);z-index:1000000;
      background:#fd4c5c;color:#fff;padding:8px 16px;border-radius:6px;font-size:13px`, msg);
    t.id = 'ac4k-toast';
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 1500);
  }

  function addButton() {
    if (document.getElementById('ac4k-btn')) return;
    const btn = el('button', `position:fixed;right:20px;bottom:20px;z-index:999999;background:#fd4c5c;
      color:#fff;border:0;border-radius:24px;padding:10px 18px;font-size:14px;font-weight:700;cursor:pointer;
      box-shadow:0 4px 14px rgba(253,76,92,.5)`, '🎬 解锁 4K120');
    btn.id = 'ac4k-btn';
    btn.onclick = async () => {
      const acId = getAcId();
      const videoId = getVideoId();
      if (!acId || !videoId) { toast('未能识别 acId / videoId（确认是普通视频页）'); return; }
      btn.textContent = '⏳ 请求中...';
      btn.disabled = true;
      try {
        const data = await fetchPlayInfo(acId, videoId);
        const list = parseQualities(data);
        showPanel(list, acId);
        const has = list.some((q) => q.type === '2160p120');
        toast(has ? '✅ 已拿到 4K120 直链' : '已返回，但该视频无 4K120');
      } catch (e) {
        toast('失败: ' + e.message);
        console.error('[Ac4K120]', e);
      } finally {
        btn.textContent = '🎬 解锁 4K120';
        btn.disabled = false;
      }
    };
    document.body.appendChild(btn);
  }

  // 页面是 SPA，路由会变，轮询保证按钮常驻
  addButton();
  setInterval(addButton, 2000);
})();
