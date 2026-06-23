// ==UserScript==
// @name         AcFun 4K120 全能解锁（播放器内播放 + 直链下载）
// @namespace    https://github.com/local/acfun-4k120
// @version      2.0.0
// @description  AcFun 网页一键解锁 App 独占的 4K120 (2160P120)：①注入网页播放器，让清晰度菜单直接出现并能播 4K120；②面板列出全部清晰度的 m3u8 直链与 ffmpeg / N_m3u8DL-RE 下载命令。原理：复刻已验证可用的 App m3u8V2 接口（抓包登录态 + 可复用 mkey），把服务器砍过的网页 ksPlayJson 换成完整阶梯，直链 http→https、强制 H.264。
// @author       reverse-skill
// @license      MIT
// @match        https://www.acfun.cn/v/ac*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      api-ipv6.app.acfun.cn
// @run-at       document-start
// ==/UserScript==

/* eslint-disable no-undef */
(function () {
  'use strict';
  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const log = (...a) => console.log('%c[Ac4K120]', 'color:#fd4c5c', ...a);

  // ================= 凭据配置（抓包得到，会过期；菜单可更新）=================
  const DEFAULTS = {
    cookie:
      'acfun.midground.api_st=ChZhY2Z1bi5taWRncm91bmQuYXBpLnN0EmCn4jUrL9iye3pefvHrQ9WnWgkKnB8D14QDVNxVAyKu8rCCYGi2h83Bas8WsAT0aV1vJWeLtreiNEmmCeBomqMwfEI4nDDkDoiqdgeOE3Wm-MXzlslSY9gy9uNMLlxVzF4aEkBpOCosC8J4j5gogsgfZQW7ESIg-hOJedTrSqDecCXg_2Sk3EhOVIoShHopOHPLPmQrsvcoBTAB; acPasstoken=ChVpbmZyYS5hY2Z1bi5wYXNzdG9rZW4ScGW91IPYeLDQp7ukVWeNrrHg4vhtjUaGjm8_QywbRNFx_R6crVODEV8nxRvmPHh2W-b9stsRlGlHuao6IeyPU-82XW25uzD9cckwB_xiFZvr9kOLJYPDfH8TPkeAipV6HCxVJQY1bxUMK54z_iXaB2kaEnfcCHKF_CPUPpmjyzdSlISnMCIgN8nRaDyCaqjrOOJ0wfNg4FDXQfqNwRHs8Jtj6KO9MFYoBTAB; auth_key=472630; did=225D4030-819A-41FE-8A77-96B578539C3B; userId=472630; kpf=IPHONE; kpn=ACFUN_APP',
    mkey:
      'AAHewK3eIAAzMDg2MzYxMjABzwcAMEP1uwRyiq6JYAAAAE20aF4wmPvQBtcZ0r4c\r\nnIUT4GLvHxUN2JjBFJHUQEpYu3QmUiGDFCOEPhAG0swbNGJj_NUHNu4TMQOQQIX8\r\nFe-l8JuMJiSdemqF2oRknrJ46ki8gUYscTvjYvuU3Y6Kgg==',
    accessToken: '5c4146a3945fab2b7376cd51e3e6a46e',
    token: 'CAESDTE3ODIxOTgwNDgxNTY=',
    uid: '472630',
    gid: 'DFPC870558EC1698DE46E673C0BEB8EDFF6A584C2FDBF0D55795485279B17289',
    udid: '225D4030-819A-41FE-8A77-96B578539C3B',
    ua: 'AcFun/6.80.0 (iPhone; iOS 27.0; Scale/3.00)',
    appVersion: '6.80.0.639',
  };
  const CFG = {};
  for (const k of Object.keys(DEFAULTS)) CFG[k] = GM_getValue(k, DEFAULTS[k]);
  GM_registerMenuCommand('⚙️ 更新 AcFun 凭据 (Cookie / mkey)', () => {
    const c = prompt('粘贴新的 App Cookie（含 acfun.midground.api_st）:', CFG.cookie);
    if (c !== null) { CFG.cookie = c.trim(); GM_setValue('cookie', CFG.cookie); }
    const m = prompt('粘贴新的 mkey:', CFG.mkey);
    if (m !== null) { CFG.mkey = m.trim(); GM_setValue('mkey', CFG.mkey); }
    alert('已保存，刷新页面生效。');
  });

  // ================= 状态 =================
  const ORIG_PARSE = W.JSON.parse.bind(W.JSON);
  let APP_RAW = null;   // App ksPlayJson 字符串（已 https 化），用于注入播放器
  let APP_VID = null;   // App ksPlayJson 内部 videoId，用于 hook 精准匹配
  let APP_LIST = null;  // 解析后的清晰度列表，用于面板
  let fetching = false;
  let hookApplied = false;      // JSON.parse hook 是否已无感命中主 ksPlayJson
  let autoInjectScheduled = false;

  // ================= 工具 =================
  function getAcId() { const m = location.pathname.match(/ac(\d+)/); return m ? m[1] : null; }
  function getVideoId() {
    try {
      const pi = W.pageInfo;
      const v = pi && (pi.currentVideoId || (pi.currentVideoInfo && (pi.currentVideoInfo.currentVideoId || pi.currentVideoInfo.id)));
      if (v) return String(v);
    } catch (e) {}
    const m = document.documentElement.innerHTML.match(/"currentVideoId"\s*:\s*(\d+)/);
    return m ? m[1] : null;
  }
  function httpsify(s) { return s.replace(/http:\/\/([a-z0-9.-]*\.acfun\.cn)/gi, 'https://$1'); }
  function gmGet(url, headers) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: 'GET', url, headers, timeout: 20000,
        onload: (r) => res(r), onerror: () => rej(new Error('网络错误')), ontimeout: () => rej(new Error('超时')),
      });
    });
  }

  async function fetchAppKs() {
    if (APP_RAW) return true;
    if (fetching) return false;
    const acId = getAcId(); const videoId = getVideoId();
    if (!acId || !videoId) { log('暂未取到 acId/videoId'); return false; }
    fetching = true;
    try {
      const params = new URLSearchParams({
        videoId, resourceId: acId, resourceType: '2', mkey: CFG.mkey,
        market: 'appstore', app_version: CFG.appVersion, product: 'ACFUN_APP', origin: 'ios',
        egid: CFG.gid, sys_name: 'ios', npr: '0', sys_version: '27.0', resolution: '1284x2778',
        access_token: CFG.accessToken,
      });
      const url = 'https://api-ipv6.app.acfun.cn/rest/app/play/playInfo/m3u8V2?' + params.toString();
      const headers = {
        Cookie: CFG.cookie, 'User-Agent': CFG.ua, acPlatform: 'IPHONE', appVersion: CFG.appVersion,
        market: 'appstore', deviceType: '0', access_token: CFG.accessToken, token: CFG.token,
        uid: CFG.uid, gid: CFG.gid, udid: CFG.udid, idfa: CFG.udid, productId: '2000',
        isChildPattern: 'false', net: '--_5', Accept: 'application/json',
      };
      const r = await gmGet(url, headers);
      const data = ORIG_PARSE(r.responseText);
      if (data.result !== 0 || !data.playInfo) {
        toast('App 接口未返回有效数据（' + (data.error_msg || ('result=' + data.result) || 'playInfo:null 防刷') + '），稍后再试');
        return false;
      }
      const ksStr = httpsify(data.playInfo.ksPlayJson);
      const ks = ORIG_PARSE(ksStr);
      APP_RAW = ksStr; APP_VID = ks.videoId;
      const sizeMap = {};
      (data.playInfo.transcodeInfos || []).forEach((t) => { sizeMap[t.qualityType] = t.sizeInBytes; });
      APP_LIST = ks.adaptationSet[0].representation.map((x) => ({
        label: x.qualityLabel, type: x.qualityType, fps: x.frameRate, w: x.width, h: x.height,
        bitrate: x.avgBitrate, url: x.url,
        sizeMB: sizeMap[x.qualityType] ? (sizeMap[x.qualityType] / 1048576).toFixed(1) : null,
      }));
      log('已获取 App 全阶梯:', APP_LIST.map((q) => q.label), 'videoId=', APP_VID);
      scheduleAutoInject();   // 有 4K120 就自动注入
      return true;
    } catch (e) {
      log('fetch 失败', e); toast('获取失败: ' + e.message); return false;
    } finally { fetching = false; }
  }

  // ================= 抢先 hook JSON.parse：精准替换主 ksPlayJson（无感生效）=================
  W.JSON.parse = function (text, reviver) {
    const obj = ORIG_PARSE(text, reviver);
    try {
      if (APP_RAW && obj && obj.adaptationSet && obj.videoId && obj.videoId === APP_VID) {
        hookApplied = true;
        log('JSON.parse 命中主 ksPlayJson，无感替换为 App 全阶梯');
        return ORIG_PARSE(APP_RAW);
      }
    } catch (e) {}
    return obj;
  };

  // ================= 自动注入：有 4K120 就自动让播放器用上 =================
  function scheduleAutoInject() {
    if (autoInjectScheduled) return;
    if (!APP_LIST || !APP_LIST.some((q) => q.type === '2160p120')) return; // 该视频没有 4K120 → 不动播放器
    autoInjectScheduled = true;
    let waited = 0;
    const t = setInterval(() => {
      waited += 300;
      if (hookApplied) { clearInterval(t); log('hook 已无感注入 4K120，无需重载'); return; }
      // 播放器已就绪但 hook 没赶上首次解析 → 留 ~900ms 缓冲后自动重建一次菜单
      if (W._AcFunPlayer && W.pageInfo && W.pageInfo.currentVideoInfo && waited >= 900) {
        clearInterval(t); log('自动注入 4K120（数据晚到，重建菜单）'); applyToPlayer(true);
      }
      if (waited > 15000) clearInterval(t);
    }, 300);
  }

  // ================= 注入播放器并重建清晰度菜单 =================
  function applyToPlayer(auto) {
    if (!APP_RAW) { toast('正在获取 4K120 数据…'); fetchAppKs().then((ok) => ok && applyToPlayer(auto)); return; }
    const cvi = W.pageInfo && W.pageInfo.currentVideoInfo;
    if (!cvi) { toast('未找到 pageInfo.currentVideoInfo'); return; }
    cvi.ksPlayJson = APP_RAW;
    cvi.ksPlayJsonHevc = '';
    const p = W._AcFunPlayer;
    let ok = false;
    try {
      if (p && typeof p.reloadVideo === 'function') { p.reloadVideo(); ok = true; }
      else if (p && typeof p.loadVideo === 'function') { p.loadVideo(); ok = true; }
      else if (W.player && typeof W.player.reload === 'function') { W.player.reload(); ok = true; }
    } catch (e) { log('reload 调用异常', e); }
    toast(ok ? (auto ? '✅ 已自动注入 4K120，菜单可选 2160P120' : '已重建菜单，去播放器选 2160P120')
             : '已注入，但未找到重载方法（看 Console）');
    log('applyToPlayer auto=', !!auto, 'reload-called=', ok);
  }

  // ================= UI =================
  let toastTimer;
  function toast(msg) {
    document.getElementById('ac4k-toast')?.remove();
    const t = document.createElement('div');
    t.id = 'ac4k-toast'; t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;top:80px;transform:translateX(-50%);z-index:1000000;background:#fd4c5c;color:#fff;padding:8px 16px;border-radius:6px;font:13px system-ui';
    (document.body || document.documentElement).appendChild(t);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 2200);
  }
  function elBtn(label, bg, fn) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `cursor:pointer;border:0;border-radius:5px;padding:5px 10px;color:#fff;background:${bg};font:12px system-ui`;
    b.onclick = fn; return b;
  }

  function showPanel() {
    document.getElementById('ac4k-panel')?.remove();
    const acId = getAcId();
    const panel = document.createElement('div');
    panel.id = 'ac4k-panel';
    panel.style.cssText = 'position:fixed;right:20px;bottom:70px;z-index:999999;width:480px;max-height:74vh;overflow:auto;background:#1f1f23;color:#eee;border:1px solid #fd4c5c;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5);font:13px system-ui;padding:12px';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px';
    const tt = document.createElement('b'); tt.style.cssText = 'color:#fd4c5c;font-size:15px'; tt.textContent = `ac${acId} · 4K120 解锁`;
    const cls = document.createElement('span'); cls.style.cssText = 'cursor:pointer;color:#aaa;font-size:18px'; cls.textContent = '×'; cls.onclick = () => panel.remove();
    head.appendChild(tt); head.appendChild(cls); panel.appendChild(head);

    // 顶部：注入播放器
    const playRow = document.createElement('div');
    playRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin:4px 0 10px';
    playRow.appendChild(elBtn('▶ 在播放器内播放 4K120', '#fd4c5c', applyToPlayer));
    const tip = document.createElement('span'); tip.style.cssText = 'color:#888;font-size:11px'; tip.textContent = '注入后去播放器清晰度菜单选 2160P120';
    playRow.appendChild(tip); panel.appendChild(playRow);

    const hr = document.createElement('div'); hr.style.cssText = 'border-top:1px solid #3a3a40;margin:6px 0'; panel.appendChild(hr);
    const dlt = document.createElement('div'); dlt.style.cssText = 'color:#aaa;margin:2px 0 4px;font-size:12px'; dlt.textContent = '或复制直链 / 下载命令：'; panel.appendChild(dlt);

    (APP_LIST || []).forEach((q) => {
      const is4k120 = q.type === '2160p120';
      const row = document.createElement('div');
      row.style.cssText = `border:1px solid ${is4k120 ? '#fd4c5c' : '#3a3a40'};border-radius:6px;padding:8px;margin:6px 0;background:${is4k120 ? 'rgba(253,76,92,.12)' : '#26262b'}`;
      const title = document.createElement('div');
      title.style.cssText = 'margin-bottom:6px;font-weight:600';
      title.textContent = `${q.label} · ${q.w}x${q.h}@${q.fps.toFixed(0)}fps · ${q.bitrate}kbps` + (q.sizeMB ? ` · ~${q.sizeMB}MB` : '') + (is4k120 ? '  ⭐4K120' : '');
      row.appendChild(title);
      const btns = document.createElement('div'); btns.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
      btns.appendChild(elBtn('复制 m3u8', '#fd4c5c', () => { GM_setClipboard(q.url); toast('已复制 m3u8'); }));
      btns.appendChild(elBtn('复制 ffmpeg', '#555', () => {
        GM_setClipboard(`ffmpeg -headers "User-Agent: ${CFG.ua}" -i "${q.url}" -c copy "ac${acId}_${q.type}.mp4"`); toast('已复制 ffmpeg 命令');
      }));
      btns.appendChild(elBtn('复制 N_m3u8DL-RE', '#555', () => {
        GM_setClipboard(`N_m3u8DL-RE "${q.url}" --save-name "ac${acId}_${q.type}" -H "User-Agent: ${CFG.ua}" -M format=mp4`); toast('已复制 N_m3u8DL-RE 命令');
      }));
      btns.appendChild(elBtn('打开', '#555', () => window.open(q.url, '_blank')));
      row.appendChild(btns); panel.appendChild(row);
    });

    const foot = document.createElement('div'); foot.style.cssText = 'margin-top:8px;color:#888;font-size:11px';
    foot.textContent = '直链含时效 pkey，尽快下载；接口有防刷，频繁请求会 null，等 1 分钟再试。';
    panel.appendChild(foot);
    document.body.appendChild(panel);
  }

  function addButton() {
    if (document.getElementById('ac4k-btn') || !document.body) return;
    const b = document.createElement('button');
    b.id = 'ac4k-btn'; b.textContent = '🎬 4K120';
    b.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:999999;background:#fd4c5c;color:#fff;border:0;border-radius:24px;padding:10px 18px;font:700 14px system-ui;cursor:pointer;box-shadow:0 4px 14px rgba(253,76,92,.5)';
    b.onclick = async () => {
      if (!APP_LIST) { b.textContent = '⏳ 获取中'; b.disabled = true; const ok = await fetchAppKs(); b.textContent = '🎬 4K120'; b.disabled = false; if (!ok) return; }
      showPanel();
      const has = (APP_LIST || []).some((q) => q.type === '2160p120');
      toast(has ? '✅ 含 4K120' : '该视频无 4K120，已列出最高可用');
    };
    document.body.appendChild(b);
  }

  // ================= 启动 =================
  function boot() {
    addButton();
    if (!APP_RAW && !fetching && getVideoId()) fetchAppKs(); // 尽早预取，争取赢过播放器首次解析（hook 无感生效）
  }
  const iv = setInterval(boot, 800);
  if (document.readyState !== 'loading') boot();
  else document.addEventListener('DOMContentLoaded', boot);
  setTimeout(() => clearInterval(iv), 30000);
  setInterval(addButton, 3000);
})();
