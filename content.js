'use strict';

/* ==================== B站 AI 总结 — 页面悬浮球 ====================
 * 内容脚本，在 www.bilibili.com 上注入（manifest content_scripts）。
 * - 粉色圆球 + 白色 S，可拖动（位置记忆在 storage.local）
 * - 左键单击 = 一键总结（复用 background 的 run 流程，port name: bili-summary）
 * - popup 里的「页面悬浮球」开关（storage.local.floatBall）可随时显示/隐藏
 *
 * 注意：content script 的 IndexedDB 属于页面源而非扩展源，
 * 本脚本不写历史库，只通过消息驱动后台。
 */
(() => {
  const CONFIG_KEY = 'floatBall';
  const POS_KEY = 'ballPos';
  const DEFAULT_RIGHT = 20;
  const DEFAULT_TOP = 90;
  const SIZE = 30;

  let enabled = true;
  let ball = null;
  let toast = null;
  let running = false;

  chrome.storage.local
    .get({ [CONFIG_KEY]: true, [POS_KEY]: null })
    .then((v) => {
      if (!extensionAlive()) {
        onInvalidated();
        return;
      }
      enabled = v[CONFIG_KEY] !== false;
      if (enabled) mount();
    });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!extensionAlive()) {
      onInvalidated();
      return;
    }
    if (changes[CONFIG_KEY]) {
      enabled = !!changes[CONFIG_KEY].newValue;
      if (enabled) mount();
      else unmount();
    }
  });

  /* ---------------- 扩展重载保护 ----------------
   * 开发模式下在 chrome://extensions 点「重新加载」会使已注入页面的旧
   * content script 失效（chrome.* 调用抛 "Extension context invalidated"）。
   * 所有 chrome API 回调处先检查 chrome.runtime.id，失效则移除悬浮球，
   * 避免报错 + 残留一颗点了没反应的死球（刷新页面即可恢复）。
   */
  function extensionAlive() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function onInvalidated() {
    console.warn('[bili-summary] 扩展已重载，移除悬浮球（刷新页面后恢复）');
    clearInterval(pollTimer);
    unmount();
  }

  function safeDisconnect(port) {
    try {
      port.disconnect();
    } catch (e) {
      /* 忽略：连接已失效 */
    }
  }

  /* ---------------- 全屏时隐藏悬浮球 ----------------
   * 1. 原生全屏（document.fullscreenElement）：浏览器顶层渲染本来就盖住 fixed 元素，
   *    这里主动隐藏只是兜底；
   * 2. B 站「网页全屏」是纯 CSS 实现（播放器容器铺满视口，不触发 fullscreenchange），
   *    fixed + 最高 z-index 的球会浮在黑边上 → 用类名 + 几何覆盖检测。
   */
  let fullscreenActive = false;
  let pollTimer = null;

  function isPlayerFullscreen() {
    if (document.fullscreenElement) return true;
    const c = document.querySelector('.bpx-player-container');
    if (!c) return false;
    // 类名：网页全屏/webfullscreen（容器自身或其祖先）
    for (let el = c; el && el !== document.documentElement; el = el.parentElement) {
      if (/web.?fullscreen/i.test(String(el.className || ''))) return true;
    }
    // 几何：容器覆盖视口 ≥95% 即视为全屏（放宽阈值 + 高频轮询，动画过渡中也快速命中）
    const r = c.getBoundingClientRect();
    return (
      r.left <= 10 &&
      r.top <= 10 &&
      r.width >= window.innerWidth * 0.95 &&
      r.height >= window.innerHeight * 0.95
    );
  }

  function syncFullscreen() {
    const is = isPlayerFullscreen();
    if (is === fullscreenActive) return;
    fullscreenActive = is;
    // 用 visibility 而非 display：display 置回 '' 会抹掉内联的 flex 居中，
    // 导致恢复后 S 跑到球左上角；visibility 保留布局且不接收点击
    if (ball) ball.style.visibility = is ? 'hidden' : 'visible';
    if (toast) toast.style.visibility = is ? 'hidden' : 'visible';
  }

  document.addEventListener('fullscreenchange', syncFullscreen);
  window.addEventListener('resize', syncFullscreen);
  // 高频轮询（150ms，肉眼无感知）：覆盖 B 站网页全屏的类/样式/动画变化
  pollTimer = setInterval(syncFullscreen, 150);

  /* ---------------- 挂载/卸载 ---------------- */

  function mount() {
    if (ball) return;
    ball = document.createElement('div');
    ball.id = 'bili-ai-summary-ball';
    ball.title = 'B站 AI 总结（左键一键总结，可拖动）';
    ball.setAttribute('aria-label', 'B站 AI 总结');
    const s = ball.style;
    Object.assign(s, {
      position: 'fixed',
      zIndex: '2147483647',
      width: SIZE + 'px',
      height: SIZE + 'px',
      borderRadius: '50%',
      background: 'linear-gradient(135deg, #fb7299, #f5746c)',
      color: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '16px',
      fontWeight: '800',
      fontFamily:
        '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      boxShadow: '0 2px 8px rgba(0,0,0,.25)', // 轻阴影，不抢戏
      cursor: 'grab',
      userSelect: 'none',
      touchAction: 'none',
      opacity: '.92',
      transition: 'opacity .15s',
      right: DEFAULT_RIGHT + 'px', // 默认位置：右上角
      top: DEFAULT_TOP + 'px',
    });
    // 悬浮球 S 与扩展图标同源（DejaVu Sans Bold 真字形，SVG 内联）
    ball.innerHTML = '<svg viewBox="71.8 -742.2 575.2 756.3" style="width:58%;height:58%"><path d="M599.12-706.05L599.12-551.76Q539.06-578.61 481.93-592.29Q424.80-605.96 374.02-605.96Q306.64-605.96 274.41-587.40Q242.19-568.85 242.19-529.79Q242.19-500.49 263.92-484.13Q285.64-467.77 342.77-456.05L422.85-439.94Q544.43-415.53 595.70-365.72Q646.97-315.92 646.97-224.12Q646.97-103.52 575.44-44.68Q503.91 14.16 356.93 14.16Q287.60 14.16 217.77 0.98Q147.95-12.21 78.13-38.09L78.13-196.78Q147.95-159.67 213.13-140.87Q278.32-122.07 338.87-122.07Q400.39-122.07 433.11-142.58Q465.82-163.09 465.82-201.17Q465.82-235.35 443.60-253.91Q421.39-272.46 354.98-287.11L282.23-303.22Q172.85-326.66 122.31-377.93Q71.78-429.20 71.78-516.11Q71.78-625 142.09-683.59Q212.40-742.19 344.24-742.19Q404.30-742.19 467.77-733.15Q531.25-724.12 599.12-706.05" fill="#fff"/></svg>';
    // 恢复记忆位置（若有）
    try {
      chrome.storage.local.get(POS_KEY).then((v) => {
        if (!extensionAlive()) {
          onInvalidated();
          return;
        }
        const p = v[POS_KEY];
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          s.left = Math.round(p.x) + 'px';
          s.top = Math.round(p.y) + 'px';
          s.right = 'auto';
        }
      });
    } catch (e) {
      if (!extensionAlive()) onInvalidated();
    }
    document.documentElement.appendChild(ball);
    ball.addEventListener('mouseenter', () => {
      ball.style.opacity = '1';
    });
    ball.addEventListener('mouseleave', () => {
      ball.style.opacity = '.92';
    });
    initDrag();
    initToast();
    syncFullscreen(); // 若加载时已处于全屏（如刷新后自动全屏）立即隐藏
  }

  function unmount() {
    if (toast) {
      toast.remove();
      toast = null;
    }
    if (ball) {
      ball.remove();
      ball = null;
    }
  }

  /* ---------------- 拖动（区分点击与拖拽） ---------------- */

  let dragging = false;
  let moved = false;
  let sx = 0,
    sy = 0,
    sl = 0,
    st = 0;

  function clamp(v, min, max) {
    return Math.min(Math.max(v, min), max);
  }

  function initDrag() {
    ball.addEventListener('pointerdown', (e) => {
      dragging = true;
      moved = false;
      sx = e.clientX;
      sy = e.clientY;
      const r = ball.getBoundingClientRect();
      sl = r.left;
      st = r.top;
      ball.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    ball.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 4) {
        moved = true;
        ball.style.cursor = 'grabbing';
      }
      if (moved) {
        const x = clamp(sl + dx, 0, window.innerWidth - SIZE);
        const y = clamp(st + dy, 0, window.innerHeight - SIZE);
        ball.style.left = x + 'px';
        ball.style.top = y + 'px';
        ball.style.right = 'auto';
      }
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      ball.style.cursor = 'grab';
      if (moved) {
        if (!extensionAlive()) {
          onInvalidated();
          return;
        }
        const r = ball.getBoundingClientRect();
        try {
          chrome.storage.local.set({ [POS_KEY]: { x: r.left, y: r.top } });
        } catch (e) {
          if (!extensionAlive()) onInvalidated();
        }
      }
    };
    ball.addEventListener('pointerup', endDrag);
    ball.addEventListener('pointercancel', endDrag);
    ball.addEventListener('click', (e) => {
      if (moved) {
        e.stopPropagation();
        return;
      }
      startSummary();
    });
  }

  /* ---------------- 进度提示 toast ---------------- */

  function initToast() {
    toast = document.createElement('div');
    toast.id = 'bili-ai-summary-toast';
    const t = toast.style;
    Object.assign(t, {
      position: 'fixed',
      zIndex: '2147483647',
      maxWidth: '280px',
      padding: '8px 12px',
      borderRadius: '8px',
      background: 'rgba(30,31,36,.96)',
      color: '#e8e8ec',
      fontSize: '12px',
      lineHeight: '1.5',
      fontFamily:
        '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      boxShadow: '0 4px 16px rgba(0,0,0,.3)',
      pointerEvents: 'none',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
      display: 'none',
    });
    document.documentElement.appendChild(toast);
  }

  let toastTimer = null;
  function showToast(text, kind) {
    if (!toast || !ball) return;
    clearTimeout(toastTimer);
    toast.textContent = text;
    toast.style.color = kind === 'err' ? '#ff7b72' : kind === 'ok' ? '#7ee787' : '#e8e8ec';
    const r = ball.getBoundingClientRect();
    let x = r.left;
    const y = r.bottom + 10;
    x = clamp(x, 8, window.innerWidth - 292); // 不超出视口
    toast.style.left = x + 'px';
    toast.style.top = y + 'px';
    toast.style.display = 'block';
    if (kind === 'ok' || kind === 'err') {
      toastTimer = setTimeout(() => {
        if (toast) toast.style.display = 'none';
      }, kind === 'ok' ? 5000 : 10000);
    }
  }

  /* ---------------- 一键总结（复用后台 run 流程） ---------------- */

  function startSummary() {
    if (running) return;
    running = true;
    showToast('正在读取页面信息…');
    let port;
    try {
      port = chrome.runtime.connect({ name: 'bili-summary' });
    } catch (e) {
      running = false;
      if (!extensionAlive()) {
        onInvalidated();
        return;
      }
      showToast('❌ 扩展未就绪，请刷新页面后重试', 'err');
      return;
    }
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === 'status') {
        showToast(msg.text);
      } else if (msg.type === 'done') {
        running = false;
        showToast('✅ ' + (msg.text || '完成'), 'ok');
        safeDisconnect(port);
      } else if (msg.type === 'error') {
        running = false;
        showToast('❌ ' + (msg.text || '未知错误'), 'err');
        safeDisconnect(port);
      }
    });
    port.onDisconnect.addListener(() => {
      if (running) {
        running = false;
        showToast('❌ 连接中断（页面可能已刷新/关闭）', 'err');
      }
    });
    try {
      port.postMessage({ type: 'run' }); // tabId 由后台从 port.sender.tab 取
    } catch (e) {
      /* 连接已失效，忽略 */
    }
  }
})();
