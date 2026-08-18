'use strict';

/* ==================== 历史记录 IndexedDB 封装 ====================
 * 供 MV3 Service Worker（background.js 经 importScripts 引入）与扩展页面
 * （viewer / history，经 <script> 引入）共用 —— 它们同属扩展源，
 * 读写的是同一份数据。
 *
 * 注意：不要在 content script 里用本库 —— content script 的 IndexedDB
 * 属于页面源（bilibili.com），不是扩展源，历史数据必须由扩展上下文访问。
 */
(function (global) {
  const DB_NAME = 'bili-ai-summary';
  const DB_VERSION = 1;
  const STORE = 'history';

  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const store = db.createObjectStore(STORE, { keyPath: 'id' });
            store.createIndex('createdAt', 'createdAt');
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          dbPromise = null;
          reject(req.error);
        };
      });
    }
    return dbPromise;
  }

  function promisify(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const api = {
    /** 写入一条历史记录（记录结构见 background.js run() 第 4 步） */
    async add(record) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).put(record);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    },

    async get(id) {
      const db = await open();
      const r = await promisify(db.transaction(STORE).objectStore(STORE).get(id));
      return r || null;
    },

    /** 全部记录（调用方自行按 createdAt 倒序） */
    async getAll() {
      const db = await open();
      const list = await promisify(db.transaction(STORE).objectStore(STORE).getAll());
      return list || [];
    },

    async remove(id) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).delete(id);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    },
  };

  global.BiliSummaryDB = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
