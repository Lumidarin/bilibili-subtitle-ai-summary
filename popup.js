'use strict';

const $ = (id) => document.getElementById(id);
const runBtn = $('runBtn');
const statusEl = $('status');
const titleEl = $('videoTitle');

function setStatus(kind, text) {
  statusEl.textContent = text;
  statusEl.className = 'status ' + kind;
}

document.addEventListener('DOMContentLoaded', async () => {
  $('settingsLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // 悬浮球开关（content script 监听 storage 变化实时显隐）
  const ballToggle = $('ballToggle');
  chrome.storage.local.get({ floatBall: true }).then((v) => {
    ballToggle.checked = v.floatBall !== false;
  });
  ballToggle.addEventListener('change', () => {
    chrome.storage.local.set({ floatBall: ballToggle.checked });
  });

  // 历史记录
  $('historyLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !/^https:\/\/(www\.)?bilibili\.com\//.test(tab.url || '')) {
    setStatus('error', '请在 B 站视频页面使用本扩展');
    return;
  }

  try {
    const res = await chrome.runtime.sendMessage({ type: 'meta', tabId: tab.id });
    if (res && res.ok) {
      titleEl.textContent = res.title || '（未识别到标题）';
      runBtn.disabled = false;
    } else {
      setStatus('error', (res && res.reason) || '无法读取视频信息，请刷新页面后重试');
    }
  } catch (e) {
    setStatus('error', '扩展未就绪，请稍后重试');
  }

  runBtn.addEventListener('click', () => run(tab.id));
});

function run(tabId) {
  runBtn.disabled = true;
  setStatus('working', '正在抓取字幕…');

  const port = chrome.runtime.connect({ name: 'bili-summary' });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'status') {
      setStatus('working', msg.text);
    } else if (msg.type === 'done') {
      setStatus('ok', '✅ 已保存：' + (msg.text || '未知路径'));
      runBtn.disabled = false;
      port.disconnect();
    } else if (msg.type === 'error') {
      setStatus('error', '❌ ' + (msg.text || '未知错误'));
      runBtn.disabled = false;
      port.disconnect();
    }
  });
  port.postMessage({ type: 'run', tabId });
}
