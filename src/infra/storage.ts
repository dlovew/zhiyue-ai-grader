  // src/infra/storage.ts
  var STORAGE_KEYS = {
    config: "zygr.config.v1",
    history: "zygr.history.v1",
    cache: "zygr.cache.v1"
  };
  function readJson(key, fallback) {
    try {
      const raw = GM_getValue(key);
      if (typeof raw !== "string" || raw.length === 0) return fallback;
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }
  function writeJson(key, value) {
    try {
      GM_setValue(key, JSON.stringify(value));
      return true;
    } catch {
      console.warn("[\u667A\u9605\u6279\u6539\u52A9\u624B] \u6570\u636E\u4FDD\u5B58\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u6CB9\u7334\u5B58\u50A8\u914D\u989D");
      return false;
    }
  }
  function removeKey(key) {
    try {
      GM_setValue(key, "");
    } catch {
      console.warn("[\u667A\u9605\u6279\u6539\u52A9\u624B] \u6570\u636E\u6E05\u7406\u5931\u8D25");
    }
  }

