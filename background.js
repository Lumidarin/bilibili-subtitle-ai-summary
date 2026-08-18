'use strict';

importScripts('db.js'); // 历史记录 IndexedDB 封装（SW 与扩展页共用）

/* ==================== 配置 ==================== */

const DEFAULT_CONFIG = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  folder: 'AI总结视频',
  chunkChars: 20000,
  temperature: 0.3,
  autoOpen: true,
};

// data URL 下载上限：Chrome 对超大 data URL 的下载会静默失败（约 2MB 量级），
// 超限时跳过自动下载，改由查看页用 blob URL 下载（无此限制）
const MAX_DATA_URL = 1800000;

let config = { ...DEFAULT_CONFIG };
const configReady = loadConfig();
function loadConfig() {
  return chrome.storage.local.get(DEFAULT_CONFIG).then((v) => {
    config = { ...DEFAULT_CONFIG, ...v };
    return config;
  });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') loadConfig();
});

/* ==================== 页面信息抓取 ====================
 * grabState 会被 chrome.scripting.executeScript 序列化后注入页面 MAIN world 执行，
 * 因此只能使用 window / document / location，不能引用外部变量。
 */
function grabState() {
  const pi = window.__playinfo__ || null;
  const iss = window.__INITIAL_STATE__ || null;
  const videoData = iss && (iss.videoData || null);
  const mediaInfo = iss && (iss.mediaInfo || null);
  // 稍后再看 / 收藏夹等 /list/ 页面：视频信息在 URL 参数里（bvid、oid=aid）
  let qBvid = null;
  let qAid = null;
  try {
    const qp = new URLSearchParams(location.search);
    qBvid = qp.get('bvid');
    const oid = Number(qp.get('oid'));
    if (Number.isFinite(oid) && oid > 0) qAid = oid;
  } catch (e) { /* ignore */ }
  const subtitles =
    pi && Array.isArray(pi.data && pi.data.subtitle && pi.data.subtitle.subtitles)
      ? pi.data.subtitle.subtitles
      : null;
  const cid =
    (typeof window.cid !== 'undefined' && window.cid) ||
    (pi && pi.data && pi.data.cid) ||
    (videoData && videoData.cid) ||
    null;
  const aid =
    (typeof window.aid !== 'undefined' && window.aid) ||
    (pi && pi.data && pi.data.aid) ||
    (videoData && videoData.aid) ||
    qAid ||
    null;
  const bvid =
    (typeof window.bvid !== 'undefined' && window.bvid) ||
    (videoData && videoData.bvid) ||
    (iss && iss.bvid) ||
    (location.href.match(/\/video\/(BV[0-9A-Za-z]+)/) || [])[1] ||
    qBvid ||
    null;
  const title = (videoData && videoData.title) || (mediaInfo && mediaInfo.title) || '';
  const duration = pi && pi.data && pi.data.duration;
  return {
    aid,
    cid,
    bvid,
    title,
    url: location.href.split('?')[0],
    duration: Number.isFinite(duration) ? duration : null,
    subtitles,
  };
}

async function grabPage(tabId) {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: grabState,
      });
      if (res && res.result) return res.result;
    } catch (e) {
      lastErr = e;
      if (i < 2) await sleep(1200);
    }
  }
  throw lastErr || new Error('无法读取页面信息');
}

/* ==================== 消息：meta（popup 打开时） ==================== */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'meta') return false;
  handleMeta(msg.tabId).then(sendResponse);
  return true; // 异步响应
});

async function handleMeta(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isBilibiliVideoUrl(tab.url || '')) {
    return { ok: false, reason: '请在 B 站视频页面使用本扩展' };
  }
  try {
    const state = await grabPage(tabId);
    return { ok: true, title: state.title || '（未识别到标题）' };
  } catch (e) {
    return { ok: false, reason: friendly(e) };
  }
}

