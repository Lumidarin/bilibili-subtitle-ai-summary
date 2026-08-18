'use strict';

const $ = (id) => document.getElementById(id);

/* 极简 Markdown 渲染（仅覆盖本扩展输出用到的语法） */
function render(md) {
  const esc = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) =>
    esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');

  const lines = String(md || '').split('\n');
  let html = '';
  let listOpen = false;
  const closeList = () => {
    if (listOpen) { html += '</ul>'; listOpen = false; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^###\s+/.test(line)) { closeList(); html += `<h3>${inline(line.replace(/^###\s+/, ''))}</h3>`; }
    else if (/^##\s+/.test(line)) { closeList(); html += `<h2>${inline(line.replace(/^##\s+/, ''))}</h2>`; }
    else if (/^#\s+/.test(line)) { closeList(); html += `<h1>${inline(line.replace(/^#\s+/, ''))}</h1>`; }
    else if (/^>/.test(line)) { closeList(); html += `<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`; }
    else if (/^-{3,}$/.test(line)) { closeList(); html += '<hr>'; }
    else if (/^\s*-\s+/.test(line)) {
      if (!listOpen) { html += '<ul>'; listOpen = true; }
      html += `<li>${inline(line.replace(/^\s*-\s+/, ''))}</li>`;
    }
    else if (/^\s*$/.test(line)) { closeList(); }
    else { closeList(); html += `<p>${inline(line)}</p>`; }
  }
  closeList();
  return html;
}

/* 兼容旧版瞬态 lastSummary（local/session 双读带重试） */
async function findSummary() {
  const areas = ['local', 'session'];
  for (let i = 0; i < 3; i++) {
    for (const area of areas) {
      try {
        const r = await chrome.storage[area].get('lastSummary');
        if (r && r.lastSummary && r.lastSummary.md) {
          await chrome.storage[area].remove('lastSummary');
          return r.lastSummary;
        }
      } catch (e) {
        console.warn('[viewer] 读取 lastSummary(' + area + ') 失败：', e);
      }
    }
    if (i < 2) await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

(async () => {
  // 1. 优先按 ?id= 从历史库读取
  const id = new URLSearchParams(location.search).get('id');
  let record = null;
  if (id) {
    try {
      record = await BiliSummaryDB.get(id);
    } catch (e) {
      console.warn('[viewer] 读取历史记录失败：', e);
    }
  }
  // 2. 回退：旧版瞬态 lastSummary（后台不再写入，仅为兼容旧数据）
  if (!record) {
    const last = await findSummary();
    if (last && last.md) {
      record = {
        title: last.filename || '',
        filename: String(last.filename || '').split('/').pop() || '总结.md',
        md: last.md,
      };
    }
  }
  if (!record || !record.md) {
    document.getElementById('content').outerHTML =
      '<div class="empty">没有找到这条总结记录（可能已被删除）。请回到 B 站视频页重新生成。</div>';
    return;
  }

  document.title = `【AI总结】${record.title || ''}`;
  $('savedPath').textContent = record.title || '';
  $('content').innerHTML = render(record.md);

  // 3. 下载 .md（扩展页可用 URL.createObjectURL + blob URL，无 data URL 2MB 限制）
  const { folder } = await chrome.storage.local.get({ folder: 'AI总结视频' });
  const dlPath = `${folder}/${record.filename || '总结.md'}`;
  $('downloadBtn').hidden = false;
  $('downloadBtn').addEventListener('click', async () => {
    const blob = new Blob([record.md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({
        url,
        filename: dlPath,
        conflictAction: 'uniquify',
        saveAs: false,
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  });

  $('closeBtn').addEventListener('click', () => window.close());
})();
