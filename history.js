'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let all = []; // 全量记录，渲染时按搜索词过滤

function fmtTs(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function fmtTime(ms) {
  const d = new Date(ms || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function snippet(md) {
  const line = String(md || '')
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s && !/^#/.test(s));
  return line ? line.slice(0, 90) : '';
}

async function load() {
  all = await BiliSummaryDB.getAll();
  all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); // 时间倒序
  render();
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const list = q
    ? all.filter(
        (r) =>
          (r.title || '').toLowerCase().includes(q) ||
          (r.md || '').toLowerCase().includes(q)
      )
    : all;

  $('count').textContent = `${list.length} / ${all.length}`;
  const box = $('list');
  box.innerHTML = '';

  if (!all.length) {
    box.innerHTML =
      '<div class="empty">还没有任何总结记录。<br>在 B 站视频页点粉色悬浮球，或点扩展图标 → 「一键生成 AI 总结」即可。</div>';
    return;
  }
  if (!list.length) {
    box.innerHTML = `<div class="empty">没有匹配「${esc($('search').value)}」的记录</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  for (const r of list) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="row-main">
        <div class="title"></div>
        <div class="meta"></div>
        <div class="snip"></div>
      </div>
      <button class="del" title="删除该记录">🗑</button>`;
    row.querySelector('.title').textContent = r.title || '未命名视频';
    const parts = [fmtTime(r.createdAt || Date.now())];
    if (r.duration) parts.push(`时长 ${fmtTs(r.duration)}`);
    if (r.bvid) parts.push(r.bvid);
    row.querySelector('.meta').textContent = parts.join(' ｜ ');
    row.querySelector('.snip').textContent = snippet(r.md);

    row.querySelector('.del').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`删除「${r.title || '未命名'}」这条总结记录？`)) {
        BiliSummaryDB.remove(r.id).then(load).catch((err) => {
          alert('删除失败：' + err.message);
        });
      }
    });
    row.addEventListener('click', () => {
      chrome.tabs.create({
        url: chrome.runtime.getURL('viewer.html?id=' + encodeURIComponent(r.id)),
      });
    });
    frag.appendChild(row);
  }
  box.appendChild(frag);
}

document.addEventListener('DOMContentLoaded', () => {
  $('search').addEventListener('input', render);
  load().catch((e) => {
    $('list').innerHTML = `<div class="empty">读取历史失败：${esc(e.message)}</div>`;
  });
});