function isBilibiliVideoUrl(url) {
  if (!/^https:\/\/www\.bilibili\.com\//.test(url || '')) return false;
  try {
    const u = new URL(url);
    if (/^\/(video\/BV|bangumi\/play\/)/.test(u.pathname)) return true;
    if (u.searchParams.get('bvid')) return true; // 稍后再看 / 收藏夹等 /list/ 页面
  } catch (e) { /* ignore */ }
  return false;
}

/* ==================== 消息：run（长连接，带进度） ==================== */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'bili-summary') return;
  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== 'run') return;
    // popup 显式传 tabId；悬浮球（content script）不传，用 port.sender.tab 兜底
    const tabId =
      msg.tabId ||
      (port.sender && port.sender.tab && port.sender.tab.id);
    if (!tabId) {
      post(port, 'error', '无法获取标签页信息，请刷新 B 站页面后重试');
      return;
    }
    try {
      await run(port, tabId);
    } catch (e) {
      post(port, 'error', friendly(e));
    }
  });
  port.onDisconnect.addListener(() => {});
});

function post(port, type, text) {
  try {
    port.postMessage({ type, text });
  } catch (e) {
    /* popup 已关闭，忽略 */
  }
}

/* ==================== 主流程 ==================== */

async function run(port, tabId) {
  await configReady; // 确保配置（API Key 等）已加载
  post(port, 'status', '正在读取页面信息…');

  const state = await grabPage(tabId);
  const meta = {
    bvid: state.bvid,
    aid: state.aid,
    cid: state.cid,
    title: state.title || '未命名视频',
    url: state.url,
    duration: state.duration,
  };
  if (!meta.cid && !meta.bvid && !meta.aid) {
    throw new Error('未识别到视频信息，请确认当前是 B 站视频页面');
  }

  // 稍后再看 / 收藏夹等 /list/ 页面可能拿不到 cid/标题/时长，用 view 接口补齐
  if (!meta.cid && (meta.bvid || meta.aid)) {
    post(port, 'status', '正在补全视频信息…');
    try {
      const v = await fetchJson(
        meta.bvid
          ? `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(meta.bvid)}`
          : `https://api.bilibili.com/x/web-interface/view?aid=${encodeURIComponent(meta.aid)}`
      );
      const d = v && v.data;
      if (d) {
        meta.cid = d.cid || meta.cid;
        meta.aid = d.aid || meta.aid;
        meta.bvid = d.bvid || meta.bvid;
        meta.title = d.title || meta.title;
        meta.duration = d.duration || meta.duration;
      }
    } catch (e) {
      /* 补齐失败则继续，后续会给出明确错误 */
    }
  }

  // 1. 获取字幕轨
  post(port, 'status', '正在获取字幕…');
  const tracks = await getTracks(meta, state.subtitles);
  if (!tracks || !tracks.length) {
    throw new Error('该视频没有可用字幕轨（可能 UP 主未开启 CC 字幕）');
  }
  const track = pickTrack(tracks);
  const lines = await fetchSubtitleLines(track);
  if (!lines.length) throw new Error('字幕内容为空');

  // 2. AI 总结（长字幕自动分片 + 合并）
  const lan = track.lan_doc || track.lan || '';
  post(
    port,
    'status',
    `已获取 ${lines.length} 行字幕${lan ? `（${lan} 轨）` : ''}，正在 AI 总结…`
  );
  const chunks = chunkLines(lines, config.chunkChars);
  const summaries = [];
  for (let i = 0; i < chunks.length; i++) {
    post(port, 'status', `AI 总结中（${i + 1}/${chunks.length}）…`);
    summaries.push(await summarizeChunk(meta, chunks[i], i + 1, chunks.length));
  }
  let finalSummary = summaries[0];
  if (summaries.length > 1) {
    post(port, 'status', '正在合并分段总结…');
    finalSummary = await mergeSummaries(summaries);
  }

  // 3. 生成 Markdown（字幕全文由脚本本地拼接，不占用 AI token）
  post(port, 'status', '正在生成 Markdown…');
  const md = buildMarkdown(meta, finalSummary, lines);
  const filename = sanitizeFilename(`【AI总结】${meta.title}.md`);
  const id = `${Date.now()}_${meta.bvid || meta.aid || 'x'}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  // 4. 写入历史记录（IndexedDB，扩展内持久化；历史页/查看页按 id 读取）
  try {
    await BiliSummaryDB.add({
      id,
      bvid: meta.bvid,
      aid: meta.aid,
      cid: meta.cid,
      title: meta.title,
      url: meta.url,
      duration: meta.duration,
      createdAt: Date.now(),
      filename,
      md,
    });
  } catch (e) {
    console.error('写入历史记录失败：', e);
  }

  // 5. 自动下载 .md（data URL 约 2MB 上限；超大文件跳过，改在查看页用 blob URL 下载）
  let savedPath = '';
  const dataUrl = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(md);
  if (dataUrl.length <= MAX_DATA_URL) {
    try {
      // 保存到 Chrome 默认下载目录下的「AI总结视频」子文件夹（自动创建）
      await chrome.downloads.download({
        url: dataUrl,
        filename: `${config.folder}/${filename}`,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      savedPath = `${config.folder}/${filename}`;
    } catch (e) {
      console.warn('自动下载失败：', e);
    }
  }

  // 6. 完成后自动打开查看页（按 id 从历史库读取，不再依赖瞬态 storage）
  if (config.autoOpen) {
    try {
      await chrome.tabs.create({
        url: chrome.runtime.getURL('viewer.html?id=' + encodeURIComponent(id)),
      });
    } catch (e) {
      console.error('打开查看页失败：', e);
      post(port, 'status', '⚠️ 自动打开查看页失败，可在历史记录中查看');
    }
  }

  post(
    port,
    'done',
    savedPath
      ? `${savedPath}`
      : '已存入历史记录，请在查看页点击「下载 .md」'
  );
}

/* ==================== 字幕获取 ==================== */

async function getTracks(meta, pageSubtitles) {
  const bases = [];
  if (meta.bvid && meta.cid)
    bases.push(`https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(meta.bvid)}&cid=${meta.cid}`);
  if (meta.aid && meta.cid)
    bases.push(`https://api.bilibili.com/x/player/wbi/v2?aid=${encodeURIComponent(meta.aid)}&cid=${meta.cid}`);
  if (meta.bvid && meta.cid)
    bases.push(`https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(meta.bvid)}&cid=${meta.cid}`);

  // 优先实时接口（分 P 切换后数据最新），失败再退回页面里 __playinfo__ 的数据
  for (const u of bases) {
    try {
      const j = await fetchJson(u);
      const s = j && j.data && j.data.subtitle && j.data.subtitle.subtitles;
      if (Array.isArray(s) && s.length) return s;
    } catch (e) {
      /* 继续尝试下一个 */
    }
  }
  if (Array.isArray(pageSubtitles) && pageSubtitles.length) return pageSubtitles;
  return null;
}

