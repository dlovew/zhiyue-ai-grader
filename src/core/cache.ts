// src/core/cache.ts
function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function makeGradeCacheKey(input) {
  const payload = JSON.stringify({
    question: input.context.question || input.question.questionText,
    answer: input.context.answer,
    rubric: input.context.rubric,
    maxScore: input.context.maxScore,
    subs: input.question.subQuestions,
    images: input.question.images,
    model: input.model,
    image: input.image,
    thinkingMode: input.thinkingMode,
    pipeline: "vlm"
  });
  return `grade:${hashString(payload)}:${input.promptVersion}`;
}
// 入库前去冗余：模型原文（raw）与 cacheKey 只在当前会话需要，存进缓存会白占配额。
var CACHE_RESULT_FIELDS = ["status", "score", "subScores", "reason", "confidence", "maxScore", "pipeline", "needsReview", "reviewReasons", "model", "createdAt"];
function compactCacheResult(result) {
  if (!isRecord(result)) return result;
  const compact = {};
  for (const key of CACHE_RESULT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(result, key)) compact[key] = result[key];
  }
  if (Array.isArray(result.subScores)) {
    compact.subScores = result.subScores.map((item) => ({
      label: String(item?.label ?? ""),
      score: Number(item?.score) || 0,
      maxScore: Number(item?.maxScore) || 0,
      reason: String(item?.reason ?? "")
    }));
  }
  return compact;
}
var CACHE_WRITE_DELAY = 1200;
var CacheStore = class {
  constructor(ttlDays, maxEntries = 2000, options = {}) {
    this.ttlDays = ttlDays;
    this.maxEntries = Math.max(50, Math.min(2e4, Number(maxEntries) || 2000));
    this.onStorageError = typeof options?.onStorageError === "function" ? options.onStorageError : null;
    const raw = readJson(STORAGE_KEYS.cache, {});
    this.data = isRecord(raw) ? raw : {};
    this.dirty = false;
    this.timer = 0;
    this.warned = false;
    this.prune();
  }
  // 只淘汰一批（10%），避免每次写入都对全表排序；返回是否有变化。
  prune() {
    const now = Date.now();
    const limit = this.ttlDays * 864e5;
    let changed = false;
    for (const [key, envelope] of Object.entries(this.data)) {
      if (!isRecord(envelope) || now - Number(envelope.savedAt || 0) > limit) {
        delete this.data[key];
        changed = true;
      }
    }
    const keys = Object.keys(this.data);
    if (keys.length > this.maxEntries) {
      const drop = Math.max(1, Math.ceil(keys.length * 0.1));
      keys.sort((a, b) => Number(this.data[a].savedAt || 0) - Number(this.data[b].savedAt || 0)).slice(0, drop).forEach((key) => {
        delete this.data[key];
        changed = true;
      });
    }
    return changed;
  }
  get(key) {
    const envelope = this.data[key];
    if (!isRecord(envelope)) return void 0;
    return envelope.data;
  }
  set(key, data) {
    this.data[key] = { v: 2, savedAt: Date.now(), data: compactCacheResult(data) };
    this.prune();
    this.scheduleWrite();
  }
  // 批改是连续的高频操作，逐条写盘会让每次批改都序列化整张缓存表；
  // 这里合并成定时批量写入，页面关闭时由 flush 兜底。
  scheduleWrite() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.flush();
    }, CACHE_WRITE_DELAY);
  }
  flush() {
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = 0;
    }
    if (!this.dirty) return true;
    const ok = writeJson(STORAGE_KEYS.cache, this.data);
    if (ok) {
      this.dirty = false;
      return true;
    }
    if (!this.warned) {
      this.warned = true;
      this.onStorageError?.();
    }
    return false;
  }
  clear() {
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = 0;
    }
    this.data = {};
    this.dirty = false;
    removeKey(STORAGE_KEYS.cache);
  }
  size() {
    return Object.keys(this.data).length;
  }
};
