// src/core/cache.ts
function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
// 图片地址归一化：OSS 签名参数每次都变，剥掉签名只留资源路径与裁剪参数，键才跨会话稳定。
function stableImageKey(src) {
  if (!src) return "";
  if (/^data:/i.test(src)) return `data:${src.length}:${hashString(src)}`;
  try {
    const url = new URL(src, "https://www.zhixue.com/");
    if (!/^https?:$/.test(url.protocol)) return String(src);
    const crop = (url.searchParams.get("x-oss-process") || "").split("/").filter((op) => /^crop(?:,|$)/.test(op));
    if (crop.length) url.searchParams.set("x-oss-process", `image/${crop.join("/")}`);
    else url.searchParams.delete("x-oss-process");
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:Expires|OSSAccessKeyId|Signature|Policy|Key-Pair-Id|x-amz-.*)$/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    url.searchParams.sort();
    return url.href;
  } catch {
    return String(src);
  }
}
function makeGradeCacheKey(input) {
  // 有接口身份时优先用它：同一份卷在不同账号、不同签名下都是同一个键，双评才能共享缓存。
  const identity = input.identity && input.identity.scanRecordId
    ? `scan:${input.identity.scanRecordId}|${input.identity.topicNumStr || ""}`
    : "";
  const images = identity
    ? [identity]
    : (Array.isArray(input.question.images) ? input.question.images.map(stableImageKey) : []);
  const payload = JSON.stringify({
    question: input.context.question || input.question.questionText,
    answer: input.context.answer,
    rubric: input.context.rubric,
    maxScore: input.context.maxScore,
    subs: input.question.subQuestions,
    images,
    model: input.model,
    image: input.image,
    thinkingMode: input.thinkingMode,
    // 输出档位决定提示词与 max_tokens，必须进键，否则切档会命中旧档的结果。
    outputMode: input.outputMode || "standard",
    pipeline: "vlm"
  });
  // v2：键结构变了（图片地址归一化 + 接口身份），旧缓存一次性失效。
  return `grade:v2:${hashString(payload)}:${input.promptVersion}`;
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
// 用量统计：只读响应自带的 usage 与本地命中计数，不产生任何额外请求或 token。
function loadUsageStats() {
  const raw = readJson(STORAGE_KEYS.stats, {});
  const stats = isRecord(raw) ? raw : {};
  return {
    graded: Number(stats.graded || 0),
    localHits: Number(stats.localHits || 0),
    requests: Number(stats.requests || 0),
    promptTokens: Number(stats.promptTokens || 0),
    cachedTokens: Number(stats.cachedTokens || 0),
    completionTokens: Number(stats.completionTokens || 0),
    reasoningTokens: Number(stats.reasoningTokens || 0)
  };
}
function recordUsage(entry) {
  const stats = loadUsageStats();
  const next = {
    graded: stats.graded + (entry?.graded ? 1 : 0),
    localHits: stats.localHits + (entry?.localHit ? 1 : 0),
    requests: stats.requests + (entry?.request ? 1 : 0),
    promptTokens: stats.promptTokens + Number(entry?.prompt || 0),
    cachedTokens: stats.cachedTokens + Number(entry?.cached || 0),
    completionTokens: stats.completionTokens + Number(entry?.completion || 0),
    reasoningTokens: stats.reasoningTokens + Number(entry?.reasoning || 0)
  };
  writeJson(STORAGE_KEYS.stats, next);
  return next;
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