function pickTrack(tracks) {
  const zh = tracks.find(
    (t) => /^zh/i.test(t.lan || '') || /中文/.test(t.lan_doc || '')
  );
  return zh || tracks[0];
}

async function fetchSubtitleLines(track) {
  let u = track.subtitle_url || '';
  if (!u) throw new Error('字幕轨缺少 URL');
  if (u.startsWith('//')) u = 'https:' + u;
  if (!/^https?:/.test(u)) throw new Error('字幕 URL 无效');
  const j = await fetchJson(u);
  const body = Array.isArray(j && j.body) ? j.body : [];
  const lines = body
    .map((s) => ({
      from: Number(s.from),
      content: String(s.content || '').replace(/\s+/g, ' ').trim(),
    }))
    .filter((s) => s.content && Number.isFinite(s.from))
    .map((s) => `[${fmtTs(s.from)}] ${s.content}`);
  if (!lines.length) throw new Error('字幕内容为空');
  return lines;
}

async function fetchJson(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j && j.code !== undefined && j.code !== 0) throw new Error(`API code ${j.code}`);
  return j;
}

/* ==================== AI 调用（OpenAI 兼容） ==================== */

const SYSTEM_SUMMARY = `你是一个视频内容分析助手。用户会提供 B 站视频的字幕，每行格式为 "[MM:SS] 字幕内容"（时间戳来自原文）。请生成一份凝练的中文 Markdown 总结，只包含两部分：

## 核心观点
- 3~8 条要点，每条以 "- " 开头，概括视频的核心观点、结论与关键信息。

## 大纲（带时间戳）
- 按时间顺序分成若干小节，每个小节标题格式为 "### [MM:SS] 小节标题"，标题下用 1~3 条 "- " 要点概括该段内容。

要求：
1. 只输出 Markdown 正文，不要任何开场白或客套话；
2. 时间戳必须来自原文，不要编造；
3. 不要输出字幕全文；
4. 语言：简体中文。`;

