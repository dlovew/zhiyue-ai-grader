// 存储封装：GM 优先，缺失时退回 localStorage（便于本地调试）。
(function (root) {
  'use strict';
  var ZG = (root.ZG = root.ZG || {});

  var hasGM =
    typeof GM_getValue === 'function' &&
    typeof GM_setValue === 'function';

  function rawGet(key, def) {
    try {
      if (hasGM) {
        var v = GM_getValue(key);
        return v === undefined ? def : v;
      }
      var s = root.localStorage ? root.localStorage.getItem('zg:' + key) : null;
      return s === null ? def : s;
    } catch (e) {
      ZG.log && ZG.log('warn', '读取存储失败', key, e && e.message);
      return def;
    }
  }

  function rawSet(key, value) {
    try {
      if (hasGM) {
        GM_setValue(key, value);
        return true;
      }
      if (root.localStorage) {
        root.localStorage.setItem('zg:' + key, String(value));
        return true;
      }
    } catch (e) {
      ZG.log && ZG.log('warn', '写入存储失败', key, e && e.message);
    }
    return false;
  }

  function rawDel(key) {
    try {
      if (hasGM && typeof GM_deleteValue === 'function') GM_deleteValue(key);
      else if (root.localStorage) root.localStorage.removeItem('zg:' + key);
    } catch (e) {
      /* ignore */
    }
  }

  // 读取 JSON 值；解析失败时把原文存到 rescue 键，交由调用方决定降级。
  function readJson(key, fallback, rescueKey) {
    var v = rawGet(key, undefined);
    if (v === undefined || v === null || v === '') return fallback;
    if (typeof v === 'object') return v;
    try {
      return JSON.parse(v);
    } catch (e) {
      if (rescueKey) rawSet(rescueKey, String(v));
      ZG.log && ZG.log('warn', '配置解析失败，已备份原文', key);
      return { __corrupt: true, raw: v };
    }
  }

  function writeJson(key, value) {
    return rawSet(key, JSON.stringify(value));
  }

  ZG.store = {
    get: rawGet,
    set: rawSet,
    del: rawDel,
    readJson: readJson,
    writeJson: writeJson,
    hasGM: hasGM,
  };
})(typeof window !== 'undefined' ? window : globalThis);
