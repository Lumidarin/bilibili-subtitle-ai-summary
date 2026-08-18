'use strict';

const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  folder: 'AI总结视频',
  chunkChars: 20000,
  temperature: 0.3,
  autoOpen: true,
};

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', async () => {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  $('baseUrl').value = cfg.baseUrl;
  $('apiKey').value = cfg.apiKey;
  $('model').value = cfg.model;
  $('folder').value = cfg.folder;
  $('chunkChars').value = cfg.chunkChars;
  $('temperature').value = cfg.temperature;
  $('autoOpen').checked = !!cfg.autoOpen;

  $('saveBtn').addEventListener('click', async () => {
    const next = {
      baseUrl: $('baseUrl').value.trim(),
      apiKey: $('apiKey').value.trim(),
      model: $('model').value.trim(),
      folder: $('folder').value.trim() || 'AI总结视频',
      chunkChars: Math.max(2000, parseInt($('chunkChars').value, 10) || 20000),
      temperature: Math.min(2, Math.max(0, parseFloat($('temperature').value) || 0.3)),
      autoOpen: $('autoOpen').checked,
    };
    await chrome.storage.local.set(next);
    flash('已保存 ✔', 'ok');
  });

  $('testBtn').addEventListener('click', async () => {
    const baseUrl = $('baseUrl').value.trim().replace(/\/+$/, '');
    const apiKey = $('apiKey').value.trim();
    const model = $('model').value.trim() || 'deepseek-chat';
    if (!apiKey) {
      flash('请先填写 API Key', 'err');
      return;
    }
    $('testBtn').disabled = true;
    $('testBtn').textContent = '测试中…';
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      });
      if (!res.ok) {
        let d = '';
        try {
          const j = await res.json();
          d = (j && j.error && j.error.message) || '';
        } catch (e) {
          /* ignore */
        }
        throw new Error(`HTTP ${res.status}${d ? '：' + d : ''}`);
      }
      flash('连接成功 ✔ 接口与 Key 可用', 'ok');
    } catch (e) {
      flash(`测试失败：${e.message}`, 'err');
    } finally {
      $('testBtn').disabled = false;
      $('testBtn').textContent = '测试连接';
    }
  });
});

function flash(text, kind) {
  const el = $('saveMsg');
  el.textContent = text;
  el.className = 'msg ' + kind;
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.textContent = '';
    el.className = 'msg';
  }, 6000);
}