const SYSTEM_MERGE = `你是一个视频总结合并助手。下面是同一视频的多段分段总结（每段都包含 "## 核心观点" 和 "## 大纲（带时间戳）"）。请把它们合并成一份统一的 Markdown 总结：去除重复要点、按时间顺序组织大纲小节、保留原有 [MM:SS] 时间戳。输出格式与分段总结完全一致（## 核心观点 / ## 大纲（带时间戳））。只输出 Markdown 正文，不要客套话。`;

async function summarizeChunk(meta, lines, idx, total) {
  return chat([
    { role: 'system', content: SYSTEM_SUMMARY },
    {
      role: 'user',
      content:
        `视频标题：${meta.title}\n视频地址：${meta.url}\n` +
        `以下是第 ${idx}/${total} 段字幕（每行时间戳+内容）：\n` +
        lines.join('\n'),
    },
  ]);
}

async function mergeSummaries(summaries) {
  const body = summaries
    .map((s, i) => `【第 ${i + 1} 段】\n${s}`)
    .join('\n\n');
  return chat([
    { role: 'system', content: SYSTEM_MERGE },
    { role: 'user', content: `分段总结如下：\n\n${body}` },
  ]);
}

async function chat(messages) {
  if (!config.apiKey || !config.apiKey.trim()) {
    throw new Error('未配置 API Key，请打开扩展设置填写（扩展图标右键 → 选项）');
  }
  const base = (config.baseUrl || '').trim().replace(/\/+$/, '') || 'https://api.deepseek.com/v1';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: config.model || 'deepseek-chat',
      messages,
      temperature: Number(config.temperature ?? 0.3),
      max_tokens: 4096,
      stream: false,
    }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = (j && j.error && j.error.message) || JSON.stringify(j).slice(0, 300);
    } catch (e) {
      /* ignore */
    }
    throw new Error(`AI 接口错误（HTTP ${res.status}）：${detail || res.statusText}`);
  }
  const j = await res.json();
  const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!text || !text.trim()) throw new Error('AI 返回内容为空');
  return text.trim();
}

/* ==================== 分片 ==================== */

function chunkLines(lines, maxChars) {
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const line of lines) {
    const n = line.length + 1;
    if (curLen + n > maxChars && cur.length) {
      const tail = cur.slice(-2); // 与下一段重叠 2 行，避免边界断义
      chunks.push(cur);
      cur = tail.slice();
      curLen = tail.reduce((a, b) => a + b.length + 1, 0);
    }
    cur.push(line);
    curLen += n;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/* ==================== Markdown 组装 ==================== */

function buildMarkdown(meta, summary, lines) {
  const date = new Date().toLocaleString('zh-CN', { hour12: false });
  const dur = meta.duration ? ` ｜ 视频时长：${fmtTs(meta.duration)}` : '';
  return [
    `# 【AI总结】${meta.title}`,
    '',
    `> 来源：[${meta.title}](${meta.url}) ｜ 生成时间：${date}${dur}`,
    '',
    summary.trim(),
    '',
    '---',
    '',
    '## 字幕全文',
    '',
    ...lines,
    '',
  ].join('\n');
}

/* ==================== 工具 ==================== */

function fmtTs(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function sanitizeFilename(name) {
  return (
    String(name)
      .replace(/[\\/:*?"<>|\r\n]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || '未命名'
  );
}

function friendly(e) {
  const m = String((e && e.message) || e);
  if (/Cannot access contents of the page|Extension manifest must request permission/i.test(m)) {
    return '无法访问页面，请刷新 B 站页面后重试（刚安装扩展时需刷新已打开的页面）';
  }
  if (/Receiving end does not exist|Could not establish connection/i.test(m)) {
    return '页面未响应，请刷新 B 站页面后重试';
  }
  if (/No tab with id/i.test(m)) return '标签页已关闭，请重新打开视频页面';
  if (/No host permissions|Permission .* denied/i.test(m)) return '缺少权限，请在扩展设置中重新保存配置';
  return m;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
