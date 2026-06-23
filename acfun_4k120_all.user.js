// ==UserScript==
// @name         AcFun 4K120 全能解锁（播放器内播放 + 直链下载）
// @namespace    https://github.com/epstomai/acfun-4k120
// @version      3.3.0
// @description  AcFun 网页一键解锁 App 独占的 4K120 (2160P120)：①注入网页播放器，让清晰度菜单直接出现并能播 4K120；②面板列出全部清晰度的 m3u8 直链与 ffmpeg / N_m3u8DL-RE 下载命令。凭据全自动：用你自己浏览器里的 acfun.cn 登录态，自动换取 App 接口所需的 api_st，并读取网页 mkey——无任何硬编码、不泄露账号。
// @author       reverse-skill
// @license      MIT
// @match        https://www.acfun.cn/v/ac*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      id.app.acfun.cn
// @connect      api-ipv6.app.acfun.cn
// @run-at       document-start
// ==/UserScript==

/* eslint-disable no-undef */
(function () {
  'use strict';
  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const log = (...a) => console.log('%c[Ac4K120]', 'color:#fd4c5c', ...a);

  // ====== 可选：备用 mkey（仅当自动读取网页 mkey 失败时才需要手填一次）======
  let manualMkey = GM_getValue('mkey', '');
  GM_registerMenuCommand('⚙️ 设置备用 mkey（自动失败时用）', () => {
    const m = prompt('一般不用填。仅当自动获取失败时，粘贴抓包得到的 mkey：', manualMkey);
    if (m !== null) { manualMkey = m.trim(); GM_setValue('mkey', manualMkey); alert('已保存，刷新生效。'); }
  });
  GM_registerMenuCommand('🔄 清除缓存的 api_st（换账号/登录后用）', () => { apiStCache = null; toast('已清除，下次请求会重新换取'); });

  // ================= 状态 =================
  const ORIG_PARSE = W.JSON.parse.bind(W.JSON);
  let APP_RAW = null, APP_VID = null, APP_LIST = null;
  let fetching = false, autoInjectScheduled = false, injectTimer = null;
  let apiStCache = null;   // 本会话缓存的 api_st（不持久化、不写盘）

  // ================= 工具 =================
  function getAcId() { const m = location.pathname.match(/ac(\d+)/); return m ? m[1] : null; }
  function getVideoId() {
    // 优先取播放器当前正在播的分P（切P会实时更新），其次页面 pageInfo
    try {
      const vi = W._AcFunPlayer && W._AcFunPlayer.videoInfo;
      if (vi && (vi.id || vi.videoId || vi.currentVideoId)) return String(vi.id || vi.videoId || vi.currentVideoId);
    } catch (e) {}
    try {
      const pi = W.pageInfo;
      const cvi = pi && pi.currentVideoInfo;
      if (cvi && (cvi.id || cvi.currentVideoId)) return String(cvi.id || cvi.currentVideoId);
      if (pi && pi.currentVideoId) return String(pi.currentVideoId);
    } catch (e) {}
    const m = document.documentElement.innerHTML.match(/"currentVideoId"\s*:\s*(\d+)/);
    return m ? m[1] : null;
  }
  function getMkey() {
    try { if (W.pageInfo && W.pageInfo.mkey) return W.pageInfo.mkey; } catch (e) {}
    const m = document.documentElement.innerHTML.match(/"mkey"\s*:\s*"([^"]+)"/);
    return (m && m[1]) || manualMkey || '';
  }
  function cookieVal(name) { const m = document.cookie.match('(?:^|; )' + name + '=([^;]+)'); return m ? m[1] : ''; }
  function httpsify(s) { return s.replace(/http:\/\/([a-z0-9.-]*\.acfun\.cn)/gi, 'https://$1'); }

  // ====== 注入过渡遮罩：把切换 4K120 时的几下缓冲/闪屏藏在“加载中”遮罩后，加载稳了再揭开 ======
  let coverEl = null, coverRAF = 0, coverSafety = 0;
  function videoEl() { return document.querySelector('.video-area video, .player video, video'); }
  function showCover() {
    const v = videoEl();
    if (!v || coverEl) return;
    coverEl = document.createElement('div');
    coverEl.id = 'ac4k-cover';
    coverEl.style.cssText = 'position:fixed;z-index:999998;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;gap:10px;font:14px system-ui;pointer-events:none';
    coverEl.innerHTML = '<span style="width:16px;height:16px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;display:inline-block;animation:ac4kspin .8s linear infinite"></span>正在加载 4K120…';
    if (!document.getElementById('ac4k-spin-style')) {
      const st = document.createElement('style'); st.id = 'ac4k-spin-style';
      st.textContent = '@keyframes ac4kspin{to{transform:rotate(360deg)}}';
      document.head.appendChild(st);
    }
    (document.body || document.documentElement).appendChild(coverEl);
    const sync = () => {
      const vv = videoEl();
      if (!vv || !coverEl) return;
      const r = vv.getBoundingClientRect();
      if (r.width < 50 || r.height < 50) { coverEl.style.display = 'none'; }
      else { coverEl.style.display = 'flex'; coverEl.style.left = r.left + 'px'; coverEl.style.top = r.top + 'px'; coverEl.style.width = r.width + 'px'; coverEl.style.height = r.height + 'px'; }
      coverRAF = requestAnimationFrame(sync);
    };
    sync();
    clearTimeout(coverSafety);
    coverSafety = setTimeout(hideCover, 8000); // 安全兜底：最多盖 8 秒，绝不卡住
  }
  function hideCover() {
    clearTimeout(coverSafety);
    if (coverRAF) { cancelAnimationFrame(coverRAF); coverRAF = 0; }
    if (coverEl) { coverEl.remove(); coverEl = null; }
  }

  function gm(opt) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest(Object.assign({
        timeout: 20000, onload: (r) => res(r),
        onerror: () => rej(new Error('网络错误')), ontimeout: () => rej(new Error('超时')),
      }, opt));
    });
  }

  // 用浏览器现有的 acfun.cn 登录态（acPasstoken/auth_key 由浏览器自动随请求发送）换取 api_st
  async function getApiSt() {
    if (apiStCache) return apiStCache;
    const r = await gm({
      method: 'POST', url: 'https://id.app.acfun.cn/rest/web/token/get',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: 'sid=acfun.midground.api',
    });
    let j; try { j = ORIG_PARSE(r.responseText); } catch (e) { throw new Error('token 接口返回异常'); }
    if (j.result !== 0 || !j['acfun.midground.api_st']) {
      throw new Error('换取 api_st 失败（请确认已登录 acfun.cn）result=' + j.result);
    }
    apiStCache = j['acfun.midground.api_st'];
    log('已用网页登录态换取 api_st，userId=', j.userId);
    return apiStCache;
  }

  async function fetchAppKs() {
    if (APP_RAW) return true;
    if (fetching) return false;
    const acId = getAcId(); const videoId = getVideoId();
    if (!acId || !videoId) { log('暂未取到 acId/videoId'); return false; }
    fetching = true;
    try {
      const apiSt = await getApiSt();
      const mkey = getMkey();
      if (!mkey) log('警告：未读到网页 mkey（可能页面未就绪），将以空 mkey 尝试');
      const params = new URLSearchParams({ videoId, resourceId: acId, resourceType: '2', mkey });
      const url = 'https://api-ipv6.app.acfun.cn/rest/app/play/playInfo/m3u8V2?' + params.toString();
      // 显式带上 api_st；浏览器对 .acfun.cn 的 cookie（如 _did）也会随请求发送，用于 mkey 校验
      const r = await gm({
        method: 'GET', url,
        headers: { Cookie: 'acfun.midground.api_st=' + apiSt, acPlatform: 'IPHONE', appVersion: '6.80.0.639', market: 'appstore', Accept: 'application/json' },
      });
      const data = ORIG_PARSE(r.responseText);
      if (data.result !== 0) { hideCover(); toast('接口错误 result=' + data.result + ' ' + (data.error_msg || '')); log('m3u8V2 错误', data); return false; }
      const pi = data.playInfo;
      if (!pi || !pi.ksPlayJson) {
        hideCover();
        toast('未取到播放数据（可能防刷/需会员/mkey 无效）。等 1 分钟重试，或菜单设置备用 mkey');
        log('playInfo 为空', pi);
        return false;
      }
      const ksStr = httpsify(pi.ksPlayJson);
      const ks = ORIG_PARSE(ksStr);
      APP_RAW = ksStr; APP_VID = ks.videoId;
      const sizeMap = {};
      (pi.transcodeInfos || []).forEach((t) => { sizeMap[t.qualityType] = t.sizeInBytes; });
      APP_LIST = ks.adaptationSet[0].representation.map((x) => ({
        label: x.qualityLabel, type: x.qualityType, fps: x.frameRate, w: x.width, h: x.height,
        bitrate: x.avgBitrate, url: x.url,
        sizeMB: sizeMap[x.qualityType] ? (sizeMap[x.qualityType] / 1048576).toFixed(1) : null,
      }));
      log('已获取 App 全阶梯:', APP_LIST.map((q) => q.label), 'videoId=', APP_VID);
      scheduleAutoInject();
      return true;
    } catch (e) {
      hideCover(); log('fetch 失败', e); toast('获取失败: ' + e.message); return false;
    } finally { fetching = false; }
  }

  // ================= 拦 JSON.parse：把主 ksPlayJson 换成 App 全阶梯 =================
  // 必须用 hook：播放器建清晰度菜单时解析的是内部缓存的那份 ksPlayJson 字符串，
  // 只设 currentVideoInfo.ksPlayJson 覆盖不到，必须全局拦解析才能让菜单出现 4K120。
  // 关键：不要提前预热数据，让 APP_RAW 在播放器自然加载之后才就绪——这样 hook 只在我们
  // 主动重载时触发，不会在自然加载/预加载阶段反复触发导致多次闪屏。
  W.JSON.parse = function (text, reviver) {
    const obj = ORIG_PARSE(text, reviver);
    try {
      if (APP_RAW && obj && obj.adaptationSet && obj.videoId && obj.videoId === APP_VID) {
        return ORIG_PARSE(APP_RAW);
      }
    } catch (e) {}
    return obj;
  };

  // ================= 自动注入：等播放器自然加载稳定后，重载一次让菜单出现 4K120 =================
  function scheduleAutoInject() {
    if (autoInjectScheduled) return;
    if (!APP_LIST || !APP_LIST.some((q) => q.type === '2160p120')) { hideCover(); return; } // 无 4K120 不动播放器
    autoInjectScheduled = true;
    let waited = 0;
    if (injectTimer) clearInterval(injectTimer);
    injectTimer = setInterval(() => {
      waited += 150;
      const ready = W._AcFunPlayer && W.pageInfo && W.pageInfo.currentVideoInfo;
      if (ready && waited >= 900) { clearInterval(injectTimer); injectTimer = null; log('注入 4K120（稳定后重载一次）'); applyToPlayer(true); }
      else if (waited > 15000) { clearInterval(injectTimer); injectTimer = null; log('等待播放器就绪超时，未自动注入（可手动点按钮）'); }
    }, 150);
  }

  function applyToPlayer(auto) {
    if (!APP_RAW) { toast('正在获取 4K120 数据…'); fetchAppKs().then((ok) => ok && applyToPlayer(auto)); return; }
    const cvi = W.pageInfo && W.pageInfo.currentVideoInfo;
    if (!cvi) { toast('未找到 pageInfo.currentVideoInfo'); return; }
    cvi.ksPlayJson = APP_RAW;
    cvi.ksPlayJsonHevc = '';
    // 让播放器重载后自动选中最高清晰度：manifestParsed 时会按 player.firstQualityType 匹配档位选中
    const topType = (APP_LIST && APP_LIST[0] && APP_LIST[0].type) || '2160p120';
    try { if (W.player) W.player.firstQualityType = topType; } catch (e) {}
    try { const k = W._AcFunPlayer && (W._AcFunPlayer.player || W._AcFunPlayer.kernel); if (k) k.firstQualityType = topType; } catch (e) {}
    try { const h = JSON.parse(localStorage.getItem('history-config') || '{}'); h.firstQualityType = topType; localStorage.setItem('history-config', JSON.stringify(h)); } catch (e) {}
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
    // 重载后给 4K120 一点缓冲时间，再揭开遮罩（露出已稳定的 4K120 画面）
    setTimeout(hideCover, 2500);
  }

  // ================= UI =================
  let toastTimer;
  function toast(msg) {
    document.getElementById('ac4k-toast')?.remove();
    const t = document.createElement('div');
    t.id = 'ac4k-toast'; t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;top:80px;transform:translateX(-50%);z-index:1000000;background:#fd4c5c;color:#fff;padding:8px 16px;border-radius:6px;font:13px system-ui';
    (document.body || document.documentElement).appendChild(t);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 2600);
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
    const playRow = document.createElement('div');
    playRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin:4px 0 10px';
    playRow.appendChild(elBtn('▶ 在播放器内播放 4K120', '#fd4c5c', () => applyToPlayer(false)));
    const tip = document.createElement('span'); tip.style.cssText = 'color:#888;font-size:11px'; tip.textContent = '注入后去清晰度菜单选 2160P120';
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
      btns.appendChild(elBtn('复制 ffmpeg', '#555', () => { GM_setClipboard(`ffmpeg -i "${q.url}" -c copy "ac${acId}_${q.type}.mp4"`); toast('已复制 ffmpeg 命令'); }));
      btns.appendChild(elBtn('复制 N_m3u8DL-RE', '#555', () => { GM_setClipboard(`N_m3u8DL-RE "${q.url}" --save-name "ac${acId}_${q.type}" -M format=mp4`); toast('已复制 N_m3u8DL-RE 命令'); }));
      btns.appendChild(elBtn('打开', '#555', () => window.open(q.url, '_blank')));
      row.appendChild(btns); panel.appendChild(row);
    });
    const foot = document.createElement('div'); foot.style.cssText = 'margin-top:8px;color:#888;font-size:11px';
    foot.textContent = '直链含时效 pkey，尽快下载；接口有防刷，频繁请求会失败，等 1 分钟再试。';
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

  // ================= 启动：由 URL（分P）变化驱动，不用常驻轮询 =================
  // 切P 会改 URL（/v/acXXXX_N 末尾数字变），但属 SPA 内部跳转、不重载脚本。
  // 所以 hook history 路由 + popstate，URL 一变就为新分P重注入。
  let lastVideoId = null;
  function reinjectIfChanged() {
    const vid = getVideoId();
    if (!vid || vid === lastVideoId) return false;
    lastVideoId = vid;
    if (injectTimer) { clearInterval(injectTimer); injectTimer = null; }
    APP_RAW = null; APP_VID = null; APP_LIST = null;
    fetching = false; autoInjectScheduled = false;
    log('视频/分P 切换 → 重新注入 4K120，videoId=', vid);
    showCover(); // 盖上“加载 4K120”遮罩，藏住后续切换闪屏
    fetchAppKs();
    return true;
  }
  // URL 变化后，播放器要一小会儿才把 videoInfo 切到新分P；短暂等待其就绪后再注入（非常驻）
  function onNav() {
    let n = 0;
    const t = setInterval(() => {
      addButton();
      if (reinjectIfChanged() || ++n > 16) clearInterval(t); // 命中或 ~4s 兜底即停
    }, 250);
  }
  ['pushState', 'replaceState'].forEach((m) => {
    const orig = history[m];
    history[m] = function () { const r = orig.apply(this, arguments); setTimeout(onNav, 0); return r; };
  });
  W.addEventListener('popstate', onNav);
  // 首次加载
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onNav);
  else onNav();
})();
