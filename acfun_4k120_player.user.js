// ==UserScript==
// @name         AcFun 播放器内 4K120 解锁
// @namespace    https://github.com/local/acfun-4k120
// @version      1.0.0
// @description  让 AcFun 网页播放器的清晰度菜单里直接出现并能播放 4K120 (2160P120)。原理：document-start 抢先 hook JSON.parse，按内部 videoId 精准匹配，把服务器砍过的网页 ksPlayJson 替换成 App m3u8V2 接口返回的完整阶梯（含 2160P120），并把直链 http→https、强制走 H.264，最后调播放器 loadVideo() 重建清晰度菜单。
// @author       reverse-skill
// @match        https://www.acfun.cn/v/ac*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
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
  let APP_RAW = null;     // App 返回的 ksPlayJson 字符串（已 https 化）
  let APP_VID = null;     // App ksPlayJson 内部 videoId（如 d648ee39cea2d169），用于精准匹配
  let fetching = false;

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
  function httpsify(s) {
    // 把 acfun 视频 CDN 的 http 链接升级为 https，避免混合内容被拦
    return s.replace(/http:\/\/([a-z0-9.-]*\.acfun\.cn)/gi, 'https://$1');
  }

  function gmGet(url, headers) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: 'GET', url, headers, timeout: 20000,
        onload: (r) => res(r), onerror: () => rej(new Error('网络错误')), ontimeout: () => rej(new Error('超时')),
      });
    });
  }

  async function fetchAppKs() {
    if (APP_RAW || fetching) return;
    const acId = getAcId(); const videoId = getVideoId();
    if (!acId || !videoId) { log('暂未取到 acId/videoId'); return; }
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
        return;
      }
      const ksStr = httpsify(data.playInfo.ksPlayJson);
      const ks = ORIG_PARSE(ksStr);
      APP_RAW = ksStr; APP_VID = ks.videoId;
      const labels = ks.adaptationSet[0].representation.map((x) => x.qualityLabel);
      log('已获取 App 全阶梯:', labels, 'videoId=', APP_VID);
      toast('已拉到 4K120 阶梯，点右下角按钮应用到播放器');
    } catch (e) {
      log('fetch 失败', e); toast('获取失败: ' + e.message);
    } finally { fetching = false; }
  }

  // ================= 1) 抢先 hook JSON.parse：精准替换主 ksPlayJson =================
  W.JSON.parse = function (text, reviver) {
    const obj = ORIG_PARSE(text, reviver);
    try {
      if (APP_RAW && obj && obj.adaptationSet && obj.videoId && obj.videoId === APP_VID) {
        log('JSON.parse 命中主 ksPlayJson，替换为 App 全阶梯');
        return ORIG_PARSE(APP_RAW); // 返回新对象，含 2160P120
      }
    } catch (e) {}
    return obj;
  };

  // ================= 2) 兜底：改 currentVideoInfo + 调 loadVideo 重建 =================
  function applyToPlayer() {
    if (!APP_RAW) { toast('还没拿到 4K120 数据，正在获取…'); fetchAppKs(); return; }
    const pi = W.pageInfo;
    const cvi = pi && pi.currentVideoInfo;
    if (!cvi) { toast('未找到 pageInfo.currentVideoInfo'); return; }
    cvi.ksPlayJson = APP_RAW;       // 注入完整阶梯（https）
    cvi.ksPlayJsonHevc = '';        // 清空 hevc，强制走 H.264 这条 2160P120
    const p = W._AcFunPlayer;
    let ok = false;
    try {
      if (p && typeof p.reloadVideo === 'function') { p.reloadVideo(); ok = true; }
      else if (p && typeof p.loadVideo === 'function') { p.loadVideo(); ok = true; }
      else if (W.player && typeof W.player.reload === 'function') { W.player.reload(); ok = true; }
    } catch (e) { log('reload 调用异常', e); }
    toast(ok ? '已重建清晰度菜单，去菜单里选 2160P120' : '已注入，但未找到播放器重载方法（看控制台）');
    log('applyToPlayer done, reload-called=', ok);
  }

  // ================= UI =================
  let toastTimer;
  function toast(msg) {
    const id = 'ac4k-toast';
    document.getElementById(id)?.remove();
    const t = document.createElement('div');
    t.id = id; t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;top:80px;transform:translateX(-50%);z-index:1000000;background:#fd4c5c;color:#fff;padding:8px 16px;border-radius:6px;font:13px system-ui';
    (document.body || document.documentElement).appendChild(t);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 2200);
  }
  function addButton() {
    if (document.getElementById('ac4k-btn') || !document.body) return;
    const b = document.createElement('button');
    b.id = 'ac4k-btn'; b.textContent = '▶ 播放器内 4K120';
    b.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:999999;background:#fd4c5c;color:#fff;border:0;border-radius:24px;padding:10px 18px;font:700 14px system-ui;cursor:pointer;box-shadow:0 4px 14px rgba(253,76,92,.5)';
    b.onclick = applyToPlayer;
    document.body.appendChild(b);
  }

  // ================= 启动 =================
  function boot() {
    addButton();
    if (!APP_RAW && !fetching && getVideoId()) fetchAppKs(); // 尽早预取，争取赢过播放器解析
  }
  // pageInfo 由内联脚本设置，轮询尽快预取；同时常驻按钮（SPA 路由）
  const iv = setInterval(boot, 800);
  if (document.readyState !== 'loading') boot();
  else document.addEventListener('DOMContentLoaded', boot);
  // 30 秒后停止高频轮询（按钮已常驻）
  setTimeout(() => clearInterval(iv), 30000);
  setInterval(addButton, 3000);
})();
