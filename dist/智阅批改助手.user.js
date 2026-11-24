// ==UserScript==
// @name         智阅批改助手
// @namespace    zygr.local.grader
// @version      1.0.2
// @description  智学网阅卷辅助：读取作答图并结合配置的评分标准进行多模态直评，支持历史导出。
// @match        *://www.zhixue.com/*
// @match        *://zhixue.com/*
// @match        *://*.zhixue.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      zhixue-sc.oss-cn-hangzhou.aliyuncs.com
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==
"use strict";
(() => {
  // src/adapters/zhixue.ts
  var SELECTORS = {
    answerImage: 'div[name="topicImg"] img',
    answerImageNew: ".enhance-definition-bright",
    scoreInput: 'input[type="number"]',
    scorePlaceholder: 'input[placeholder*="\u5206"]',
    topicInputs: "#containter_topicTxt input[name='topicTxt']",
    topicInputsNew: 'input[name="topicTxt"]',
    totalInput: "#txt_marking_all",
    submitButton: "#bnt_save",
    submitText: "\u63D0\u4EA4\u5206\u6570",
    topicIndex: "#currentTopicIndex",
    scoreTotal: "#containter_topicTxt #totalScore"
  };
  function mainDoc() {
    return typeof unsafeWindow !== "undefined" ? unsafeWindow.document : document;
  }
  // 后台标签页 / 最小化窗口时浏览器不做布局，getClientRects() 恒为空。
  // 此时改按样式判断可见性，避免把作答图误判为隐藏导致换卷检测失败。
  function isHiddenView(element) {
    const doc = element.ownerDocument || mainDoc();
    return Boolean(doc?.defaultView && doc.visibilityState === "hidden") || typeof document !== "undefined" && document.visibilityState === "hidden";
  }
  function visible(element) {
    const view = element.ownerDocument?.defaultView;
    if (!view) return true;
    let style;
    try {
      style = view.getComputedStyle(element);
    } catch {
      return true;
    }
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (isHiddenView(element)) return true;
    if (element.getClientRects && !element.getClientRects().length) return false;
    return true;
  }
  function getIframeDoc() {
    const iframe = mainDoc().querySelector("iframe");
    if (!iframe || !visible(iframe)) return null;
    try {
      return iframe.contentDocument ?? iframe.contentWindow?.document ?? null;
    } catch {
      return null;
    }
  }
  function accessibleDocs() {
    const docs = [];
    for (const iframe of Array.from(mainDoc().querySelectorAll("iframe"))) {
      try {
        const doc = iframe.contentDocument ?? iframe.contentWindow?.document ?? null;
        if (doc && !docs.includes(doc)) docs.push(doc);
      } catch {
        continue;
      }
    }
    const main = mainDoc();
    if (!docs.includes(main)) docs.push(main);
    return docs;
  }
  function textOf(doc, selector) {
    return doc.querySelector(selector)?.textContent?.trim() ?? "";
  }
  function normalizeQuestion(value) {
    return value.normalize("NFKC").replace(/\s/g, "").replace(/^第|题$/g, "");
  }
  function resourceKey(src) {
    if (!src) return null;
    if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(src)) {
      let a = 2166136261;
      let b = 5381;
      for (let i = 0; i < src.length; i += 1) {
        a = Math.imul(a ^ src.charCodeAt(i), 16777619);
        b = Math.imul(b, 33) ^ src.charCodeAt(i);
      }
      return `zhixue:inline:${src.length}:${a >>> 0}:${b >>> 0}`;
    }
    try {
      const url = new URL(src, window.location.href);
      if (!/^https?:$/.test(url.protocol)) return null;
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
      return null;
    }
  }
  function isZhixueHost() {
    return window.location.hostname.includes("zhixue.com");
  }
  function hasScoreInput(doc) {
    return Boolean(
      doc.querySelector(SELECTORS.topicInputs) || doc.querySelector(SELECTORS.topicInputsNew) || doc.querySelector(SELECTORS.scorePlaceholder) || doc.querySelector(SELECTORS.scoreInput) || doc.querySelector(SELECTORS.totalInput)
    );
  }
  function hasSubmitButton(doc) {
    return Boolean(doc.querySelector(SELECTORS.submitButton)) || Array.from(doc.querySelectorAll("button")).some((button) => button.textContent?.includes(SELECTORS.submitText));
  }
  async function waitForMarkingDocument(timeout = 1e4) {
    const deadline = Date.now() + timeout;
    let candidate = null;
    while (Date.now() < deadline) {
      for (const doc of accessibleDocs()) {
        if (hasScoreInput(doc) && hasSubmitButton(doc)) return doc;
        if (hasScoreInput(doc)) candidate = doc;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    }
    return candidate;
  }
  function snapshotFrom(root) {
    let images = [];
    for (const selector of [SELECTORS.answerImage, SELECTORS.answerImageNew]) {
      const found = Array.from(root.querySelectorAll(selector)).filter((image) => image.src && visible(image));
      if (found.length > 0) {
        images = found;
        break;
      }
    }
    if (images.length === 0) return { urls: [], keys: [], identity: null, ready: false };
    const urls = [...new Set(images.map((image) => image.currentSrc || image.src))];
    const rawKeys = images.map((image) => resourceKey(image.currentSrc || image.src));
    const keys = rawKeys.filter((key) => Boolean(key));
    const ready = images.every((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
    const identity = keys.length === images.length ? `zhixue:images:${JSON.stringify([...new Set(keys)].sort())}` : null;
    return { urls, keys, identity, ready: Boolean(identity) && ready };
  }
  function answerSnapshot(doc) {
    if (doc) return snapshotFrom(doc);
    for (const root of accessibleDocs()) {
      const snapshot = snapshotFrom(root);
      if (snapshot.urls.length > 0) return snapshot;
    }
    return { urls: [], keys: [], identity: null, ready: false };
  }
  async function gatherAnswerImages(timeout = 25e3) {
    const deadline = Date.now() + timeout;
    let previous = null;
    while (Date.now() < deadline) {
      const snapshot = answerSnapshot();
      if (snapshot.ready && snapshot.identity) {
        if (previous === snapshot.identity) return snapshot.urls;
        previous = snapshot.identity;
      } else {
        previous = null;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    }
    return [];
  }
  function scoreMaximum(element) {
    const values = [Number(element.getAttribute("score")), Number(element.placeholder?.match(/满分\s*(\d+(?:\.\d+)?)/)?.[1])];
    return values.find((value) => Number.isFinite(value) && value > 0) ?? 0;
  }
  function getScoreInputs(doc) {
    const root = doc ?? getIframeDoc() ?? mainDoc();
    const oldSubs = Array.from(root.querySelectorAll(SELECTORS.topicInputs)).filter(visible);
    if (oldSubs.length > 0) {
      return oldSubs.map((element, index) => ({
        element,
        label: element.closest("li")?.querySelector(".label")?.textContent?.trim() || `\u7B2C${index + 1}\u9898`,
        maxScore: scoreMaximum(element),
        index
      }));
    }
    const newSubs = Array.from(root.querySelectorAll(SELECTORS.topicInputsNew)).filter(visible);
    if (newSubs.length > 0) {
      return newSubs.map((element, index) => ({
        element,
        label: `\u7B2C${index + 1}\u9898`,
        maxScore: scoreMaximum(element),
        index
      }));
    }
    const total = root.querySelector(SELECTORS.scorePlaceholder) ?? root.querySelector(SELECTORS.scoreInput) ?? root.querySelector(SELECTORS.totalInput);
    if (!total || !visible(total)) return [];
    return [{ element: total, label: "\u603B\u5206", maxScore: scoreMaximum(total), index: 0 }];
  }
  function readQuestion(doc) {
    const inputs = getScoreInputs(doc);
    if (inputs.length === 0) return null;
    const total = doc.querySelector(SELECTORS.scoreTotal);
    const scoringQuestion = total?.getAttribute("disptitle") || total?.closest("li")?.querySelector(".label")?.textContent?.trim() || "";
    const heading = textOf(doc, SELECTORS.topicIndex);
    const pageId = normalizeQuestion(scoringQuestion) || normalizeQuestion(heading) || new URLSearchParams(window.location.search).get("topicId") || "\u5F53\u524D\u9898\u76EE";
    const maxScore = inputs.reduce((sum, input) => sum + input.maxScore, 0);
    const subQuestions = inputs.length > 1 ? inputs.map((input) => ({ label: input.label, maxScore: input.maxScore })) : [];
    return {
      questionId: pageId,
      questionText: heading,
      maxScore,
      subQuestions,
      images: answerSnapshot(doc).urls
    };
  }
  function checkMaxScore(configured2, doc) {
    const maxima = getScoreInputs(doc).map((input) => input.maxScore).filter((value) => value > 0);
    if (maxima.length === 0) return "";
    const total = maxima.reduce((sum, value) => sum + value, 0);
    if (Math.abs(total - configured2) > 1e-6) {
      return `\u5F53\u524D\u9898\u76EE\u6EE1\u5206\u4E3A${total}\u5206\uFF0C\u6279\u6539\u65B9\u6848\u4E3A${configured2}\u5206\uFF0C\u8BF7\u6838\u5BF9\u540E\u7EE7\u7EED`;
    }
    return "";
  }
  function fillScores(scores, doc) {
    const inputs = getScoreInputs(doc);
    if (inputs.length === 0 || scores.length > inputs.length) return false;
    for (let i = 0; i < inputs.length; i += 1) {
      const score = scores[i];
      if (score === void 0 || score === null || !Number.isFinite(Number(score))) return false;
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) return false;
    for (let i = 0; i < inputs.length; i += 1) {
      const input = inputs[i].element;
      setter.call(input, String(Math.round(Number(scores[i]) * 10) / 10));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    }
    return true;
  }
  function submitGrade(doc) {
    const iframe = getIframeDoc();
    const candidates = [iframe, doc, mainDoc()].filter((item, index, all) => Boolean(item) && all.indexOf(item) === index);
    for (const root of candidates) {
      const byText = Array.from(root.querySelectorAll("button")).find((button2) => button2.textContent?.includes(SELECTORS.submitText));
      const button = byText ?? root.querySelector(SELECTORS.submitButton);
      if (button) {
        button.click();
        return true;
      }
    }
    return false;
  }
  function getPaperIdentity() {
    return answerSnapshot().identity;
  }
  async function waitForNextPaper(oldIdentity, timeout = 25e3) {
    if (!oldIdentity) return false;
    let remaining = timeout;
    let lastTick = Date.now();
    let candidate = null;
    let stable = 0;
    while (remaining > 0) {
      const now = Date.now();
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      // 页面不可见（切到其它标签页/最小化）时暂停倒计时，避免切走一会儿就判定换卷失败。
      if (!hidden) remaining -= now - lastTick;
      lastTick = now;
      const snapshot = answerSnapshot();
      // 换卷只需图片 URL 集合变化，不要求图片已加载完成（后台标签页图片常处于未 complete 状态）。
      if (snapshot.identity && snapshot.identity !== oldIdentity) {
        stable = candidate === snapshot.identity ? stable + 1 : 1;
        candidate = snapshot.identity;
        if (stable >= 2) return true;
      } else {
        candidate = null;
        stable = 0;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    }
    return false;
  }

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

  // src/config.ts
  var DEFAULT_CONFIG = {
    version: 1,
    pipeline: {
      vlm: { endpoint: "", apiKey: "", model: "", platform: "custom", compat: {} },
      thinkingMode: "off",
      maxConcurrent: 2,
      maxRpm: 60,
      maxTpm: 6e4,
      timeoutMs: 12e4
    },
    context: {
      question: "",
      answer: "",
      rubric: "",
      maxScore: 0
    },
    image: {
      profile: "balanced",
      maxEdge: 1600,
      quality: 0.82,
      cropToAnswer: false
    },
    promptVersion: "zygr-prompt-v2",
    historyLimit: 500,
    cacheTtlDays: 30
  };
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function merge(base, patch) {
    if (!isRecord(patch) || !isRecord(base)) return base;
    const result = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in result)) continue;
      const current = result[key];
      result[key] = isRecord(current) && isRecord(value) ? merge(current, value) : value;
    }
    return result;
  }
  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }
  // 校验并规整导出的配置备份；格式不符时返回 null。
  function parseConfigBackup(text) {
    try {
      const data = JSON.parse(String(text || ""));
      if (!isRecord(data) || data.app !== "zygr" || !isRecord(data.config)) return null;
      return {
        config: data.config,
        presets: Array.isArray(data.presets) ? data.presets : [],
        keys: isRecord(data.keys) ? data.keys : {},
        models: isRecord(data.models) ? data.models : {},
        thinkingModes: isRecord(data.thinkingModes) ? data.thinkingModes : {}
      };
    } catch {
      return null;
    }
  }
  function loadConfig() {
    const raw = readJson(STORAGE_KEYS.config, {});
    if (!isRecord(raw) || raw.version !== 1) return clone(DEFAULT_CONFIG);
    const config = merge(DEFAULT_CONFIG, raw);
    const oldPipeline = isRecord(raw.pipeline) ? raw.pipeline : {};
    if (Object.prototype.hasOwnProperty.call(oldPipeline, "disableThinking") && !Object.prototype.hasOwnProperty.call(oldPipeline, "thinkingMode")) {
      config.pipeline.thinkingMode = normalizeThinkingMode(oldPipeline.disableThinking);
    }
    return config;
  }
  function saveConfig(config) {
    return writeJson(STORAGE_KEYS.config, config);
  }
  function validateConfig(config) {
    const errors = [];
    const { pipeline, context } = config;
    const requireService = (name, service, needKey = true) => {
      if (!service.endpoint.trim()) errors.push(`${name}\uFF1A\u8BF7\u586B\u5199\u63A5\u53E3\u5730\u5740`);
      if (!service.model.trim()) errors.push(`${name}\uFF1A\u8BF7\u586B\u5199\u6A21\u578B\u540D\u79F0`);
      if (needKey && !service.apiKey.trim()) errors.push(`${name}\uFF1A\u8BF7\u586B\u5199 API Key`);
    };
    requireService("\u591A\u6A21\u6001\u670D\u52A1", pipeline.vlm);
    if (!context.answer.trim()) errors.push("\u6279\u6539\u4E0A\u4E0B\u6587\uFF1A\u8BF7\u586B\u5199\u53C2\u8003\u7B54\u6848");
    if (!context.rubric.trim()) errors.push("\u6279\u6539\u4E0A\u4E0B\u6587\uFF1A\u8BF7\u586B\u5199\u8BC4\u5206\u6807\u51C6");
    if (!(context.maxScore > 0)) errors.push("\u6279\u6539\u4E0A\u4E0B\u6587\uFF1A\u8BF7\u586B\u5199\u672C\u65B9\u6848\u6EE1\u5206");
    if (pipeline.maxConcurrent < 1 || pipeline.maxConcurrent > 8) errors.push("\u5E76\u53D1\u4E0A\u9650\u9700\u5728 1\u20138 \u4E4B\u95F4");
    if (pipeline.maxRpm < 1) errors.push("RPM \u9884\u7B97\u9700\u5927\u4E8E 0");
    if (pipeline.maxTpm < 1e3) errors.push("TPM \u9884\u7B97\u9700\u4E0D\u5C0F\u4E8E 1000");
    return errors;
  }
  function resetConfig() {
    saveConfig(DEFAULT_CONFIG);
  }
  function clearAllData() {
    removeKey(STORAGE_KEYS.config);
    removeKey(STORAGE_KEYS.history);
    removeKey(STORAGE_KEYS.cache);
    removeKey(PRESET_STORAGE_KEY);
    removeKey(PLATFORM_KEYS_KEY);
    removeKey(PLATFORM_MODELS_KEY);
    removeKey(PLATFORM_THINKING_KEY);
    removeKey("zygr.submit.skipConfirm.v1");
  }

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
      pipeline: "vlm"
    });
    return `grade:${hashString(payload)}:${input.promptVersion}`;
  }
  var CacheStore = class {
    constructor(ttlDays, maxEntries = 300) {
      this.ttlDays = ttlDays;
      this.maxEntries = maxEntries;
      this.data = readJson(STORAGE_KEYS.cache, {});
      this.prune();
    }
    prune() {
      const now = Date.now();
      const limit = this.ttlDays * 864e5;
      for (const [key, envelope] of Object.entries(this.data)) {
        if (!envelope || now - envelope.savedAt > limit) delete this.data[key];
      }
      const keys = Object.keys(this.data);
      if (keys.length > this.maxEntries) {
        keys.sort((a, b) => this.data[a].savedAt - this.data[b].savedAt).slice(0, keys.length - this.maxEntries).forEach((key) => delete this.data[key]);
      }
    }
    get(key) {
      const envelope = this.data[key];
      if (!envelope) return void 0;
      return envelope.data;
    }
    set(key, data) {
      this.data[key] = { v: 1, savedAt: Date.now(), data };
      this.prune();
      writeJson(STORAGE_KEYS.cache, this.data);
    }
    clear() {
      this.data = {};
      removeKey(STORAGE_KEYS.cache);
    }
  };

  // src/core/export.ts
  function loadHistory() {
    const value = readJson(STORAGE_KEYS.history, []);
    return Array.isArray(value) ? value : [];
  }
  function appendHistory(entry, limit) {
    const history = [entry, ...loadHistory()].slice(0, Math.max(1, limit));
    writeJson(STORAGE_KEYS.history, history);
  }
  function clearHistory() {
    removeKey(STORAGE_KEYS.history);
  }
  function csvCell(value) {
    const text = value === void 0 || value === null ? "" : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  }
  function subScoreText(entry) {
    return entry.result.subScores.map((item) => `${item.label}:${item.score}/${item.maxScore}`).join("\uFF1B");
  }
  function toCsv(entries) {
    const header = [
      "\u65F6\u95F4",
      "\u9898\u53F7",
      "\u94FE\u8DEF",
      "\u6A21\u578B",
      "\u72B6\u6001",
      "\u5F97\u5206",
      "\u6EE1\u5206",
      "\u5C0F\u9898\u5206",
      "\u8BC4\u5206\u4F9D\u636E",
      "\u9700\u590D\u6838",
      "\u590D\u6838\u539F\u56E0",
      "\u5DF2\u63D0\u4EA4"
    ];
    const rows = entries.map((entry) => [
      new Date(entry.createdAt).toLocaleString("zh-CN"),
      entry.question.questionId,
      entry.result.pipeline,
      entry.result.model,
      entry.result.status,
      entry.result.score,
      entry.result.maxScore,
      subScoreText(entry),
      entry.result.reason,
      entry.result.needsReview ? "\u662F" : "\u5426",
      entry.result.reviewReasons.join("\uFF1B"),
      entry.submitted ? "\u662F" : "\u5426"
    ]);
    return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function toHtml(entries) {
    const rows = entries.map((entry) => `
    <tr>
      <td>${escapeHtml(new Date(entry.createdAt).toLocaleString("zh-CN"))}</td>
      <td>${escapeHtml(entry.question.questionId)}</td>
      <td>${escapeHtml(entry.result.pipeline)}</td>
      <td>${escapeHtml(entry.result.status)}</td>
      <td>${escapeHtml(entry.result.score)} / ${escapeHtml(entry.result.maxScore)}</td>
      <td>${escapeHtml(subScoreText(entry))}</td>
      <td>${escapeHtml(entry.result.reason)}</td>
      <td>${entry.result.needsReview ? "\u9700\u590D\u6838" : "\u6B63\u5E38"}</td>
    </tr>`).join("");
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u5386\u53F2\u5BFC\u51FA</title>
<style>
body{font:14px/1.6 "PingFang SC",sans-serif;color:#0f172a;background:#f8fafc;margin:24px}
h1{font-size:20px;margin:0 0 16px}table{width:100%;border-collapse:collapse;background:#fff}
th,td{border:1px solid #e2e8f0;padding:8px;vertical-align:top;text-align:left}
th{background:#eef2ff;color:#3730a3}tr:nth-child(even){background:#f8fafc}
</style></head><body><h1>\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u5386\u53F2\u5BFC\u51FA</h1>
<table><thead><tr><th>\u65F6\u95F4</th><th>\u9898\u53F7</th><th>\u94FE\u8DEF</th><th>\u72B6\u6001</th><th>\u5F97\u5206</th><th>\u5C0F\u9898\u5206</th><th>\u4F9D\u636E</th><th>\u6807\u8BB0</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
  }
  function downloadText(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1e3);
  }
  function exportFilename(extension) {
    const now = /* @__PURE__ */ new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `\u667A\u9605\u6279\u6539\u52A9\u624B-\u5386\u53F2-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.${extension}`;
  }

  // src/infra/platforms.ts
  var PRESET_STORAGE_KEY = "zygr.presets.v1";
  var PLATFORM_KEYS_KEY = "zygr.platform.keys.v1";
  var PLATFORM_MODELS_KEY = "zygr.platform.models.v1";
  var PLATFORM_THINKING_KEY = "zygr.platform.thinking.v1";

  // 内置预设只提供建议端点/模型与协议档案；用户已填写的 endpoint / model / apiKey 始终优先。
  // authHeader: bearer | api-key | none；全部请求统一为 Chat Completions。
  // disableThinkingKey / jsonModeKey 为 null 表示不向该平台注入对应字段。
  var BUILTIN_PLATFORM_PRESETS = [
    {
      id: "custom",
      label: "自定义（手动填写）",
      endpoint: "",
      models: [],
      authHeader: "bearer",
      disableThinkingKey: null,
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "opencode-ai",
      label: "opencode.ai（OpenAI 兼容）",
      endpoint: "https://opencode.ai/inference/openai/v1/chat/completions",
      models: ["hy4-flash-free"],
      authHeader: "bearer",
      disableThinkingKey: null,
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "openai",
      label: "OpenAI 官方",
      endpoint: "https://api.openai.com/v1/chat/completions",
      models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
      authHeader: "bearer",
      disableThinkingKey: null,
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "azure-openai",
      label: "Azure OpenAI",
      endpoint: "https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT/chat/completions?api-version=2024-10-21",
      models: ["gpt-4o"],
      authHeader: "api-key",
      disableThinkingKey: null,
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      endpoint: "https://api.deepseek.com/chat/completions",
      models: ["deepseek-chat", "deepseek-reasoner"],
      authHeader: "bearer",
      disableThinkingKey: "thinking",
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "siliconflow",
      label: "硅基流动",
      endpoint: "https://api.siliconflow.cn/v1/chat/completions",
      models: ["Qwen/Qwen2.5-VL-72B-Instruct", "Qwen/Qwen2.5-VL-32B-Instruct", "Qwen/Qwen2.5-VL-7B-Instruct"],
      authHeader: "bearer",
      disableThinkingKey: "enable_thinking",
      // 硅基流动 enable_thinking 只接受布尔值；强度用顶层 reasoning_effort。
      // 官方文档：枚举 high|max，其中 low/medium 会被服务端映射为 high。
      thinkingFields: {
        off: { enable_thinking: false },
        low: { reasoning_effort: "high" },
        high: { reasoning_effort: "high" },
        max: { reasoning_effort: "max" }
      },
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "moonshot",
      label: "Kimi / Moonshot",
      endpoint: "https://api.moonshot.cn/v1/chat/completions",
      models: ["moonshot-v1-8k-vision-preview", "moonshot-v1-32k", "moonshot-v1-128k"],
      authHeader: "bearer",
      disableThinkingKey: null,
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "dashscope",
      label: "通义千问 / DashScope",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      models: ["qwen-vl-max", "qwen-vl-plus", "qwen-plus"],
      authHeader: "bearer",
      disableThinkingKey: "enable_thinking",
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "zhipu",
      label: "智谱 GLM",
      endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      models: ["glm-4v-flash", "glm-4-plus", "glm-4-air", "glm-5.3-flash"],
      authHeader: "bearer",
      disableThinkingKey: "thinking",
      // 智谱官方格式：thinking.type 只接受 enabled（glm-5.x 强制思考），
      // 强度由独立的 reasoning_effort 字段控制（low/high/max，默认 max）。
      // 关闭写了 disabled 会触发错误码 1210「该模型始终思考，不支持关闭思考」。
      thinkingFields: {
        low: { thinking: { type: "enabled" }, reasoning_effort: "low" },
        high: { thinking: { type: "enabled" }, reasoning_effort: "high" },
        max: { thinking: { type: "enabled" }, reasoning_effort: "max" }
      },
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "volcengine-chat",
      label: "火山方舟（Chat）",
      endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
      models: ["doubao-seed-2-1-lite-260915", "doubao-seed-2-1-turbo-260628"],
      authHeader: "bearer",
      disableThinkingKey: "thinking",
      jsonModeKey: "response_format",
      stream: false
    },
    {
      // Cloudflare 端点含账户 ID：请把 {account_id} 替换为 Cloudflare 账户 ID。
      // 鉴权用 Cloudflare API Token（需 Workers AI - Read 权限），走标准 Authorization: Bearer。
      id: "cloudflare-workers-ai",
      label: "Cloudflare Workers AI",
      endpoint: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions",
      models: ["@cf/meta/llama-3.1-8b-instruct-fp8", "@cf/openai/gpt-oss-20b", "@cf/moondream3.1-9B-A2B", "@cf/llava-hf/llava-1.5-7b-hf"],
      authHeader: "bearer",
      disableThinkingKey: null,
      // gpt-oss 等推理模型用顶层 reasoning_effort 控制强度（low/medium/high）。
      // 本插件下拉无 medium，故把 max 归到 high；非推理模型会拒绝该参数，选「不干预」即可。
      thinkingFields: {
        low: { reasoning_effort: "low" },
        high: { reasoning_effort: "high" },
        max: { reasoning_effort: "high" }
      },
      jsonModeKey: null,
      stream: false
    },
  ];

  function normalizeThinkingValues(value) {
    if (!isRecord(value)) return {};
    const result = {};
    for (const mode of ["off", "low", "high", "max"]) {
      if (Object.prototype.hasOwnProperty.call(value, mode) && isRecord(value[mode])) result[mode] = value[mode];
    }
    return result;
  }

  function loadCustomPresets() {
    const raw = readJson(PRESET_STORAGE_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter((item) => isRecord(item) && typeof item.id === "string" && item.id.trim()).map((item) => ({
      id: item.id,
      label: String(item.label || item.id),
      endpoint: String(item.endpoint || ""),
      models: Array.isArray(item.models) ? item.models.filter((m) => typeof m === "string" && m.trim()) : [],
      authHeader: ["bearer", "api-key", "none"].includes(item.authHeader) ? item.authHeader : "bearer",
      disableThinkingKey: typeof item.disableThinkingKey === "string" && item.disableThinkingKey ? item.disableThinkingKey : null,
      thinkingValues: normalizeThinkingValues(item.thinkingValues),
      thinkingFields: normalizeThinkingValues(item.thinkingFields),
      jsonModeKey: item.jsonModeKey === null ? null : "response_format",
      stream: Boolean(item.stream)
    }));
  }

  function saveCustomPresets(list) {
    return writeJson(PRESET_STORAGE_KEY, Array.isArray(list) ? list : []);
  }

  function listPlatformPresets() {
    return BUILTIN_PLATFORM_PRESETS.concat(loadCustomPresets());
  }

  function getPlatformPreset(id) {
    return listPlatformPresets().find((preset) => preset.id === id) || null;
  }

  function isBuiltinPreset(id) {
    return BUILTIN_PLATFORM_PRESETS.some((preset) => preset.id === id);
  }

  function upsertPlatformPreset(preset) {
    if (!isRecord(preset) || typeof preset.id !== "string" || !preset.id.trim() || isBuiltinPreset(preset.id)) return false;
    const list = loadCustomPresets();
    const normalized = {
      id: preset.id.trim(),
      label: String(preset.label || preset.id).trim(),
      endpoint: String(preset.endpoint || "").trim(),
      models: Array.isArray(preset.models) ? preset.models.filter((m) => String(m).trim()) : [],
      authHeader: ["bearer", "api-key", "none"].includes(preset.authHeader) ? preset.authHeader : "bearer",
      disableThinkingKey: typeof preset.disableThinkingKey === "string" && preset.disableThinkingKey.trim() ? preset.disableThinkingKey.trim() : null,
      thinkingValues: normalizeThinkingValues(preset.thinkingValues),
      thinkingFields: normalizeThinkingValues(preset.thinkingFields),
      jsonModeKey: preset.jsonModeKey === null ? null : "response_format",
      stream: Boolean(preset.stream)
    };
    const index = list.findIndex((item) => item.id === normalized.id);
    if (index >= 0) list[index] = normalized;
    else list.push(normalized);
    return saveCustomPresets(list);
  }

  function deletePlatformPreset(id) {
    if (isBuiltinPreset(id)) return false;
    const list = loadCustomPresets();
    const next = list.filter((item) => item.id !== id);
    if (next.length === list.length) return false;
    return saveCustomPresets(next);
  }

  function loadPlatformKeys() {
    const raw = readJson(PLATFORM_KEYS_KEY, {});
    return isRecord(raw) ? raw : {};
  }

  function savePlatformKeys(map) {
    return writeJson(PLATFORM_KEYS_KEY, isRecord(map) ? map : {});
  }

  function getPlatformKey(id) {
    if (!id) return "";
    const value = loadPlatformKeys()[id];
    return typeof value === "string" ? value : "";
  }

  // 空串表示清除该平台已记忆的密钥，便于切换后"留空"。
  function setPlatformKey(id, key) {
    if (!id) return false;
    const map = loadPlatformKeys();
    const value = String(key || "");
    if (value) map[id] = value;
    else delete map[id];
    return savePlatformKeys(map);
  }

  // 保存配置时把 VLM 服务当前的密钥按平台归集，供下次切换自动带出。
  function syncKeysFromConfig(config) {
    const pipeline = isRecord(config?.pipeline) ? config.pipeline : {};
    const services = [pipeline.vlm];
    const map = loadPlatformKeys();
    let changed = false;
    for (const service of services) {
      if (!isRecord(service) || !service.platform) continue;
      const key = String(service.apiKey || "");
      const previous = map[service.platform];
      if (key && previous !== key) {
        map[service.platform] = key;
        changed = true;
      }
    }
    return changed ? savePlatformKeys(map) : true;
  }

  function loadPlatformModels() {
    const raw = readJson(PLATFORM_MODELS_KEY, {});
    return isRecord(raw) ? raw : {};
  }

  function savePlatformModels(map) {
    return writeJson(PLATFORM_MODELS_KEY, isRecord(map) ? map : {});
  }

  function getPlatformModel(id) {
    if (!id) return "";
    const value = loadPlatformModels()[id];
    return typeof value === "string" ? value : "";
  }

  // 空串表示清除该平台已记忆的模型，切换时回落到预设推荐模型。
  function setPlatformModel(id, model) {
    if (!id) return false;
    const map = loadPlatformModels();
    const value = String(model || "");
    if (value) map[id] = value;
    else delete map[id];
    return savePlatformModels(map);
  }

  // 保存配置时把 VLM 服务当前模型按平台归集，供下次切换自动带出。
  function syncModelsFromConfig(config) {
    const service = isRecord(config?.pipeline) ? config.pipeline.vlm : null;
    if (!isRecord(service) || !service.platform) return true;
    const model = String(service.model || "");
    const previous = getPlatformModel(service.platform);
    if (!model || previous === model) return true;
    return setPlatformModel(service.platform, model);
  }

  function loadPlatformThinkingModes() {
    const raw = readJson(PLATFORM_THINKING_KEY, {});
    return isRecord(raw) ? raw : {};
  }

  function savePlatformThinkingModes(map) {
    return writeJson(PLATFORM_THINKING_KEY, isRecord(map) ? map : {});
  }

  function getPlatformThinkingMode(id) {
    if (!id) return "";
    const value = loadPlatformThinkingModes()[id];
    return typeof value === "string" ? value : "";
  }

  // 空串表示清除记忆，切换时回落到预设默认值（off）。
  function setPlatformThinkingMode(id, mode) {
    if (!id) return false;
    const map = loadPlatformThinkingModes();
    const value = String(mode || "");
    if (value) map[id] = value;
    else delete map[id];
    return writeJson(PLATFORM_THINKING_KEY, map);
  }

  function syncThinkingModesFromConfig(config) {
    const pipeline = isRecord(config?.pipeline) ? config.pipeline : null;
    const service = pipeline && isRecord(pipeline.vlm) ? pipeline.vlm : null;
    if (!service || !service.platform) return true;
    const mode = String(pipeline.thinkingMode || "off");
    if (getPlatformThinkingMode(service.platform) === mode) return true;
    return setPlatformThinkingMode(service.platform, mode);
  }

  // 从某个服务的当前配置生成一个可复用预设（用于"存为预设"）。
  function presetFromService(service, id, label) {
    return {
      id: String(id || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
      label: String(label || id || "自定义预设").trim(),
      endpoint: String(service?.endpoint || "").trim(),
      models: String(service?.model || "").trim() ? [String(service.model).trim()] : [],
      authHeader: "bearer",
      disableThinkingKey: null,
      thinkingValues: {},
      thinkingFields: {},
      jsonModeKey: "response_format",
      stream: false
    };
  }

  // 把平台预设与服务上的手动覆盖合并成统一的请求档案。
  // 显式字段（service.endpoint / service.model）优先，预设只在其为空时提供建议值。
  function resolveProfile(service) {
    const src = isRecord(service) ? service : {};
    const preset = getPlatformPreset(src.platform) || getPlatformPreset("custom") || {};
    const compat = isRecord(src.compat) ? src.compat : {};
    const authHeader = ["bearer", "api-key", "none"].includes(compat.authHeader) ? compat.authHeader : (preset.authHeader || "bearer");
    const suggestedModel = Array.isArray(preset.models) && preset.models.length ? preset.models[0] : "";
    return {
      id: preset.id || "custom",
      label: preset.label || "自定义",
      endpoint: normalizeEndpoint(String(src.endpoint || preset.endpoint || "")),
      model: String(src.model || suggestedModel || ""),
      models: Array.isArray(preset.models) ? preset.models : [],
      apiKey: String(src.apiKey || ""),
      authHeader,
      authHeaderName: authHeader === "api-key" ? "api-key" : "Authorization",
      disableThinkingKey: Object.prototype.hasOwnProperty.call(compat, "disableThinkingKey") ? compat.disableThinkingKey : (preset.disableThinkingKey ?? null),
      thinkingValues: Object.prototype.hasOwnProperty.call(compat, "thinkingValues") ? normalizeThinkingValues(compat.thinkingValues) : normalizeThinkingValues(preset.thinkingValues),
      thinkingFields: Object.prototype.hasOwnProperty.call(compat, "thinkingFields") ? normalizeThinkingValues(compat.thinkingFields) : normalizeThinkingValues(preset.thinkingFields),
      jsonModeKey: Object.prototype.hasOwnProperty.call(compat, "jsonModeKey")
        ? compat.jsonModeKey
        : (Object.prototype.hasOwnProperty.call(preset, "jsonModeKey") ? preset.jsonModeKey : "response_format"),
      stream: typeof compat.stream === "boolean" ? compat.stream : Boolean(preset.stream)
    };
  }
  // src/infra/api.ts
  var sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function parseProviderError(text) {
    const value = String(text || "").trim();
    if (!value) return "";
    try {
      const body = JSON.parse(value);
      if (typeof body?.error === "string") return body.error;
      if (typeof body?.error?.message === "string") return body.error.message;
      if (typeof body?.message === "string") return body.message;
      if (typeof body?.detail === "string") return body.detail;
    } catch { /* 非 JSON，继续按文本/HTML 处理 */ }
    if (/<html|<!doctype/i.test(value)) {
      const title = value.match(/<title>([^<]+)<\/title>/i);
      return title ? title[1].trim() : "";
    }
    return value.length <= 400 ? value : "";
  }

  function statusHint(status) {
    if (status === 400) return "\u8BF7\u6C42\u53C2\u6570\u6216\u63D0\u793A\u8BCD\u683C\u5F0F\u53EF\u80FD\u4E0D\u88AB\u8BE5\u6A21\u578B\u652F\u6301";
    if (status === 401 || status === 403) return "\u9274\u6743\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5 API Key \u4E0E\u9274\u6743\u65B9\u5F0F";
    if (status === 404) return "\u63A5\u53E3\u5730\u5740\u6216\u6A21\u578B\u540D\u79F0\u4E0D\u5339\u914D\uFF0C\u8BF7\u6838\u5BF9\u5B8C\u6574\u8DEF\u5F84";
    if (status === 429) return "\u8BF7\u6C42\u8FC7\u9891\u6216\u514D\u8D39\u989D\u5EA6\u5DF2\u7528\u5C3D\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3001\u964D\u4F4E\u5E76\u53D1\u6216\u66F4\u6362\u6A21\u578B";
    if (status >= 500) return "\u670D\u52A1\u7AEF\u5F02\u5E38\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5";
    return "\u8BF7\u68C0\u67E5\u63A5\u53E3\u914D\u7F6E";
  }

  function sampleText(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value) return "";
    return value.length > 500 ? `${value.slice(0, 500)}\u2026` : value;
  }

  function parseRetryAfter(headers) {
    const raw = typeof headers === "string" ? headers : "";
    const match = raw.match(/retry-after\s*:\s*(\d+)/i);
    return match ? Math.min(Math.max(Number(match[1]), 0), 30) * 1000 : 0;
  }

  function createApiError(status, rawText, response) {
    const providerMessage = parseProviderError(rawText);
    const bodySample = sampleText(rawText);
    const message = `\u63A5\u53E3\u8FD4\u56DE HTTP ${status}\uFF08${statusHint(status)}\uFF09${providerMessage ? `\uFF1A${providerMessage}` : ""}${bodySample && bodySample !== providerMessage ? `\n\u54CD\u5E94\u7247\u6BB5\uFF1A${bodySample}` : ""}`;
    const error = new Error(message);
    error.status = status;
    error.providerMessage = providerMessage;
    error.bodySample = bodySample;
    error.retryAfter = parseRetryAfter(response?.headers);
    return error;
  }

  function isRetryableError(error) {
    const status = error?.status;
    if (status === 429 || (status >= 500 && status < 600)) return true;
    const message = String(error?.message || "");
    return message.includes("\u8D85\u65F6") || message.includes("\u7F51\u7EDC\u9519\u8BEF");
  }

  function gmRequest(details) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...details,
        onload: (response) => {
          if (response.status >= 200 && response.status < 300) return resolve(response);
          reject(createApiError(response.status, response.responseText, response));
        },
        onerror: (response) => reject(new Error(`\u7F51\u7EDC\u9519\u8BEF\uFF08HTTP ${response.status || 0}\uFF09`)),
        ontimeout: () => reject(new Error("\u8BF7\u6C42\u8D85\u65F6"))
      });
    });
  }

  function estimateTokens(text, imageCount = 0) {
    return Math.ceil(text.length / 2) + imageCount * 1e3;
  }

  // OpenAI 兼容服务：基础地址自动补全为 chat/completions；带查询串的完整地址原样保留。
  function normalizeEndpoint(endpoint) {
    const value = String(endpoint || "").trim().replace(/\/+$/, "");
    if (!value) return value;
    if (/\/chat\/completions$/i.test(value) || /\/messages$/i.test(value)) return value;
    if (value.includes("?")) return value;
    if (/\/api\/v3$/i.test(value) || /\/v1$/i.test(value) || /^https?:\/\/[^/]+$/i.test(value)) {
      return `${value}/chat/completions`;
    }
    return value;
  }

  var THINKING_MODES = ["off", "low", "high", "max", "auto"];
  // 兼容旧布尔字段：true=关闭，false=不干预；其余按模式枚举原样保留。
  function normalizeThinkingMode(value) {
    if (value === true || value === "true" || value === "disabled" || value === "close") return "off";
    if (value === false || value === "false" || value === "none" || value === "") return "auto";
    const mode = String(value || "").trim().toLowerCase();
    return THINKING_MODES.indexOf(mode) >= 0 ? mode : "auto";
  }

  // 按思考模式注入字段：off 为关闭，low/high/max 为强度，auto 不干预。
  // 优先用 thinkingFields 展开多个字段（如智谱 thinking.type=enabled + reasoning_effort=low）；
  // 其次用 thinkingValues 单字段映射；都未命中时按字段名给出通用值。
  function thinkingControl(payload, profile, mode) {
    const injected = [];
    const normalized = normalizeThinkingMode(mode);
    if (normalized === "auto") return injected;
    const fields = profile.thinkingFields || {};
    if (Object.prototype.hasOwnProperty.call(fields, normalized)) {
      for (const [fieldKey, fieldValue] of Object.entries(fields[normalized] || {})) {
        payload[fieldKey] = fieldValue;
        injected.push(fieldKey);
      }
      return injected;
    }
    const key = profile.disableThinkingKey;
    if (!key) return injected;
    const values = profile.thinkingValues || {};
    let value;
    if (Object.prototype.hasOwnProperty.call(values, normalized)) {
      value = values[normalized];
    } else if (normalized === "off") {
      if (key === "thinking") value = { type: "disabled" };
      else if (key === "reasoning") value = { effort: "none" };
      else value = false;
    } else if (key === "thinking") {
      value = { type: normalized };
    } else if (key === "reasoning") {
      value = { effort: normalized };
    } else {
      value = normalized;
    }
    payload[key] = value;
    injected.push(key);
    return injected;
  }

  function parseJsonResponse(text) {
    const raw = String(text ?? "").trim();
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }

  function extractContent(body) {
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((part) => String(part?.text ?? "")).join("");
    return "";
  }

  async function chatCompletion(service, messages, options = {}) {
    // 所有请求统一为 Chat Completions：平台档案只影响鉴权头、思考字段与 JSON 模式字段。
    const profile = resolveProfile(service);
    const endpoint = profile.endpoint;
    const payload = { model: profile.model, messages, stream: profile.stream };
    const thinkingMode = normalizeThinkingMode(
      options.thinkingMode !== void 0 ? options.thinkingMode
        : (options.disableThinking !== void 0 ? options.disableThinking
          : (service.thinkingMode !== void 0 ? service.thinkingMode : service.disableThinking))
    );
    const thinkingKeys = thinkingControl(payload, profile, thinkingMode);
    const temperature = options.temperature === void 0 ? 0.2 : options.temperature;
    if (temperature !== null) payload.temperature = temperature;
    let jsonInjectedKey = null;
    if (options.jsonMode && profile.jsonModeKey === "response_format") {
      payload.response_format = { type: "json_object" };
      jsonInjectedKey = "response_format";
    }
    const headers = { "Content-Type": "application/json" };
    if (profile.authHeader === "api-key") headers["api-key"] = profile.apiKey;
    else if (profile.authHeader === "bearer") headers.Authorization = `Bearer ${profile.apiKey}`;
    const retries = options.retries ?? 1;
    let lastError = new Error("\u672A\u77E5\u9519\u8BEF");
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const execute = async () => gmRequest({
        method: "POST",
        url: endpoint,
        headers,
        data: JSON.stringify(payload),
        timeout: options.timeoutMs ?? 12e4
      });
      try {
        const response = options.rateLimiter ? await options.rateLimiter.run(execute, options.estimatedTokens ?? 0) : await execute();
        const content = extractContent(parseJsonResponse(response.responseText));
        if (typeof content === "string" && content) return content;
        throw new Error("\u63A5\u53E3\u54CD\u5E94\u7F3A\u5C11\u6587\u672C\u5185\u5BB9");
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (lastError.status === 400) {
          let relaxed = false;
          if (jsonInjectedKey) {
            delete payload[jsonInjectedKey];
            jsonInjectedKey = null;
            relaxed = true;
          }
          // 仅「关闭」模式可降级重试；low/high/max 是用户明确选择，降级会静默改变意图。
          if (thinkingKeys.length && thinkingMode === "off") {
            for (const key of thinkingKeys) delete payload[key];
            thinkingKeys.length = 0;
            relaxed = true;
          }
          if (relaxed && attempt < retries) continue;
        }
        if (!isRetryableError(lastError) || attempt === retries) break;
        const wait = lastError.retryAfter || Math.min(600 * 2 ** attempt + Math.floor(Math.random() * 200), 5000);
        await sleep(wait);
      }
    }
    lastError.configSummary = `${profile.id} | ${endpoint} | ${profile.authHeaderName} | model=${profile.model || "(空)"} | key=${profile.apiKey ? `…${profile.apiKey.slice(-4)}` : "(空)"}`;
    throw lastError;
  }

  // 从 chat/completions 地址推导同平台的 /models 列表地址。
  function modelsEndpoint(endpoint) {
    const normalized = normalizeEndpoint(endpoint);
    if (!normalized) return "";
    return normalized.replace(/\/chat\/completions$/i, "/models").replace(/\/messages$/i, "/models");
  }

  // 拉取平台可用模型列表；返回模型 ID 字符串数组（数组可带 fallback 标记）。
  // 部分平台（如 Cloudflare Workers AI）没有 /models 端点，GET 会返回 405，此时回退到预设内置模型。
  async function fetchModels(service, timeoutMs = 15e3) {
    const profile = resolveProfile(service);
    const url = modelsEndpoint(profile.endpoint);
    if (!url) throw new Error("\u8BF7\u5148\u586B\u5199\u63A5\u53E3\u5730\u5740");
    const headers = { "Content-Type": "application/json" };
    if (profile.authHeader === "api-key") headers["api-key"] = profile.apiKey;
    else if (profile.authHeader === "bearer") headers.Authorization = `Bearer ${profile.apiKey}`;
    const usePreset = (why) => {
      const presetModels = Array.isArray(profile.models) ? profile.models.filter((id) => typeof id === "string" && id.trim()) : [];
      if (!presetModels.length) throw new Error(why);
      const result = presetModels.slice();
      result.fallback = true;
      return result;
    };
    let response;
    try {
      response = await gmRequest({ method: "GET", url, headers, timeout: timeoutMs });
    } catch (error) {
      if (error?.status === 405 || error?.status === 404 || error?.status === 400) return usePreset("\u8BE5\u5E73\u53F0\u4E0D\u652F\u6301\u5728\u7EBF\u62C9\u53D6\u6A21\u578B\u5217\u8868\uFF0C\u4E14\u9884\u8BBE\u672A\u63D0\u4F9B\u53EF\u9009\u6A21\u578B");
      throw error;
    }
    const body = parseJsonResponse(response.responseText);
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body?.result) ? body.result : [];
    const ids = list.map((item) => (typeof item === "string" ? item : item?.id)).filter((id) => typeof id === "string" && id.trim());
    if (!ids.length) return usePreset("\u63A5\u53E3\u672A\u8FD4\u56DE\u53EF\u7528\u6A21\u578B\u5217\u8868\uFF0C\u4E14\u9884\u8BBE\u672A\u63D0\u4F9B\u53EF\u9009\u6A21\u578B");
    return ids;
  }

  // 检查响应体中是否携带推理/思考内容：字段本身或 reasoning_tokens 计数。
  function detectReasoning(body) {
    const fields = [];
    const choice = body?.choices?.[0] || {};
    const message = choice.message || choice.delta || {};
    for (const key of ["reasoning_content", "reasoning", "thinking", "reasoning_text"]) {
      const value = message[key];
      if (typeof value === "string" && value.trim()) fields.push(key);
      else if (Array.isArray(value) && value.length) fields.push(key);
    }
    const usage = body?.usage || {};
    const details = usage.completion_tokens_details || usage.reasoning_tokens_details || {};
    const tokens = Number(details.reasoning_tokens ?? details.reasoning ?? usage.reasoning_tokens ?? 0) || 0;
    return { fields, tokens };
  }

  // 探测关闭思考是否真正生效：按当前配置发一个需要多步推理的问题，检查响应是否仍含推理内容。
  async function probeThinking(service, rateLimiter) {
    const profile = resolveProfile(service);
    if (!profile.endpoint) throw new Error("\u8BF7\u5148\u586B\u5199\u63A5\u53E3\u5730\u5740");
    const payload = {
      model: profile.model,
      messages: [{ role: "user", content: "\u7B3C\u5B50\u91CC\u6709\u9E21\u548C\u5154\u5171 35 \u4E2A\u5934\u300194 \u53EA\u811A\u3002\u8BF7\u7ED9\u51FA\u63A8\u7406\u8FC7\u7A0B\u548C\u6700\u7EC8\u7B54\u6848\uFF1A\u9E21\u548C\u5154\u5404\u591A\u5C11\u53EA\uFF1F" }],
      stream: false
    };
    const thinkingMode = normalizeThinkingMode(service.thinkingMode !== void 0 ? service.thinkingMode : service.disableThinking);
    const thinkingKeys = thinkingControl(payload, profile, thinkingMode);
    const headers = { "Content-Type": "application/json" };
    if (profile.authHeader === "api-key") headers["api-key"] = profile.apiKey;
    else if (profile.authHeader === "bearer") headers.Authorization = `Bearer ${profile.apiKey}`;
    // 推理模型（如 Qwen3.5-27B）默认长链思考，20 秒常不够；跟随配置超时（默认 120 秒）。
    const probeTimeout = Math.max(2e4, Number(service.timeoutMs) || 12e4);
    const execute = () => gmRequest({ method: "POST", url: profile.endpoint, headers, data: JSON.stringify(payload), timeout: probeTimeout });
    const response = rateLimiter ? await rateLimiter.run(execute, 120) : await execute();
    const body = parseJsonResponse(response.responseText);
    const reasoning = detectReasoning(body);
    const hasThinking = reasoning.fields.length > 0 || reasoning.tokens > 0;
    const injected = thinkingKeys.length ? thinkingKeys.join(" / ") : "";
    let verdict;
    let ok;
    if (thinkingMode === "auto") {
      ok = true;
      verdict = "未干预思考模式，将使用模型默认设置";
    } else if (thinkingMode === "off") {
      ok = !hasThinking;
      if (!injected) {
        verdict = hasThinking
          ? "该平台未配置关闭字段，无法关闭思考，且响应中检测到思考内容"
          : "未配置关闭字段，响应中也未检测到思考内容（模型可能本身无思考模式）";
      } else {
        verdict = hasThinking
          ? `已发送关闭参数（${injected}），但响应中仍检测到思考内容，可能未生效`
          : `已发送关闭参数（${injected}），响应中未检测到思考内容，关闭生效`;
      }
    } else {
      ok = Boolean(injected);
      verdict = injected
        ? `已发送 ${thinkingMode} 思考强度参数（${injected}），请求被接受；该模式下响应含思考内容属正常现象`
        : `当前平台未配置思考强度字段，无法设置 ${thinkingMode} 模式`;
    }
    const detail = reasoning.fields.length ? `\u68C0\u6D4B\u5B57\u6BB5\uFF1A${reasoning.fields.join(", ")}` : reasoning.tokens > 0 ? `\u63A8\u7406 Token\uFF1A${reasoning.tokens}` : "";
    return {
      ok,
      verdict,
      detail,
      injected,
      mode: thinkingMode,
      bodySample: sampleText(response.responseText)
    };
  }

  async function testConnection(service, rateLimiter) {
    const text = await chatCompletion(
      service,
      [{ role: "user", content: "\u8BF7\u53EA\u56DE\u590D\uFF1Aok" }],
      { rateLimiter, timeoutMs: 15e3, retries: 0, estimatedTokens: 20 }
    );
    return text.trim().length > 0;
  }
  // src/infra/image.ts
  function fallbackHash(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
  async function sha256(text) {
    if (globalThis.crypto?.subtle) {
      const bytes = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    return fallbackHash(text);
  }
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("\u56FE\u7247\u52A0\u8F7D\u5931\u8D25"));
      image.src = src;
    });
  }
  async function fetchAsDataUrl(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "arraybuffer",
        timeout: 3e4,
        onload: (response) => {
          const raw = response.response;
          const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new TextEncoder().encode(response.responseText ?? "");
          const blob = new Blob([bytes], { type: "image/jpeg" });
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("\u56FE\u7247\u8BFB\u53D6\u5931\u8D25"));
          reader.readAsDataURL(blob);
        },
        onerror: () => reject(new Error("\u56FE\u7247\u4E0B\u8F7D\u5931\u8D25")),
        ontimeout: () => reject(new Error("\u56FE\u7247\u4E0B\u8F7D\u8D85\u65F6"))
      });
    });
  }
  function contentBox(ctx, width, height) {
    try {
      const data = ctx.getImageData(0, 0, width, height).data;
      let minX = width;
      let minY = height;
      let maxX = 0;
      let maxY = 0;
      let found = false;
      for (let y2 = 0; y2 < height; y2 += 2) {
        for (let x2 = 0; x2 < width; x2 += 2) {
          const index = (y2 * width + x2) * 4;
          const alpha = data[index + 3];
          const brightness = (data[index] + data[index + 1] + data[index + 2]) / 3;
          if (alpha > 32 && brightness < 245) {
            found = true;
            if (x2 < minX) minX = x2;
            if (y2 < minY) minY = y2;
            if (x2 > maxX) maxX = x2;
            if (y2 > maxY) maxY = y2;
          }
        }
      }
      if (!found) return null;
      const pad = Math.max(4, Math.floor(Math.min(width, height) * 0.02));
      const x = Math.max(0, minX - pad);
      const y = Math.max(0, minY - pad);
      const w = Math.min(width, maxX + pad + 1) - x;
      const h = Math.min(height, maxY + pad + 1) - y;
      if (w < 32 || h < 32 || w * h > width * height * 0.72) return null;
      return { x, y, w, h };
    } catch {
      return null;
    }
  }
  function blankRatio(ctx, width, height) {
    try {
      const data = ctx.getImageData(0, 0, width, height).data;
      let blank = 0;
      let total = 0;
      for (let i = 0; i < data.length; i += 16) {
        total += 1;
        if ((data[i] + data[i + 1] + data[i + 2]) / 3 > 248) blank += 1;
      }
      return total > 0 ? blank / total : 1;
    } catch {
      return 0;
    }
  }
  async function prepareImage(src, config) {
    const dataUrl = src.startsWith("data:") ? src : await fetchAsDataUrl(src);
    const image = await loadImage(dataUrl);
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const work = document.createElement("canvas");
    work.width = sourceWidth;
    work.height = sourceHeight;
    const workCtx = work.getContext("2d", { willReadFrequently: true });
    if (!workCtx) throw new Error("\u65E0\u6CD5\u521B\u5EFA\u753B\u5E03\u4E0A\u4E0B\u6587");
    workCtx.drawImage(image, 0, 0);
    const ratio = blankRatio(workCtx, sourceWidth, sourceHeight);
    let sx = 0;
    let sy = 0;
    let sw = sourceWidth;
    let sh = sourceHeight;
    if (config.cropToAnswer) {
      const box = contentBox(workCtx, sourceWidth, sourceHeight);
      if (box) {
        sx = box.x;
        sy = box.y;
        sw = box.w;
        sh = box.h;
      }
    }
    const scale = Math.min(1, config.maxEdge / Math.max(sw, sh));
    const output = document.createElement("canvas");
    output.width = Math.max(1, Math.round(sw * scale));
    output.height = Math.max(1, Math.round(sh * scale));
    const outputCtx = output.getContext("2d");
    if (!outputCtx) throw new Error("\u65E0\u6CD5\u521B\u5EFA\u753B\u5E03\u4E0A\u4E0B\u6587");
    outputCtx.drawImage(work, sx, sy, sw, sh, 0, 0, output.width, output.height);
    const encoded = output.toDataURL("image/jpeg", Math.min(1, Math.max(0.5, config.quality)));
    return {
      dataUrl: encoded,
      hash: await sha256(encoded),
      width: output.width,
      height: output.height,
      blankRatio: ratio
    };
  }
  function dedupePrepared(images) {
    const seen = /* @__PURE__ */ new Set();
    return images.filter((image) => {
      if (seen.has(image.hash)) return false;
      seen.add(image.hash);
      return true;
    });
  }
  function isBlankImage(image) {
    return image.blankRatio > 0.97;
  }
  function isWasteImage(image) {
    const { width, height } = image;
    return width < 15 || height < 15 || Math.max(width / height, height / width) > 100;
  }

  // src/core/prompt.ts
  var PROMPT_VERSION = "zygr-prompt-v3-vlm";
  function clip(text, max) {
    const value = String(text ?? "").trim();
    if (!value) return "\uFF08\u65E0\uFF09";
    return value.length > max ? `${value.slice(0, max)}
\u2026\u2026\uFF08\u5185\u5BB9\u5DF2\u622A\u65AD\uFF09` : value;
  }
  function subQuestionLines(question) {
    if (question.subQuestions.length === 0) return "\uFF08\u65E0\u5206\u5C0F\u9898\u4FE1\u606F\uFF09";
    return question.subQuestions.map((item) => `- ${item.label}\uFF1A\u6EE1\u5206 ${item.maxScore > 0 ? item.maxScore : "\u672A\u6307\u5B9A"}`).join("\n");
  }
  function maxScoreLine(context, question) {
    const max = context.maxScore > 0 ? context.maxScore : question.maxScore;
    return max > 0 ? `\u6EE1\u5206 ${max} \u5206` : "\u6EE1\u5206\u672A\u6307\u5B9A\uFF0C\u6309\u5E38\u89C4\u5224\u65AD";
  }
  function buildGradingPrompt(question, context, options) {
    const answer = "\u3010\u5B66\u751F\u4F5C\u7B54\u3011\n\u89C1\u968F\u9644\u56FE\u7247\uFF0C\u6309\u56FE\u7247\u5185\u5BB9\u5224\u65AD";
    const sections = [
      "\u4F60\u662F\u9605\u5377\u52A9\u624B\u3002\u53EA\u4F9D\u636E\u7ED9\u5B9A\u5185\u5BB9\u4E0E\u968F\u9644\u56FE\u7247\u8BC4\u5206\uFF0C\u4E0D\u8981\u81C6\u6D4B\u3002",
      "\u4E25\u683C\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u4E0D\u8981 Markdown \u4EE3\u7801\u5757\uFF0C\u4E0D\u8981\u989D\u5916\u89E3\u91CA\u3002",
      "\u5B57\u6BB5\uFF1Astatus\uFF08legible/partial/illegible/blank\uFF09\u3001score\uFF08\u6570\u5B57\uFF09\u3001subScores\uFF08\u6570\u7EC4\uFF1Alabel/score/maxScore/reason\uFF09\u3001reason\uFF08\u4E0D\u8D85\u8FC7 80 \u5B57\uFF09\u3001confidence\uFF080 \u5230 1\uFF09\u3002",
      "\u89C4\u5219\uFF1A\u672A\u4F5C\u7B54\u4E0D\u5F97\u7ED9\u6B63\u5206\uFF1B\u5212\u53BB\u7684\u5185\u5BB9\u4E0D\u8BA1\u5206\uFF1B\u7B49\u4EF7\u89E3\u6CD5\u5E94\u7ED9\u5206\uFF1B\u5206\u6570\u4E0D\u5F97\u8D85\u8FC7\u6EE1\u5206\uFF1B\u65E0\u6CD5\u8FA8\u8BA4\u65F6\u7ED9\u51FA legible/partial/illegible \u5E76\u8BF4\u660E\u3002",
      question.subQuestions.length > 0 ? "\u8BF7\u9010\u9879\u7ED9\u51FA subScores\uFF0Clabel \u5FC5\u987B\u4E0E\u8F93\u5165\u5C0F\u9898\u4E00\u81F4\uFF1B\u603B\u5206\u987B\u7B49\u4E8E\u5404\u5C0F\u9898\u5F97\u5206\u4E4B\u548C\u3002" : "subScores \u8FD4\u56DE\u7A7A\u6570\u7EC4\u5373\u53EF\u3002",
      "===== \u8F93\u5165 =====",
      `\u3010\u9898\u76EE\u3011
${clip(context.question || question.questionText, 6e3)}`,
      `\u3010\u53C2\u8003\u7B54\u6848\u3011
${clip(context.answer, 6e3)}`,
      `\u3010\u8BC4\u5206\u6807\u51C6\u3011
${clip(context.rubric, 6e3)}`,
      `\u3010\u5206\u503C\u3011
${maxScoreLine(context, question)}`,
      `\u3010\u5C0F\u9898\u3011
${subQuestionLines(question)}`,
      answer,
      "\u6CE8\u610F\uFF1A\u968F\u9644\u56FE\u7247\u4EC5\u4E3A\u672C\u6B21\u5B66\u751F\u4F5C\u7B54\uFF0C\u7B54\u5377\u4E0A\u7684\u5370\u5237\u9898\u5E72\u4E0D\u5C5E\u4E8E\u5B66\u751F\u4F5C\u7B54\u3002",
      options.removedImages && options.removedImages > 0 ? `\u3010\u56FE\u7247\u8BF4\u660E\u3011\u5DF2\u5254\u9664 ${options.removedImages} \u5F20\u5E9F\u56FE\uFF0C\u8BF7\u57FA\u4E8E\u5269\u4F59\u56FE\u7247\u8BC4\u5224\u3002` : "",
      "===== \u8F93\u51FA =====",
      "\u53EA\u8F93\u51FA JSON\u3002"
    ];
    return sections.filter(Boolean).join("\n\n");
  }
  // src/core/rubric-generator.ts
  var RUBRIC_SUBJECTS = {
    "\u8BED\u6587": ["\u4F5C\u6587", "\u73B0\u4EE3\u6587\u9605\u8BFB", "\u53E4\u8BD7\u6587\u9605\u8BFB", "\u6587\u8A00\u6587\u7FFB\u8BD1", "\u8BED\u8A00\u6587\u5B57\u8FD0\u7528"],
    "\u6570\u5B66": ["\u89E3\u7B54\u9898", "\u8BC1\u660E\u9898", "\u586B\u7A7A\u9898", "\u9009\u62E9\u9898", "\u5E94\u7528\u9898"],
    "\u82F1\u8BED": ["\u4F5C\u6587", "\u9605\u8BFB\u7406\u89E3", "\u5B8C\u5F62\u586B\u7A7A", "\u7FFB\u8BD1", "\u8BAD\u6CD5\u586B\u7A7A"],
    "\u7269\u7406": ["\u8BA1\u7B97\u9898", "\u5B9E\u9A8C\u9898", "\u7B80\u7B54\u9898", "\u9009\u62E9\u9898"],
    "\u5316\u5B66": ["\u8BA1\u7B97\u9898", "\u5B9E\u9A8C\u9898", "\u7B80\u7B54\u9898", "\u65B9\u7A0B\u5F0F\u4E66\u5199", "\u9009\u62E9\u9898"],
    "\u751F\u7269": ["\u5B9E\u9A8C\u9898", "\u7B80\u7B54\u9898", "\u8BC6\u56FE\u9898", "\u9009\u62E9\u9898"],
    "\u5386\u53F2": ["\u6750\u6599\u5206\u6790\u9898", "\u8BBA\u8FF0\u9898", "\u7B80\u7B54\u9898", "\u9009\u62E9\u9898"],
    "\u653F\u6CBB": ["\u6750\u6599\u5206\u6790\u9898", "\u8BBA\u8FF0\u9898", "\u7B80\u7B54\u9898", "\u9009\u62E9\u9898"],
    "\u5730\u7406": ["\u7EFC\u5408\u9898", "\u8BFB\u56FE\u9898", "\u7B80\u7B54\u9898", "\u9009\u62E9\u9898"]
  };

  var RUBRIC_TYPE_HINTS = {
    "\u4F5C\u6587": "\u6309\u5185\u5BB9\u3001\u7ED3\u6784\u3001\u8BED\u8A00\u3001\u4E66\u5199\u7B49\u7EF4\u5EA6\u5212\u5206\u6863\u6B21\uFF0C\u6BCF\u6863\u7ED9\u51FA\u5206\u6570\u533A\u95F4\u4E0E\u53EF\u89C2\u5BDF\u7684\u7279\u5F81\u3002",
    "\u89E3\u7B54\u9898": "\u6309\u6B65\u9AA4\u7ED9\u5206\uFF1A\u516C\u5F0F\u6B63\u786E\u3001\u4EE3\u5165\u8FC7\u7A0B\u3001\u8BA1\u7B97\u7ED3\u679C\u3001\u5355\u4F4D\u4E0E\u7B54\u8BED\u5206\u522B\u8BBE\u5206\u70B9\u3002",
    "\u8BC1\u660E\u9898": "\u6309\u5173\u952E\u8BBA\u636E\u3001\u63A8\u7406\u94FE\u3001\u7ED3\u8BBA\u9010\u6B65\u7ED9\u5206\uFF0C\u6BCF\u4E00\u5FC5\u8981\u7B49\u5F0F\u6216\u5B9A\u7406\u4F5C\u4E3A\u72EC\u7ACB\u5F97\u5206\u70B9\u3002",
    "\u5B9E\u9A8C\u9898": "\u5206\u522B\u5BF9\u5B9E\u9A8C\u539F\u7406\u3001\u64CD\u4F5C\u6B65\u9AA4\u3001\u73B0\u8C61\u8BB0\u5F55\u3001\u7ED3\u8BBA\u3001\u8BEF\u5DEE\u5206\u6790\u8BBE\u5F97\u5206\u70B9\u3002",
    "\u6750\u6599\u5206\u6790\u9898": "\u6309\u70B9\u7ED9\u5206\uFF1A\u4ECE\u6807\u51C6\u7B54\u6848\u4E2D\u62BD\u51FA\u6BCF\u4E00\u4E2A\u53EF\u72EC\u7ACB\u5224\u5B9A\u7684\u5F97\u5206\u70B9\uFF0C\u7B54\u5230\u5373\u7ED9\u8BE5\u70B9\u5206\u503C\uFF0C\u672A\u7B54\u5230\u4E0D\u7ED9\u5206\u3002",
    "\u7EFC\u5408\u9898": "\u6309\u70B9\u7ED9\u5206\uFF1A\u6BCF\u4E00\u4E2A\u53EF\u5224\u5B9A\u7684\u7B54\u6848\u8981\u70B9\u4F5C\u4E3A\u72EC\u7ACB\u5F97\u5206\u70B9\uFF0C\u7B54\u5230\u5373\u7ED9\u5206\uFF0C\u7B54\u4E0D\u5230\u70B9\u4E0D\u7ED9\u8BE5\u70B9\u5206\u503C\u4E14\u4E0D\u5012\u6263\u3002",
    "\u8BBA\u8FF0\u9898": "\u6309\u89C2\u70B9\u3001\u8BBA\u636E\u3001\u8BBA\u8BC1\u8FC7\u7A0B\u3001\u7ED3\u8BBA\u5212\u5206\u6863\u6B21\uFF0C\u7ED9\u51FA\u5404\u6863\u5206\u6570\u533A\u95F4\u4E0E\u7279\u5F81\u3002",
    "\u7FFB\u8BD1": "\u6309\u5173\u952E\u8BCD\u3001\u53E5\u5F0F\u7ED3\u6784\u3001\u8BED\u6C14\u8BF4\u5F97\u5206\u70B9\uFF0C\u5141\u8BB8\u540C\u4E49\u8868\u8FBE\u3002",
    "\u8BFB\u56FE\u9898": "\u5148\u8003\u5BDF\u56FE\u4E2D\u4FE1\u606F\u63D0\u53D6\u662F\u5426\u5B8C\u6574\uFF0C\u518D\u8003\u5BDF\u63CF\u8FF0\u662F\u5426\u51C6\u786E\uFF0C\u6BCF\u9879\u4FE1\u606F\u5355\u72EC\u8BA1\u5206\u3002",
    "\u9009\u62E9\u9898": "\u7B54\u6848\u552F\u4E00\uFF0C\u53EA\u9700\u7ED9\u51FA\u6B63\u786E\u9009\u9879\u4E0E\u5F97\u5206\u6761\u4EF6\u3002",
    "\u586B\u7A7A\u9898": "\u9010\u7A7A\u5217\u51FA\u6B63\u786E\u7B54\u6848\u4E0E\u5BB9\u8BB8\u7B49\u4EF7\u5199\u6CD5\uFF0C\u6BCF\u7A7A\u5355\u72EC\u8BA1\u5206\u3002"
  };

  function rubricScoringMode(type) {
    const value = String(type || "");
    return (value.indexOf("\u4F5C\u6587") >= 0 || value.indexOf("\u8BBA\u8FF0") >= 0) ? "tier" : "point";
  }

  function rubricTypeHint(subject, type) {
    if (RUBRIC_TYPE_HINTS[type]) return RUBRIC_TYPE_HINTS[type];
    if (type.indexOf("\u4F5C\u6587") >= 0 || type.indexOf("\u8BBA\u8FF0") >= 0) return RUBRIC_TYPE_HINTS["\u4F5C\u6587"];
    if (type.indexOf("\u5B9E\u9A8C") >= 0) return RUBRIC_TYPE_HINTS["\u5B9E\u9A8C\u9898"];
    if (type.indexOf("\u8BA1\u7B97") >= 0) return RUBRIC_TYPE_HINTS["\u89E3\u7B54\u9898"];
    return "\u6309\u70B9\u7ED9\u5206\uFF1A\u9010\u6761\u5217\u51FA\u53EF\u5224\u5B9A\u7684\u5F97\u5206\u70B9\uFF0C\u6BCF\u70B9\u6CE8\u660E\u5206\u503C\uFF0C\u672A\u7B54\u5230\u7684\u70B9\u4E0D\u7ED9\u5206\u4E14\u4E0D\u5012\u6263\u3002";
  }

  function buildRubricPrompt(payload) {
    const question = String(payload?.question || "").trim();
    const answerText = String(payload?.answerText || "").trim();
    const hasImages = Boolean(payload?.hasImages);
    const maxScore = Number(payload?.maxScore) || 0;
    const mode = rubricScoringMode(payload?.questionType);
    const deductionRule = mode === "point"
      ? "\u672C\u9898\u4E3A\u6309\u70B9\u7ED9\u5206\u9898\uFF1A\u7B54\u5230\u5F97\u5206\u70B9\u5373\u7ED9\u8BE5\u70B9\u5206\u503C\uFF1B\u672A\u7B54\u5230\u6216\u7B54\u9519\u8BE5\u70B9\uFF0C\u8BE5\u70B9\u4E0D\u7ED9\u5206\uFF0C\u4E0D\u5F97\u5199\u6210\u5012\u6263\u3001\u6263\u5206\u6216\u8D1F\u5206\u3002"
      : "\u4EC5\u5BF9\u5377\u9762\u3001\u5012\u6263\u7B49\u660E\u786E\u89C4\u5B9A\u7684\u60C5\u5F62\u5217\u51FA\u6263\u5206\u4E0A\u9650\uFF0C\u4E0D\u5F97\u8DE8\u6863\u6263\u5206\u3002";
    const tierRule = mode === "point"
      ? "\u6309\u5F97\u5206\u70B9\u7D2F\u8BA1\u7ED9\u5206\uFF0C\u4E0D\u8BBE\u6863\u6B21\u3002"
      : "\u7ED9\u51FA\u6863\u6B21\u540D\u79F0\u3001\u5206\u6570\u533A\u95F4\u4E0E\u5404\u6863\u53EF\u89C2\u5BDF\u7684\u7279\u5F81\u3002";
    const sections = [
      "\u8BF7\u4E3A\u4E0B\u9762\u8FD9\u9053\u8BD5\u9898\u751F\u6210\u4E00\u4EFD\u53EF\u76F4\u63A5\u7528\u4E8E AI \u81EA\u52A8\u9605\u5377\u7684\u300C\u8BC4\u5206\u6807\u51C6\u300D\u3002",
      `[\u5B66\u79D1] ${payload?.subject || ""}`,
      `[\u9898\u578B] ${payload?.questionType || ""}`,
      `[\u6EE1\u5206] ${maxScore > 0 ? `${maxScore}\u5206` : "\u672A\u6307\u5B9A\uFF0C\u8BF7\u6309\u9898\u578B\u5E38\u89C4\u5EFA\u8BAE"}`,
      `[\u8BC4\u5206\u65B9\u5F0F] ${mode === "point" ? "\u6309\u70B9\u7ED9\u5206\uFF0C\u4E0D\u5012\u6263" : "\u6309\u6863\u6B21\u7ED9\u5206"}`,
      "",
      "[\u9898\u76EE]",
      question || (hasImages ? "\u9898\u76EE\u5185\u5BB9\u8BF7\u89C1\u9644\u56FE\u3002" : "\u672A\u63D0\u4F9B\u9898\u76EE\u6587\u5B57\uFF0C\u8BF7\u6839\u636E\u6807\u51C6\u7B54\u6848\u63A8\u65AD\u3002"),
      "",
      "[\u5B66\u6821\u6807\u51C6\u7B54\u6848]",
      answerText || (hasImages ? "\u6807\u51C6\u7B54\u6848\u8BF7\u89C1\u9644\u56FE\u3002" : "\u672A\u63D0\u4F9B\u6807\u51C6\u7B54\u6848\u6587\u5B57\uFF0C\u8BF7\u6839\u636E\u9898\u76EE\u63A8\u65AD\u3002"),
      "",
      `\u8BE5\u9898\u578B\u7684\u7279\u6B8A\u8981\u6C42\uFF1A${rubricTypeHint(payload?.subject, payload?.questionType)}`,
      "",
      "\u8BF7\u4E25\u683C\u6309\u4EE5\u4E0B\u7ED3\u6784\u8F93\u51FA\u7EAF\u6587\u672C\uFF08\u4E0D\u8981 Markdown \u4EE3\u7801\u5757\uFF0C\u4E0D\u8981\u5BD2\u6696\uFF09\uFF1A",
      "\u4E00\u3001\u9898\u578B\u4E0E\u5206\u503C\u5EFA\u8BAE",
      "\u4E8C\u3001\u5F97\u5206\u70B9",
      "1. \u6BCF\u9879\u5F97\u5206\u70B9\u5355\u72EC\u4E00\u884C\uFF0C\u6CE8\u660E\u5177\u4F53\u5206\u503C\u3002",
      "\u4E09\u3001\u6263\u5206\u89C4\u5219",
      `- ${deductionRule}`,
      "\u56DB\u3001\u6863\u6B21\u5212\u5206",
      tierRule,
      "\u4E94\u3001\u7279\u6B8A\u60C5\u51B5",
      "- \u672A\u4F5C\u7B54\u3001\u7A7A\u767D\u3001\u7B54\u975E\u6240\u95EE\u3001\u5408\u7406\u4F46\u4E0E\u6807\u51C6\u7B54\u6848\u8868\u8FBE\u4E0D\u540C\u7684\u60C5\u5F62\u5982\u4F55\u5904\u7406\u3002",
      "",
      "\u8981\u6C42\uFF1A",
      "- \u5F97\u5206\u70B9\u5FC5\u987B\u5177\u4F53\u3001\u53EF\u5224\u5B9A\uFF0C\u907F\u514D\u201C\u914D\u60C5\u7ED9\u5206\u201D\u7B49\u6A21\u7CCA\u8868\u8FF0\u3002",
      maxScore > 0 ? `- \u5404\u5F97\u5206\u70B9\u5206\u503C\u4E4B\u548C\u5FC5\u987B\u7B49\u4E8E\u6EE1\u5206 ${maxScore} \u5206\uFF1B\u672A\u7B54\u5230\u7684\u5F97\u5206\u70B9\u53EA\u662F\u4E0D\u7ED9\u5206\uFF0C\u4E0D\u5F97\u5199\u6210\u5012\u6263\u6216\u8D1F\u5206\u3002` : "- \u5404\u5F97\u5206\u70B9\u5206\u503C\u4E4B\u548C\u5E94\u7B49\u4E8E\u672C\u9898\u6EE1\u5206\uFF1B\u672A\u7B54\u5230\u7684\u5F97\u5206\u70B9\u53EA\u662F\u4E0D\u7ED9\u5206\uFF0C\u4E0D\u5F97\u5199\u6210\u5012\u6263\u6216\u8D1F\u5206\u3002",
      "- \u4FDD\u7559\u9898\u76EE\u4E0E\u7B54\u6848\u4E2D\u7684\u5316\u5B66\u5F0F\u3001\u6570\u5B66\u516C\u5F0F\u3001\u7B26\u53F7\u3001\u4E13\u6709\u540D\u8BCD\u539F\u6837\uFF0C\u4E0D\u8981\u6539\u5199\u6216\u7FFB\u8BD1\u3002",
      "- \u603B\u5B57\u6570\u63A7\u5236\u5728 800 \u5B57\u4EE5\u5185\u3002"
    ];
    return sections.filter((item) => item !== null && item !== void 0).join("\n");
  }

  function cleanRubricText(text) {
    let value = String(text || "").trim();
    value = value.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
    return value.trim();
  }

  async function generateRubric(payload, service, rateLimiter, imageConfig) {
    const subject = String(payload?.subject || "").trim();
    const questionType = String(payload?.questionType || "").trim();
    if (!subject || !questionType) throw new Error("\u8BF7\u9009\u62E9\u5B66\u79D1\u4E0E\u9898\u578B");
    const question = String(payload?.question || "").trim();
    const answerText = String(payload?.answerText || "").trim();
    const maxScore = Number(payload?.maxScore) || 0;
    const rawImages = Array.isArray(payload?.answerImages) ? payload.answerImages.filter((src) => typeof src === "string" && src.trim()) : [];
    if (!question && !answerText && rawImages.length === 0) throw new Error("\u8BF7\u586B\u5199\u9898\u76EE\u6216\u6807\u51C6\u7B54\u6848");
    const prepared = [];
    for (const src of rawImages) {
      try {
        const image = await prepareImage(src, { ...(imageConfig || {}), cropToAnswer: false });
        if (image?.dataUrl) prepared.push(image);
      } catch { /* \u56FE\u7247\u5904\u7406\u5931\u8D25\u5219\u8DF3\u8FC7 */ }
    }
    const prompt = buildRubricPrompt({ subject, questionType, question, answerText, maxScore, hasImages: prepared.length > 0 });
    const content = [{ type: "text", text: prompt }];
    for (const image of prepared) {
      content.push({ type: "image_url", image_url: { url: image.dataUrl, detail: "high" } });
    }
    const messages = [
      { role: "system", content: "\u4F60\u662F\u7ECF\u9A8C\u4E30\u5BCC\u7684\u547D\u9898\u4E0E\u9605\u5377\u4E13\u5BB6\uFF0C\u64C5\u957F\u628A\u5B66\u6821\u6807\u51C6\u7B54\u6848\u6574\u7406\u6210\u7ED3\u6784\u6E05\u6670\u3001\u53EF\u5224\u5B9A\u3001\u53EF\u76F4\u63A5\u7528\u4E8E AI \u9605\u5377\u7684\u8BC4\u5206\u6807\u51C6\u3002\u5BF9\u4E8E\u6309\u70B9\u7ED9\u5206\u9898\uFF0C\u53EA\u5217\u5F97\u5206\u70B9\uFF0C\u7B54\u4E0D\u5230\u70B9\u4E0D\u7ED9\u5206\uFF0C\u7EDD\u4E0D\u8BBE\u7F6E\u5012\u6263\u89C4\u5219\u3002" },
      { role: "user", content }
    ];
    const raw = await chatCompletion(service, messages, {
      rateLimiter,
      timeoutMs: 9e4,
      estimatedTokens: estimateTokens(prompt, prepared.length),
      temperature: 0.3
    });
    return cleanRubricText(raw);
  }
  // src/core/parse.ts
  var STATUS_MAP = {
    legible: "legible",
    partial: "partial",
    illegible: "illegible",
    blank: "blank",
    \u53EF\u8FA8\u8BA4: "legible",
    \u6E05\u6670: "legible",
    \u90E8\u5206\u4E0D\u6E05: "partial",
    \u90E8\u5206\u53EF\u8FA8: "partial",
    \u65E0\u6CD5\u8FA8\u8BA4: "illegible",
    \u672A\u4F5C\u7B54: "blank",
    \u7A7A\u767D: "blank"
  };
  function asRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  }
  function clamp(value, max) {
    const safe = Number.isFinite(value) ? value : 0;
    const upper = max > 0 ? max : 999;
    return Math.min(upper, Math.max(0, safe));
  }
  function mapStatus(value) {
    if (typeof value !== "string") return "legible";
    return STATUS_MAP[value.trim()] ?? "legible";
  }
  function extractScore(text, maxScore) {
    const labeled = text.match(/【得分】\s*([+\-]?\d+(?:\.\d+)?)/);
    if (labeled) return clamp(Number(labeled[1]), maxScore);
    const equations = [...text.matchAll(/=\s*([+\-]?\d+(?:\.\d+)?)/g)];
    if (equations.length > 0) {
      return clamp(Number(equations[equations.length - 1][1]), maxScore);
    }
    const numbers = [...text.matchAll(/[+\-]?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
    if (numbers.length === 0) return 0;
    return clamp(numbers[numbers.length - 1], maxScore);
  }
  function parseSubScores(value, maxScore) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      const record = asRecord(item);
      if (!record) return [];
      const label = String(record.label ?? "").trim();
      if (!label) return [];
      const itemMax = clamp(Number(record.maxScore ?? 0), maxScore);
      return [{
        label,
        score: clamp(Number(record.score ?? 0), itemMax > 0 ? itemMax : maxScore),
        maxScore: itemMax,
        reason: String(record.reason ?? "").slice(0, 200)
      }];
    });
  }
  function fromJson(raw, maxScore) {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const record = asRecord(JSON.parse(cleaned.slice(start, end + 1)));
      if (!record) return null;
      const subScores = parseSubScores(record.subScores, maxScore);
      const fallbackScore = subScores.reduce((sum, item) => sum + item.score, 0);
      const scoreValue = record.score === void 0 ? fallbackScore : Number(record.score);
      return {
        status: mapStatus(record.status),
        score: clamp(scoreValue, maxScore),
        subScores,
        reason: String(record.reason ?? "").slice(0, 300),
        confidence: clamp(Number(record.confidence ?? 0.7), 1),
        raw
      };
    } catch {
      return null;
    }
  }
  function fromText(raw, maxScore, subQuestions) {
    const statusMatch = raw.match(/【作答状态】\s*([^\n\r]+)/);
    const reasonMatch = raw.match(/【(?:理由|评分依据|评语)】\s*([\s\S]*?)(?=\n【|$)/);
    const subScores = [];
    for (const item of subQuestions) {
      const escaped = item.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = raw.match(new RegExp(`${escaped}[^\\n]*?(\\d+(?:\\.\\d+)?)\\s*(?:/|\u5206|\\|)`, "i"));
      if (match) {
        subScores.push({
          label: item.label,
          score: clamp(Number(match[1]), item.maxScore > 0 ? item.maxScore : maxScore),
          maxScore: item.maxScore,
          reason: ""
        });
      }
    }
    const subTotal = subScores.reduce((sum, item) => sum + item.score, 0);
    return {
      status: statusMatch ? mapStatus(statusMatch[1]) : "legible",
      score: subScores.length > 0 ? subTotal : extractScore(raw, maxScore),
      subScores,
      reason: reasonMatch ? reasonMatch[1].trim().slice(0, 300) : "",
      confidence: 0.5,
      raw
    };
  }
  function parseGrade(raw, maxScore, subQuestions = []) {
    return fromJson(raw, maxScore) ?? fromText(raw, maxScore, subQuestions);
  }

  // src/core/pipeline.ts
  function configured(service) {
    return Boolean(service.endpoint.trim() && service.model.trim());
  }
  async function runGrade(service, question, maxScore, prompt, images, config, rateLimiter) {
    const content = [
      { type: "text", text: prompt },
      ...images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl, detail: "high" } }))
    ];
    const messages = [
      { role: "system", content: "\u4F60\u662F\u4E25\u683C\u4F46\u516C\u6B63\u7684\u9605\u5377\u52A9\u624B\uFF0C\u53EA\u8F93\u51FA JSON\u3002" },
      { role: "user", content }
    ];
    const raw = await chatCompletion(service, messages, {
      rateLimiter,
      timeoutMs: config.pipeline.timeoutMs,
      jsonMode: true,
      estimatedTokens: estimateTokens(prompt, images.length)
    });
    if (!raw.trim()) throw new Error("\u6A21\u578B\u8FD4\u56DE\u4E3A\u7A7A");
    return parseGrade(raw, maxScore, question.subQuestions);
  }
  async function gradeQuestion(options) {
    const { config, question, cache, rateLimiter } = options;
    config.pipeline.vlm.thinkingMode = normalizeThinkingMode(config.pipeline.thinkingMode !== void 0 ? config.pipeline.thinkingMode : config.pipeline.disableThinking);
    const startedAt = Date.now();
    const stage = (name, detail) => options.events?.onStage?.(name, detail);
    const reviewReasons = [];
    const maxScore = config.context.maxScore > 0 ? config.context.maxScore : question.maxScore;
    const gradeService = config.pipeline.vlm;
    if (!configured(gradeService)) throw new Error("\u6279\u6539\u670D\u52A1\u672A\u914D\u7F6E\u5B8C\u6574\uFF0C\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u586B\u5199\u591A\u6A21\u6001\u670D\u52A1\u7684\u63A5\u53E3\u5730\u5740\u4E0E\u6A21\u578B");
    stage("\u51C6\u5907\u4F5C\u7B54\u56FE\u7247");
    const preparedList = (await Promise.all(
      question.images.map((src) => prepareImage(src, config.image).catch(() => null))
    )).filter((item) => item !== null);
    const prepared = dedupePrepared(preparedList);
    const removed = prepared.filter((image) => isBlankImage(image) || isWasteImage(image));
    const usable = prepared.filter((image) => !isBlankImage(image) && !isWasteImage(image));
    if (removed.length > 0) reviewReasons.push(`\u5DF2\u5254\u9664 ${removed.length} \u5F20\u5E9F\u56FE`);
    if (usable.length === 0) {
      throw new Error("\u672A\u83B7\u53D6\u5230\u53EF\u7528\u4F5C\u7B54\u56FE\u7247\uFF0C\u8BF7\u7B49\u5F85\u9605\u5377\u9875\u56FE\u7247\u52A0\u8F7D\u5B8C\u6210\u540E\u91CD\u8BD5");
    }
    const prompt = buildGradingPrompt(question, config.context, {
      profile: config.image.profile,
      removedImages: removed.length
    });
    const cacheKey = makeGradeCacheKey({
      question,
      context: config.context,
      model: gradeService.model,
      promptVersion: PROMPT_VERSION
    });
    const cached = cache.get(cacheKey);
    if (cached) {
      stage("\u8BC4\u5206\u7F13\u5B58\u547D\u4E2D");
      return { ...cached, cacheHit: true, elapsedMs: Date.now() - startedAt, cacheKey };
    }
    stage("\u6A21\u578B\u8BC4\u5206", gradeService.model);
    const grade = await runGrade(gradeService, question, maxScore, prompt, usable, config, rateLimiter);
    if (grade.status === "blank" && grade.score > 0) {
      reviewReasons.push("\u8BC6\u522B\u4E3A\u672A\u4F5C\u7B54\u4F46\u7ED9\u51FA\u4E86\u6B63\u5206\uFF0C\u8BF7\u4EBA\u5DE5\u6838\u67E5");
    }
    if (grade.confidence < 0.5) reviewReasons.push("\u6A21\u578B\u7F6E\u4FE1\u5EA6\u8F83\u4F4E\uFF0C\u5EFA\u8BAE\u4EBA\u5DE5\u590D\u6838");
    const result = {
      ...grade,
      maxScore,
      pipeline: "vlm",
      needsReview: reviewReasons.length > 0,
      reviewReasons,
      cacheHit: false,
      cacheKey,
      elapsedMs: Date.now() - startedAt,
      model: gradeService.model,
      createdAt: Date.now()
    };
    cache.set(cacheKey, result);
    return result;
  }
  // src/infra/rate-limit.ts
  var RateLimiter = class {
    constructor(options) {
      this.options = options;
      this.active = 0;
      this.starts = [];
      this.tokens = [];
      this.now = options.now ?? Date.now;
      this.wait = options.wait ?? ((ms) => new Promise((resolve) => window.setTimeout(resolve, ms)));
    }
    prune() {
      const cutoff = this.now() - 6e4;
      this.starts = this.starts.filter((time) => time > cutoff);
      this.tokens = this.tokens.filter((entry) => entry.at > cutoff);
    }
    tokenUsed() {
      return this.tokens.reduce((sum, entry) => sum + entry.value, 0);
    }
    async acquire(estimatedTokens) {
      for (; ; ) {
        this.prune();
        const rpmFull = this.starts.length >= this.options.maxRpm;
        const tpmFull = this.tokenUsed() + estimatedTokens > this.options.maxTpm;
        const concurrencyFull = this.active >= this.options.maxConcurrent;
        if (!rpmFull && !tpmFull && !concurrencyFull) break;
        await this.wait(200);
      }
      const time = this.now();
      this.starts.push(time);
      this.tokens.push({ at: time, value: estimatedTokens });
      this.active += 1;
    }
    async run(task, estimatedTokens = 0) {
      await this.acquire(estimatedTokens);
      try {
        return await task();
      } finally {
        this.active -= 1;
      }
    }
    get queuePressure() {
      this.prune();
      const rpm = this.options.maxRpm > 0 ? this.starts.length / this.options.maxRpm : 0;
      const tpm = this.options.maxTpm > 0 ? this.tokenUsed() / this.options.maxTpm : 0;
      return Math.max(rpm, tpm);
    }
  };

  // src/ui/styles.ts
  var STYLES = `
:host {
  --zygr-primary: #4f46e5;
  --zygr-sky: #0ea5e9;
  --zygr-teal: #14b8a6;
  --zygr-ink: #0f172a;
  --zygr-muted: #475569;
  --zygr-line: rgba(148, 163, 184, .28);
  --zygr-surface: rgba(255, 255, 255, .82);
  --zygr-glow: rgba(79, 70, 229, .18);
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483647;
  font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  font-size: 13px;
  color: var(--zygr-ink);
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .55; }
.zygr-panel {
  width: 380px;
  max-height: calc(100vh - 40px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 18px;
  border: 1px solid rgba(255, 255, 255, .65);
  background: linear-gradient(160deg, rgba(255,255,255,.92), rgba(238,242,255,.78));
  backdrop-filter: blur(18px) saturate(140%);
  box-shadow: 0 18px 48px rgba(15, 23, 42, .2), inset 0 1px 0 rgba(255,255,255,.7);
  animation: zygr-in .32s cubic-bezier(.2,.8,.2,1);
}
.zygr-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 14px 16px;
  color: #fff;
  background: linear-gradient(135deg, #4f46e5 0%, #0ea5e9 100%);
  position: relative;
  overflow: hidden;
}
.zygr-head::after {
  content: ""; position: absolute; inset: -60% -20% auto auto; width: 180px; height: 180px;
  background: radial-gradient(circle, rgba(255,255,255,.35), transparent 70%);
  animation: zygr-float 6s ease-in-out infinite;
}
.zygr-brand { display: flex; align-items: center; gap: 10px; position: relative; z-index: 1; }
.zygr-logo {
  width: 34px; height: 34px; display: grid; place-items: center; border-radius: 11px;
  background: rgba(255,255,255,.22); border: 1px solid rgba(255,255,255,.4);
  font-weight: 700; font-size: 17px; letter-spacing: 1px;
}
.zygr-brand strong { display: block; font-size: 16px; letter-spacing: .5px; }
.zygr-brand small { display: block; opacity: .86; font-size: 11px; margin-top: 2px; }
.zygr-head-actions { display: flex; gap: 6px; position: relative; z-index: 1; }
.zygr-icon {
  width: 28px; height: 28px; border: 1px solid rgba(255,255,255,.32); border-radius: 9px;
  background: rgba(255,255,255,.14); color: #fff; line-height: 1; transition: .18s;
}
.zygr-icon:hover { background: rgba(255,255,255,.28); transform: translateY(-1px); }
.zygr-body { padding: 12px 14px; overflow: auto; display: grid; gap: 10px; }
.zygr-panel.zygr-collapsed .zygr-body,
.zygr-panel.zygr-collapsed .zygr-actions { display: none; }
.zygr-statusbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--zygr-muted); }
.zygr-chip {
  padding: 3px 9px; border-radius: 999px; font-size: 11px; white-space: nowrap;
  background: rgba(79,70,229,.1); color: #4338ca; border: 1px solid rgba(79,70,229,.18);
}
.zygr-chip.zygr-warn { background: rgba(245,158,11,.12); color: #b45309; border-color: rgba(245,158,11,.25); }
.zygr-chip.zygr-ok { background: rgba(22,163,74,.12); color: #15803d; border-color: rgba(22,163,74,.25); }
.zygr-progress { height: 3px; border-radius: 999px; overflow: hidden; background: rgba(148,163,184,.22); }
.zygr-progress i {
  display: block; height: 100%; width: 0; border-radius: inherit;
  background: linear-gradient(90deg, var(--zygr-primary), var(--zygr-sky), var(--zygr-teal));
  transition: width .4s ease;
}
.zygr-card {
  border: 1px solid var(--zygr-line); border-radius: 14px; padding: 12px;
  background: rgba(255,255,255,.62); box-shadow: 0 6px 18px rgba(15,23,42,.05);
}
.zygr-meta { color: var(--zygr-muted); line-height: 1.7; }
.zygr-thumbs { display: flex; gap: 6px; overflow-x: auto; margin-top: 9px; padding-bottom: 2px; }
.zygr-thumbs img {
  width: 54px; height: 54px; flex: none; object-fit: cover; border-radius: 9px;
  border: 1px solid var(--zygr-line); cursor: zoom-in; transition: transform .18s, box-shadow .18s;
}
.zygr-thumbs img:hover { transform: scale(1.08); box-shadow: 0 6px 14px rgba(15,23,42,.14); }
.zygr-score-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
.zygr-score { font-size: 34px; font-weight: 700; line-height: 1; letter-spacing: -1px; background: linear-gradient(135deg, #4f46e5, #0ea5e9); -webkit-background-clip: text; background-clip: text; color: transparent; }
.zygr-score small { font-size: 14px; color: var(--zygr-muted); -webkit-text-fill-color: var(--zygr-muted); }
.zygr-score-input {
  width: 78px; padding: 2px 6px; border: 1px solid rgba(79,70,229,.28); border-radius: 9px;
  background: rgba(255,255,255,.9); color: #3730a3; font-size: 20px; font-weight: 700; line-height: 1.2;
  -webkit-text-fill-color: #3730a3; text-align: center;
}
.zygr-score-input:focus { outline: 2px solid var(--zygr-sky); outline-offset: 1px; }
.zygr-table .zygr-score-input { width: 62px; padding: 3px 5px; font-size: 12px; }
.zygr-badge { padding: 4px 10px; border-radius: 999px; font-size: 11px; background: rgba(20,184,166,.12); color: #0f766e; border: 1px solid rgba(20,184,166,.24); }
.zygr-badge.zygr-risk { background: rgba(220,38,38,.1); color: #b91c1c; border-color: rgba(220,38,38,.22); }
.zygr-reason { margin-top: 10px; color: var(--zygr-muted); line-height: 1.65; }
.zygr-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
.zygr-table th, .zygr-table td { text-align: left; padding: 6px 5px; border-top: 1px solid var(--zygr-line); }
.zygr-table th { color: var(--zygr-muted); font-weight: 500; }
.zygr-reviews { margin-top: 8px; color: #b45309; line-height: 1.6; }
.zygr-error { padding: 9px 11px; border-radius: 10px; background: rgba(220,38,38,.08); color: #b91c1c; border: 1px solid rgba(220,38,38,.18); }
.zygr-actions {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 12px 10px;
  border-top: 1px solid var(--zygr-line); background: rgba(255,255,255,.42);
}
.zygr-btn {
  display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
  min-height: 28px; padding: 0 10px; line-height: 1; white-space: nowrap;
  border-radius: 7px; border: 1px solid rgba(79,70,229,.18);
  background: rgba(255,255,255,.78); color: #3730a3; font-size: 11px; transition: .18s;
}
.zygr-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 3px 9px rgba(79,70,229,.14); }
.zygr-btn:focus-visible { outline: 2px solid var(--zygr-sky); outline-offset: 2px; }
.zygr-btn.zygr-primary { color: #fff; border-color: transparent; background: linear-gradient(135deg, var(--zygr-primary), var(--zygr-sky)); }
.zygr-btn.zygr-running { color: #fff; border-color: transparent; background: linear-gradient(135deg, #dc2626, #f59e0b); }
.zygr-btn.zygr-ghost { color: var(--zygr-muted); border-color: var(--zygr-line); background: transparent; }
.zygr-submit-cell { display: flex; flex-direction: row; align-items: center; gap: 6px; }
.zygr-mini-check { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; line-height: 1; white-space: nowrap; color: var(--zygr-muted); cursor: pointer; user-select: none; }
.zygr-mini-check input { accent-color: var(--zygr-primary); width: 12px; height: 12px; flex: none; }
.zygr-toast {
  position: absolute; left: 50%; bottom: 74px; transform: translateX(-50%); z-index: 2;
  padding: 8px 14px; border-radius: 999px; background: rgba(15,23,42,.9); color: #fff; font-size: 12px;
  animation: zygr-in .2s ease; white-space: nowrap;
}
.zygr-test-status { font-size: 12px; color: var(--zygr-muted); }
.zygr-test-status.zygr-ok { color: #15803d; }
.zygr-test-status.zygr-bad { color: #b91c1c; }
.zygr-overlay {
  position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center;
  background: rgba(15,23,42,.38); backdrop-filter: blur(4px); padding: 20px;
}
.zygr-dialog {
  position: relative;
  width: min(680px, 100%); max-height: min(82vh, 760px); display: flex; flex-direction: column;
  border-radius: 20px; overflow: hidden; background: linear-gradient(160deg, #fff, #eef2ff);
  border: 1px solid rgba(255,255,255,.75); box-shadow: 0 24px 70px rgba(15,23,42,.28);
  animation: zygr-in .25s ease;
}
.zygr-dialog.zygr-wide { width: min(840px, 100%); }
.zygr-dialog-head { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; color: #fff; background: linear-gradient(135deg,#4f46e5,#0ea5e9); }
.zygr-dialog-head h2 { margin: 0; font-size: 17px; }
.zygr-dialog-body { padding: 16px 20px; overflow: auto; display: grid; gap: 14px; }
.zygr-dialog-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--zygr-line); }
.zygr-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--zygr-line); }
.zygr-tab { padding: 8px 14px; border: 0; background: transparent; color: var(--zygr-muted); border-bottom: 2px solid transparent; transition: .18s; }
.zygr-tab.zygr-active { color: var(--zygr-primary); border-color: var(--zygr-primary); }
.zygr-section { display: grid; gap: 10px; }
.zygr-section h3 { margin: 0; font-size: 14px; color: #3730a3; }
.zygr-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; }
.zygr-field { display: grid; gap: 5px; }
.zygr-field label { font-size: 12px; color: var(--zygr-muted); }
.zygr-field input, .zygr-field select, .zygr-field textarea {
  width: 100%; padding: 8px 10px; border-radius: 9px; border: 1px solid var(--zygr-line);
  background: rgba(255,255,255,.9); outline: none; transition: .18s;
}
.zygr-field input:focus, .zygr-field select:focus { border-color: var(--zygr-primary); box-shadow: 0 0 0 3px var(--zygr-glow); }
.zygr-hint { font-size: 11px; color: var(--zygr-muted); line-height: 1.6; }
.zygr-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
[data-model-options] { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
[data-model-options] select { flex: 1; min-width: 0; padding: 7px 9px; border: 1px solid var(--zygr-line); border-radius: 8px; background: #fff; color: var(--zygr-text); font-size: 13px; }
.zygr-list { display: grid; gap: 8px; }
.zygr-item { border: 1px solid var(--zygr-line); border-radius: 12px; padding: 10px 12px; background: rgba(255,255,255,.7); cursor: pointer; transition: .18s; }
.zygr-item:hover { transform: translateY(-1px); box-shadow: 0 8px 18px rgba(15,23,42,.08); }
.zygr-item.zygr-selected { border-color: var(--zygr-primary); box-shadow: 0 0 0 2px var(--zygr-glow); }
.zygr-detail { white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.7; color: var(--zygr-muted); }
.zygr-empty { text-align: center; color: var(--zygr-muted); padding: 24px; }
.zygr-history-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: 12px; align-items: start; }
.zygr-history-list, .zygr-history-detail { max-height: 52vh; overflow: auto; }
.zygr-history-detail { position: sticky; top: 0; }
@media (max-width: 720px) {
  .zygr-history-grid { grid-template-columns: 1fr; }
  .zygr-history-list { max-height: 30vh; }
  .zygr-history-detail { position: static; max-height: none; }
}
@keyframes zygr-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes zygr-float { 0%,100% { transform: translate(0,0); } 50% { transform: translate(-18px,18px); } }
@media (max-width: 520px) {
  :host { left: 0; right: 0; bottom: 0; }
  .zygr-panel { width: 100%; max-height: 72vh; border-radius: 18px 18px 0 0; }
  .zygr-grid { grid-template-columns: 1fr; }
}
`;

  // src/ui/panel.ts
  var STATUS_LABEL = {
    legible: "\u53EF\u8FA8\u8BA4",
    partial: "\u90E8\u5206\u4E0D\u6E05",
    illegible: "\u65E0\u6CD5\u8FA8\u8BA4",
    blank: "\u672A\u4F5C\u7B54"
  };
  var SKIP_CONFIRM_KEY = "zygr.submit.skipConfirm.v1";
  var GraderPanel = class {
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.toastTimer = 0;
      this.host = document.createElement("div");
      this.host.className = "zygr-host";
      this.shadow = this.host.attachShadow({ mode: "open" });
      this.shadow.innerHTML = `<style>${STYLES}</style>${this.markup()}`;
      this.panel = this.q(".zygr-panel");
      const skipConfirm = this.shadow.querySelector("[data-opt='skip-submit-confirm']");
      if (skipConfirm) skipConfirm.checked = readJson(SKIP_CONFIRM_KEY, false) === true;
      this.bind();
    }
    markup() {
      return `<div class="zygr-panel">
      <header class="zygr-head">
        <div class="zygr-brand">
          <span class="zygr-logo">\u667A</span>
          <div><strong>\u667A\u9605\u6279\u6539\u52A9\u624B</strong><small id="zygr-subtitle">\u7B49\u5F85\u8BFB\u53D6\u9898\u76EE</small></div>
        </div>
        <div class="zygr-head-actions">
          <button class="zygr-icon" data-act="collapse" title="\u6298\u53E0" aria-label="\u6298\u53E0">\u2014</button>
          <button class="zygr-icon" data-act="close" title="\u5173\u95ED" aria-label="\u5173\u95ED">\xD7</button>
        </div>
      </header>
      <div class="zygr-body">
        <div class="zygr-statusbar"><span id="zygr-stage">\u5C31\u7EEA</span><span class="zygr-chip" id="zygr-cache">\u5F85\u914D\u7F6E</span></div>
        <div class="zygr-progress"><i id="zygr-bar"></i></div>
        <section class="zygr-card"><div class="zygr-meta" id="zygr-meta">\u5C1A\u672A\u68C0\u6D4B\u5230\u9605\u5377\u9875\u9762</div><div class="zygr-thumbs" id="zygr-thumbs"></div></section>
        <section class="zygr-card" id="zygr-result"><div class="zygr-reason">\u6279\u6539\u7ED3\u679C\u5C06\u663E\u793A\u5728\u8FD9\u91CC</div></section>
        <div class="zygr-error" id="zygr-error" hidden></div>
      </div>
      <footer class="zygr-actions">
        <button class="zygr-btn zygr-primary" data-act="grade">\u5F00\u59CB\u6279\u6539</button>
        <button class="zygr-btn" data-act="continuous">\u8FDE\u7EED\u6279\u9605</button>
        <div class="zygr-submit-cell">
          <button class="zygr-btn" data-act="submit">\u63D0\u4EA4\u7ED3\u679C</button>
          <label class="zygr-mini-check"><input type="checkbox" data-opt="skip-submit-confirm"> \u4E00\u6B21\u63D0\u4EA4\uFF08\u514D\u786E\u8BA4\uFF09</label>
        </div>
        <button class="zygr-btn zygr-ghost" data-act="history">\u5386\u53F2</button>
        <button class="zygr-btn zygr-ghost" data-act="settings">\u8BBE\u7F6E</button>
      </footer>
      <div class="zygr-toast" id="zygr-toast" hidden></div>
    </div>`;
    }
    q(selector) {
      const element = this.shadow.querySelector(selector);
      if (!element) throw new Error(`\u754C\u9762\u5143\u7D20\u7F3A\u5931\uFF1A${selector}`);
      return element;
    }
    setText(id, value) {
      this.q(`#${id}`).textContent = value;
    }
    bind() {
      this.shadow.addEventListener("change", (event) => {
        const target = event.target;
        if (target?.matches?.("[data-opt='skip-submit-confirm']")) {
          writeJson(SKIP_CONFIRM_KEY, Boolean(target.checked));
        }
      });
      this.shadow.addEventListener("click", (event) => {
        const button = event.target.closest("[data-act]");
        if (!button) return;
        const action = button.dataset.act;
        if (action === "collapse") {
          this.panel.classList.toggle("zygr-collapsed");
        } else if (action === "close") {
          this.hide();
        } else if (action === "grade") {
          this.callbacks.onGrade();
        } else if (action === "continuous") {
          this.callbacks.onContinuous();
        } else if (action === "submit") {
          const skipConfirm = Boolean(this.shadow.querySelector("[data-opt='skip-submit-confirm']")?.checked);
          this.callbacks.onSubmit(skipConfirm);
        } else if (action === "history") {
          this.callbacks.onHistory();
        } else if (action === "settings") {
          this.callbacks.onSettings();
        }
      });
    }
    mount() {
      if (!this.host.isConnected) document.body.appendChild(this.host);
    }
    show() {
      this.mount();
      this.panel.hidden = false;
    }
    hide() {
      this.panel.hidden = true;
    }
    setSubtitle(value) {
      this.setText("zygr-subtitle", value);
    }
    setQuestion(question) {
      this.renderThumbs(question?.images ?? []);
      if (!question) {
        this.setText("zygr-meta", "\u5C1A\u672A\u68C0\u6D4B\u5230\u9605\u5377\u9875\u9762");
        return;
      }
      const subs = question.subQuestions.length > 0 ? ` \xB7 ${question.subQuestions.length} \u4E2A\u5C0F\u9898` : "";
      this.setText("zygr-meta", `\u9898\u53F7 ${question.questionId}${subs} \xB7 \u6EE1\u5206 ${question.maxScore || "\u672A\u6307\u5B9A"} \xB7 \u4F5C\u7B54\u56FE\u7247 ${question.images.length} \u5F20`);
    }
    renderThumbs(images) {
      const container = this.q("#zygr-thumbs");
      container.replaceChildren();
      for (const src of images.slice(0, 6)) {
        if (!/^(data:image\/|https?:\/\/)/i.test(src)) continue;
        const image = document.createElement("img");
        image.src = src;
        image.alt = "\u4F5C\u7B54\u56FE\u7247\u7F29\u7565\u56FE";
        image.title = "\u4F5C\u7B54\u56FE\u7247\u7F29\u7565\u56FE";
        image.onerror = () => image.remove();
        container.appendChild(image);
      }
    }
    setStage(stage, detail) {
      this.setText("zygr-stage", detail ? `${stage} \xB7 ${detail}` : stage);
      const progress = this.q("#zygr-bar");
      progress.style.width = stage.includes("\u7F13\u5B58\u547D\u4E2D") || stage === "\u5B8C\u6210" ? "100%" : stage.includes("\u8BC4\u5206") ? "70%" : "35%";
    }
    setCache(label, kind = "idle") {
      const chip = this.q("#zygr-cache");
      chip.textContent = label;
      chip.className = `zygr-chip${kind === "ok" ? " zygr-ok" : kind === "warn" ? " zygr-warn" : ""}`;
    }
    setBusy(busy, label = "\u5904\u7406\u4E2D") {
      this.shadow.querySelectorAll('.zygr-actions .zygr-btn:not([data-act="continuous"])').forEach((button) => {
        button.disabled = busy;
      });
      if (busy) this.setStage(label);
    }
    setAutoMode(active) {
      const button = this.q('[data-act="continuous"]');
      button.textContent = active ? "\u505C\u6B62\u8FDE\u7EED\u6279\u9605" : "\u8FDE\u7EED\u6279\u9605";
      button.classList.toggle("zygr-running", active);
    }
    showError(message) {
      const box = this.q("#zygr-error");
      box.textContent = message;
      box.hidden = false;
    }
    clearError() {
      const box = this.q("#zygr-error");
      box.textContent = "";
      box.hidden = true;
    }
    setResult(result) {
      const container = this.q("#zygr-result");
      container.replaceChildren();
      const row = document.createElement("div");
      row.className = "zygr-score-row";
      const score = document.createElement("div");
      score.className = "zygr-score zygr-score-editable";
      const scoreInput = document.createElement("input");
      scoreInput.type = "number";
      scoreInput.className = "zygr-score-input";
      scoreInput.min = "0";
      scoreInput.max = String(result.maxScore || 999);
      scoreInput.step = "0.5";
      scoreInput.value = String(Math.round(result.score * 10) / 10);
      scoreInput.title = "\u53EF\u76F4\u63A5\u4FEE\u6539\u603B\u5206";
      const unit = document.createElement("small");
      unit.textContent = ` / ${result.maxScore || "\u2014"} \u5206`;
      score.append(scoreInput, unit);
      const badge = document.createElement("span");
      badge.className = `zygr-badge${result.needsReview ? " zygr-risk" : ""}`;
      badge.textContent = `${STATUS_LABEL[result.status]}${result.needsReview ? " \xB7 \u9700\u590D\u6838" : ""}`;
      row.append(score, badge);
      container.appendChild(row);
      const reason = document.createElement("div");
      reason.className = "zygr-reason";
      reason.textContent = result.reason || "\u672A\u8FD4\u56DE\u8BC4\u5206\u4F9D\u636E";
      container.appendChild(reason);
      if (result.subScores.length > 0) {
        const table = document.createElement("table");
        table.className = "zygr-table";
        const head = document.createElement("thead");
        head.innerHTML = "<tr><th>\u5C0F\u9898</th><th>\u5F97\u5206</th><th>\u4F9D\u636E</th></tr>";
        const body = document.createElement("tbody");
        result.subScores.forEach((item, index) => {
          const tr = document.createElement("tr");
          const labelTd = document.createElement("td");
          labelTd.textContent = `${item.label}/${item.maxScore}`;
          const scoreTd = document.createElement("td");
          const subInput = document.createElement("input");
          subInput.type = "number";
          subInput.className = "zygr-score-input zygr-subscore-input";
          subInput.min = "0";
          subInput.max = String(item.maxScore || 999);
          subInput.step = "0.5";
          subInput.value = String(Math.round(Number(item.score) * 10) / 10);
          subInput.dataset.scoreIndex = String(index);
          subInput.title = "\u53EF\u76F4\u63A5\u4FEE\u6539\u8BE5\u5C0F\u9898\u5F97\u5206";
          scoreTd.appendChild(subInput);
          const reasonTd = document.createElement("td");
          reasonTd.textContent = item.reason || "\u2014";
          tr.append(labelTd, scoreTd, reasonTd);
          body.appendChild(tr);
        });
        table.append(head, body);
        container.appendChild(table);
      }
      const reviews = [...result.reviewReasons];
      if (reviews.length > 0) {
        const note = document.createElement("div");
        note.className = "zygr-reviews";
        note.textContent = reviews.join("\uFF1B");
        container.appendChild(note);
      }
      const meta = document.createElement("div");
      meta.className = "zygr-reason";
      meta.textContent = `\u94FE\u8DEF ${result.pipeline} \xB7 \u6A21\u578B ${result.model} \xB7 \u8017\u65F6 ${(result.elapsedMs / 1e3).toFixed(1)}s`;
      container.appendChild(meta);
      this.setCache(result.cacheHit ? "\u7F13\u5B58\u547D\u4E2D" : "\u65B0\u7ED3\u679C", result.cacheHit ? "ok" : result.needsReview ? "warn" : "idle");
      this.setStage("\u5B8C\u6210");
    }
    getScoreEdits() {
      const total = this.shadow.querySelector(".zygr-score-input[data-score-index=''], .zygr-score-editable .zygr-score-input");
      const subInputs = [...this.shadow.querySelectorAll(".zygr-subscore-input")];
      const subScores = subInputs.map((input) => Number(input.value));
      return {
        total: total && total.value.trim() !== "" ? Number(total.value) : null,
        subScores: subInputs.length ? subScores : null
      };
    }
    toast(message) {
      const element = this.q("#zygr-toast");
      element.textContent = message;
      element.hidden = false;
      window.clearTimeout(this.toastTimer);
      this.toastTimer = window.setTimeout(() => {
        element.hidden = true;
      }, 2400);
    }
  };

  // src/ui/history.ts
  var HistoryPanel = class {
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.entries = [];
      this.selectedId = "";
      this.host = document.createElement("div");
      this.host.className = "zygr-host";
      this.shadow = this.host.attachShadow({ mode: "open" });
      this.shadow.innerHTML = `<style>${STYLES}</style>${this.markup()}`;
      this.bind();
    }
    markup() {
      return `<div class="zygr-overlay" hidden><div class="zygr-dialog zygr-wide">
      <div class="zygr-dialog-head"><h2>\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u5386\u53F2\u8BB0\u5F55</h2><button class="zygr-icon" data-act="close" aria-label="\u5173\u95ED">\xD7</button></div>
      <div class="zygr-dialog-body">
        <div class="zygr-row">
          <select data-filter="review" aria-label="\u590D\u6838\u7B5B\u9009"><option value="">\u5168\u90E8\u72B6\u6001</option><option value="review">\u9700\u590D\u6838</option><option value="normal">\u6B63\u5E38</option></select>
          <input data-filter="keyword" type="search" placeholder="\u641C\u7D22\u9898\u53F7\u6216\u4F9D\u636E" aria-label="\u641C\u7D22">
        </div>
        <div class="zygr-history-grid">
          <div class="zygr-history-list"><div class="zygr-list" data-list></div></div>
          <div class="zygr-card zygr-history-detail" data-detail><div class="zygr-empty">\u9009\u62E9\u4E00\u6761\u8BB0\u5F55\u67E5\u770B\u8BE6\u60C5</div></div>
        </div>
      </div>
      <div class="zygr-dialog-foot">
        <button class="zygr-btn zygr-ghost" data-act="clear">\u6E05\u7A7A\u5386\u53F2</button>
        <button class="zygr-btn" data-act="csv">\u5BFC\u51FA CSV</button>
        <button class="zygr-btn" data-act="html">\u5BFC\u51FA HTML</button>
        <button class="zygr-btn zygr-primary" data-act="close">\u5173\u95ED</button>
      </div>
    </div></div>`;
    }
    q(selector) {
      const element = this.shadow.querySelector(selector);
      if (!element) throw new Error(`\u5386\u53F2\u754C\u9762\u5143\u7D20\u7F3A\u5931\uFF1A${selector}`);
      return element;
    }
    bind() {
      this.shadow.addEventListener("click", (event) => {
        const target = event.target;
        const action = target.closest("[data-act]")?.dataset.act;
        if (action === "close") this.hide();
        else if (action === "clear") this.callbacks.onClear();
        else if (action === "csv") this.callbacks.onExport("csv");
        else if (action === "html") this.callbacks.onExport("html");
        const item = target.closest("[data-id]");
        if (item?.dataset.id) {
          this.selectedId = item.dataset.id;
          this.render();
          this.q("[data-detail]").scrollTop = 0;
        }
      });
      this.shadow.addEventListener("input", () => this.render());
      this.shadow.addEventListener("change", () => this.render());
    }
    filtered() {
      const review = this.q("[data-filter='review']").value;
      const keyword = this.q("[data-filter='keyword']").value.trim().toLowerCase();
      return this.entries.filter((entry) => {
        if (review === "review" && !entry.result.needsReview) return false;
        if (review === "normal" && entry.result.needsReview) return false;
        if (keyword && !`${entry.question.questionId} ${entry.result.reason}`.toLowerCase().includes(keyword)) return false;
        return true;
      });
    }
    render() {
      const list = this.q("[data-list]");
      list.replaceChildren();
      const entries = this.filtered();
      if (entries.length === 0) {
        const empty = document.createElement("div");
        empty.className = "zygr-empty";
        empty.textContent = "\u6682\u65E0\u7B26\u5408\u6761\u4EF6\u7684\u8BB0\u5F55";
        list.appendChild(empty);
      }
      for (const entry of entries) {
        const item = document.createElement("div");
        item.className = "zygr-item";
        if (entry.id === this.selectedId) item.classList.add("zygr-selected");
        item.dataset.id = entry.id;
        item.textContent = `${new Date(entry.createdAt).toLocaleString("zh-CN")} \xB7 \u9898\u53F7 ${entry.question.questionId} \xB7 ${entry.result.score}/${entry.result.maxScore} \xB7 ${entry.result.pipeline}${entry.result.needsReview ? " \xB7 \u9700\u590D\u6838" : ""}`;
        list.appendChild(item);
      }
      this.renderDetail();
    }
    renderDetail() {
      const container = this.q("[data-detail]");
      container.replaceChildren();
      const entry = this.entries.find((item) => item.id === this.selectedId);
      if (!entry) {
        const empty = document.createElement("div");
        empty.className = "zygr-empty";
        empty.textContent = "\u9009\u62E9\u4E00\u6761\u8BB0\u5F55\u67E5\u770B\u8BE6\u60C5";
        container.appendChild(empty);
        return;
      }
      const detail = document.createElement("div");
      detail.className = "zygr-detail";
      const lines = [
        `\u9898\u53F7\uFF1A${entry.question.questionId}`,
        `\u94FE\u8DEF / \u6A21\u578B\uFF1A${entry.result.pipeline} / ${entry.result.model}`,
        `\u7ED3\u679C\uFF1A${entry.result.score} / ${entry.result.maxScore}\uFF08${entry.result.status}\uFF09`,
        `\u4F9D\u636E\uFF1A${entry.result.reason || "\u65E0"}`,
        `\u590D\u6838\uFF1A${entry.result.reviewReasons.join("\uFF1B") || "\u65E0"}`,
        `\u5C0F\u9898\uFF1A${entry.result.subScores.map((item) => `${item.label} ${item.score}/${item.maxScore}`).join("\uFF1B") || "\u65E0"}`
      ];
      detail.textContent = lines.join("\n");
      container.appendChild(detail);
    }
    mount() {
      if (!this.host.isConnected) document.body.appendChild(this.host);
    }
    show(entries) {
      this.entries = entries;
      this.mount();
      this.q(".zygr-overlay").hidden = false;
      this.render();
    }
    hide() {
      this.q(".zygr-overlay").hidden = true;
    }
    refresh(entries) {
      this.entries = entries;
      if (!this.q(".zygr-overlay").hidden) this.render();
    }
  };

  // src/ui/settings.ts
  function getPath(source, path) {
    return path.split(".").reduce((value, key) => {
      if (value && typeof value === "object" && key in value) {
        return value[key];
      }
      return void 0;
    }, source);
  }
  function setPath(target, path, value) {
    const keys = path.split(".");
    let cursor = target;
    for (let i = 0; i < keys.length - 1; i += 1) {
      const key = keys[i];
      if (!cursor[key] || typeof cursor[key] !== "object") cursor[key] = {};
      cursor = cursor[key];
    }
    cursor[keys[keys.length - 1]] = value;
  }
  var SettingsPanel = class {
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.toastTimer = 0;
      this.config = {};
      this.rubricImages = [];
      this.host = document.createElement("div");
      this.shadow = this.host.attachShadow({ mode: "open" });
      this.shadow.innerHTML = `<style>${STYLES}</style>${this.markup()}`;
      this.bind();
    }
    markup() {
      const field = (label, path, type = "text") => `
      <div class="zygr-field"><label>${label}</label><input data-field="${path}" type="${type}"></div>`;
      const area = (label, path, hint = "") => `
      <div class="zygr-field"><label>${label}</label><textarea data-field="${path}" rows="6"></textarea>${hint ? `<span class="zygr-hint">${hint}</span>` : ""}</div>`;
      const select = (label, path, options) => `
      <div class="zygr-field"><label>${label}</label><select data-field="${path}">
        ${options.map(([value, text]) => `<option value="${value}">${text}</option>`).join("")}
      </select></div>`;
      const platformSelect = (label, path) => `
      <div class="zygr-field"><label>${label}</label><select data-field="${path}" data-platform-select></select></div>`;
      return `<div class="zygr-overlay" hidden><div class="zygr-dialog zygr-wide">
      <div class="zygr-dialog-head"><h2>\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u8BBE\u7F6E</h2><button class="zygr-icon" data-act="close" aria-label="\u5173\u95ED">\xD7</button></div>
      <div class="zygr-dialog-body">
        <div class="zygr-tabs">
          <button class="zygr-tab zygr-active" data-tab="context">\u6279\u6539\u4E0A\u4E0B\u6587</button>
          <button class="zygr-tab" data-tab="api">\u63A5\u53E3\u4E0E\u94FE\u8DEF</button>
          <button class="zygr-tab" data-tab="generator">\u8BC4\u5206\u6807\u51C6\u751F\u6210</button>
          <button class="zygr-tab" data-tab="advanced">\u9AD8\u7EA7</button>
        </div>

        <div class="zygr-section" data-page="context">
          <h3>\u9898\u76EE\u4E0E\u8BC4\u5377\u4F9D\u636E</h3>
          <p class="zygr-hint">\u9898\u53F7\u3001\u6EE1\u5206\u4E0E\u5C0F\u9898\u7531\u667A\u5B66\u7F51\u9605\u5377\u9875\u8BFB\u53D6\uFF1B\u8FD9\u91CC\u586B\u5199\u7684\u53C2\u8003\u7B54\u6848\u4E0E\u8BC4\u5206\u6807\u51C6\u4F1A\u968F\u6BCF\u6B21\u6279\u6539\u53D1\u9001\u7ED9\u6A21\u578B\u3002\u9898\u76EE\u5185\u5BB9\u53EF\u7559\u7A7A\uFF0C\u7559\u7A7A\u65F6\u4F7F\u7528\u9875\u9762\u9898\u53F7\u3002</p>
          ${area("\u9898\u76EE\u5185\u5BB9\uFF08\u53EF\u9009\uFF09", "context.question")}
          ${area("\u53C2\u8003\u7B54\u6848", "context.answer", "\u5FC5\u586B")}
          ${area("\u8BC4\u5206\u6807\u51C6", "context.rubric", "\u5FC5\u586B")}
          <div class="zygr-grid">${field("\u672C\u65B9\u6848\u6EE1\u5206", "context.maxScore", "number")}</div>
        </div>

        <div class="zygr-section" data-page="api" hidden>
          <h3>\u5E73\u53F0\u9884\u8BBE</h3>
          <p class="zygr-hint">\u9009\u62E9\u5E73\u53F0\u4F1A\u81EA\u52A8\u586B\u5165\u63A5\u53E3\u5730\u5740\uFF0C\u5E76\u6062\u590D\u8BE5\u5E73\u53F0\u4E0A\u6B21\u4F7F\u7528\u7684 API Key \u4E0E\u6A21\u578B\uFF08\u65B0\u5E73\u53F0\u5219\u7528\u63A8\u8350\u6A21\u578B\uFF09\u3002\u4FEE\u6539\u540E\u70B9\u300C\u4FDD\u5B58\u914D\u7F6E\u300D\u5373\u8BB0\u4F4F\u3002\u5185\u7F6E\u9884\u8BBE\u53EA\u8BFB\uFF1B\u81EA\u5B9A\u4E49\u9884\u8BBE\u53EF\u4FDD\u5B58\u3001\u4FEE\u6539\u4E0E\u5220\u9664\u3002</p>
          <div class="zygr-row"><button class="zygr-btn" data-act="preset-toggle">\u7BA1\u7406\u81EA\u5B9A\u4E49\u9884\u8BBE</button></div>
          <div data-preset-editor hidden>
            <div class="zygr-grid">
              <div class="zygr-field"><label>\u9884\u8BBE ID</label><input data-preset-field="id" placeholder="\u5982 my-proxy"></div>
              <div class="zygr-field"><label>\u663E\u793A\u540D\u79F0</label><input data-preset-field="label" placeholder="\u5982 \u6211\u7684\u4E2D\u8F6C"></div>
              <div class="zygr-field"><label>\u63A5\u53E3\u5730\u5740</label><input data-preset-field="endpoint"></div>
              <div class="zygr-field"><label>\u63A8\u8350\u6A21\u578B\uFF08\u9017\u53F7\u5206\u9694\uFF09</label><input data-preset-field="models"></div>
              <div class="zygr-field"><label>\u9274\u6743\u65B9\u5F0F</label><select data-preset-field="authHeader"><option value="bearer">Authorization: Bearer</option><option value="api-key">api-key</option><option value="none">\u65E0\u9700\u9274\u6743</option></select></div>
              <div class="zygr-field"><label>\u601D\u8003\u63A7\u5236\u5B57\u6BB5\u540D</label><input data-preset-field="disableThinkingKey" placeholder="\u7559\u7A7A\u8868\u793A\u4E0D\u6CE8\u5165\uFF0C\u5982 enable_thinking"></div>
              <div class="zygr-field"><label>\u601D\u8003\u591A\u5B57\u6BB5\u6620\u5C04\uFF08JSON\uFF0C\u53EF\u9009\uFF09</label><input data-preset-field="thinkingFields" placeholder='\u5982 {"low":{"thinking":{"type":"enabled"},"reasoning_effort":"low"}}'></div>
              <div class="zygr-field"><label>\u6D41\u5F0F\u8F93\u51FA</label><select data-preset-field="stream"><option value="false">\u5173\u95ED\uFF08\u63A8\u8350\uFF09</option><option value="true">\u5F00\u542F</option></select></div>
            </div>
            <div class="zygr-row">
              <select data-preset-field="existing" aria-label="\u9009\u62E9\u81EA\u5B9A\u4E49\u9884\u8BBE"></select>
              <button class="zygr-btn zygr-primary" data-act="preset-save">\u4FDD\u5B58\u9884\u8BBE</button>
              <button class="zygr-btn" data-act="preset-delete">\u5220\u9664\u6240\u9009</button>
              <button class="zygr-btn zygr-ghost" data-act="preset-new">\u6E05\u7A7A\u8868\u5355</button>
            </div>
          </div>

          <h3>\u591A\u6A21\u6001\u76F4\u8BC4</h3>
          <p class="zygr-hint">\u8BC4\u5206\u53EA\u4F7F\u7528\u591A\u6A21\u6001\u89C6\u89C9\u6A21\u578B\uFF1A\u76F4\u63A5\u8BFB\u53D6\u4F5C\u7B54\u56FE\u7247\u5E76\u6309\u8BC4\u5206\u6807\u51C6\u8F93\u51FA JSON\u3002\u6A21\u578B\u5FC5\u987B\u652F\u6301\u56FE\u7247\u8F93\u516E\u3002</p>
          ${select("\u601D\u8003\u6A21\u5F0F", "pipeline.thinkingMode", [["off", "\u5173\u95ED\u601D\u8003\uFF08\u7701 Token\u3001\u66F4\u5FEB\uFF09"], ["low", "low \u4F4E\u5F3A\u5EA6"], ["high", "high \u9AD8\u5F3A\u5EA6"], ["max", "max \u6700\u9AD8\u5F3A\u5EA6"], ["auto", "\u4E0D\u5E72\u9884\uFF08\u4F7F\u7528\u6A21\u578B\u9ED8\u8BA4\uFF09"]])}
          <div class="zygr-row"><button class="zygr-btn zygr-ghost" data-act="test-thinking">\u6D4B\u8BD5\u5F53\u524D\u601D\u8003\u6A21\u5F0F\u662F\u5426\u751F\u6548</button><span class="zygr-test-status" data-status="thinking"></span></div>
          <p class="zygr-hint">\u5173\u95ED\u9002\u7528\u4E8E\u9ED8\u8BA4\u5F00\u601D\u8003\u4E14\u5141\u8BB8\u5173\u95ED\u7684\u6A21\u578B\u3002\u667A\u8C31 glm-5 \u7B49\u300C\u59CB\u7EC8\u601D\u8003\u300D\u6A21\u578B\u4E0D\u652F\u6301\u5173\u95ED\uFF0C\u8BF7\u9009 low / high / max\u3002\u7845\u57FA\u6D41\u52A8 enable_thinking \u53EA\u63A5\u53D7\u5E03\u5C14\u503C\uFF0C\u5F3A\u5EA6\u7528 reasoning_effort\uFF08low/high \u670D\u52A1\u7AEF\u6620\u5C04\u4E3A high\uFF0Cmax \u539F\u6837\u53D1\u9001\uFF09\u3002\u9009\u300C\u4E0D\u5E72\u9884\u300D\u5219\u4E0D\u53D1\u9001\u4EFB\u4F55\u601D\u8003\u53C2\u6570\uFF0C\u90E8\u5206\u6A21\u578B\u9ED8\u8BA4\u5F00\u601D\u8003\u4F1A\u4EA7\u751F\u957F\u94FE\u601D\u8003\u800C\u8D85\u65F6\uFF0C\u53EF\u5728\u300C\u9AD8\u7EA7\u300D\u8C03\u5927\u8BF7\u6C42\u8D85\u65F6\u6216\u6362\u7528\u66F4\u5C0F\u6A21\u578B\u3002\u70B9\u51FB\u6D4B\u8BD5\u4F1A\u53D1\u9001\u4E00\u4E2A\u9700\u8981\u63A8\u7406\u7684\u95EE\u9898\u9A8C\u8BC1\u3002</p>

          ${platformSelect("\u5E73\u53F0\u9884\u8BBE", "pipeline.vlm.platform")}
          <h3>\u591A\u6A21\u6001\u670D\u52A1</h3>
          <div class="zygr-grid">
            ${field("\u63A5\u53E3\u5730\u5740", "pipeline.vlm.endpoint")}${field("API Key", "pipeline.vlm.apiKey", "password")}
            ${field("\u6A21\u578B", "pipeline.vlm.model")}
          </div>
          <p class="zygr-hint">\u63A5\u53E3\u5730\u5740\u4E3A OpenAI \u517C\u5BB9 Chat Completions \u5730\u5740\uFF08\u5982 https://api.siliconflow.cn/v1/chat/completions\uFF09\u3002\u6A21\u578B\u5FC5\u987B\u662F\u652F\u6301\u56FE\u7247\u8F93\u5165\u7684\u89C6\u89C9\u6A21\u578B\u3002Cloudflare Workers AI \u9700\u628A\u63A5\u53E3\u5730\u5740\u4E2D\u7684 {account_id} \u66FF\u6362\u4E3A\u81EA\u5DF1\u7684 Cloudflare \u8D26\u6237 ID\uFF0CAPI Key \u586B\u5177\u5907 Workers AI \u6743\u9650\u7684 API Token\u3002\u8BE5\u5E73\u53F0\u65E0 /models \u7AEF\u70B9\uFF0C\u83B7\u53D6\u6A21\u578B\u4F1A\u5217\u51FA\u9884\u8BBE\u63A8\u8350\u503C\uFF1B\u601D\u8003\u5F3A\u5EA6\u4EC5\u5BF9 gpt-oss \u63A8\u7406\u6A21\u578B\u751F\u6548\uFF08reasoning_effort\uFF09\uFF0C\u5176\u4ED6\u6A21\u578B\u8BF7\u9009\u300C\u4E0D\u5E72\u9884\u300D\u3002</p>
          <div class="zygr-row"><button class="zygr-btn" data-act="fetch-models">\u83B7\u53D6\u6A21\u578B\u5217\u8868</button><span class="zygr-test-status" data-status="models"></span></div>
          <div data-model-options hidden><select data-field-model-picker aria-label="\u9009\u62E9\u6A21\u578B"></select><button class="zygr-btn" data-act="apply-model">\u4F7F\u7528\u6240\u9009\u6A21\u578B</button></div>
          <div class="zygr-row"><button class="zygr-btn" data-test="vlm">\u6D4B\u8BD5\u591A\u6A21\u6001</button><span class="zygr-test-status" data-status="vlm"></span></div>
        </div>

        <div class="zygr-section" data-page="generator" hidden>
          <h3>\u8BC4\u5206\u6807\u51C6\u751F\u6210\u5668</h3>
          <p class="zygr-hint">\u9009\u5B66\u79D1\u4E0E\u9898\u578B\uFF0C\u586B\u5199\u9898\u76EE\u4E0E\u5B66\u6821\u6807\u51C6\u7B54\u6848\uFF08\u6587\u5B57\u6216\u56FE\u7247\u4EFB\u9009\uFF09\uFF0C\u8BA9 AI \u751F\u6210\u7ED3\u6784\u5316\u8BC4\u5206\u6807\u51C6\u3002\u751F\u6210\u540E\u53EF\u76F4\u63A5\u7F16\u8F91\uFF0C\u786E\u8BA4\u65E0\u8BEF\u540E\u4E00\u952E\u586B\u5165\u300C\u6279\u6539\u4E0A\u4E0B\u6587 \xB7 \u8BC4\u5206\u6807\u51C6\u300D\u3002\u4F7F\u7528\u4E0E\u6279\u6539\u76F8\u540C\u7684\u591A\u6A21\u6001\u670D\u52A1\uFF0C\u4F1A\u6D88\u8D39\u4E00\u6B21\u771F\u5B9E\u8BF7\u6C42\u3002</p>
          <div class="zygr-grid">
            <div class="zygr-field"><label>\u5B66\u79D1</label><select data-gen="subject">${Object.keys(RUBRIC_SUBJECTS).map((name) => `<option value="${name}">${name}</option>`).join("")}</select></div>
            <div class="zygr-field"><label>\u9898\u578B</label><select data-gen="type"></select></div>
            <div class="zygr-field"><label>\u6EE1\u5206\uFF08\u53EF\u9009\uFF09</label><input type="number" data-gen="maxScore" min="0" step="0.5" placeholder="\u7559\u7A7A\u5219\u7531 AI \u5EFA\u8BAE"></div>
          </div>
          <div class="zygr-field" data-gen-field><label>\u9898\u76EE\uFF08\u4F5C\u6587\u7C7B\u5FC5\u586B\uFF0C\u5176\u4ED6\u53EF\u9009\uFF09</label><textarea data-gen="question" rows="3" placeholder="\u53EF\u7C98\u8D34\u9898\u76EE\u6587\u5B57\uFF0C\u6216\u7559\u7A7A\u4EC5\u7528\u56FE\u7247"></textarea></div>
          <div class="zygr-field" data-gen-field><label>\u5B66\u6821\u6807\u51C6\u7B54\u6848\uFF08\u6587\u5B57\uFF09</label><textarea data-gen="answer" rows="4" placeholder="\u53EF\u7C98\u8D34\u6807\u51C6\u7B54\u6848\u6587\u5B57\uFF0C\u5316\u5B66\u5F0F\u3001\u516C\u5F0F\u7B26\u53F7\u53EF\u76F4\u63A5\u7C98\u8D34"></textarea></div>
          <div class="zygr-field" data-gen-field><label>\u6807\u51C6\u7B54\u6848\u56FE\u7247\uFF08\u53EF\u591A\u9009\uFF09</label><input type="file" data-gen="images" accept="image/*" multiple><div data-gen-thumbs class="zygr-row"></div></div>
          <div class="zygr-row"><button class="zygr-btn zygr-primary" data-act="gen-run">\u751F\u6210\u8BC4\u5206\u6807\u51C6</button><span class="zygr-test-status" data-status="gen"></span></div>
          <div class="zygr-field" data-gen-field><label>\u751F\u6210\u7ED3\u679C\uFF08\u53EF\u76F4\u63A5\u7F16\u8F91\uFF09</label><textarea data-gen="result" rows="14" placeholder="\u751F\u6210\u540E\u5728\u6B64\u4FEE\u6539\uFF0C\u786E\u8BA4\u65E0\u8BEF\u540E\u70B9\u300C\u4E00\u952E\u586B\u5165\u300D"></textarea></div>
          <div class="zygr-row"><button class="zygr-btn" data-act="gen-apply">\u4E00\u952E\u586B\u5165\u9898\u76EE\u3001\u53C2\u8003\u7B54\u6848\u3001\u8BC4\u5206\u6807\u51C6</button><button class="zygr-btn zygr-ghost" data-act="gen-copy">\u590D\u5236\u7ED3\u679C</button><button class="zygr-btn zygr-ghost" data-act="gen-clear">\u6E05\u7A7A</button></div>
        </div>

        <div class="zygr-section" data-page="advanced" hidden>
          <h3>\u56FE\u7247\u4E0E\u63D0\u793A\u8BCD</h3>
          <div class="zygr-grid">
            ${select("\u7701 Token \u6863\u4F4D", "image.profile", [["clarity", "\u6E05\u6670\u4F18\u5148"], ["balanced", "\u5747\u8861"], ["saving", "\u7701 Token"]])}
            ${field("\u56FE\u7247\u957F\u8FB9\u4E0A\u9650\uFF08px\uFF09", "image.maxEdge", "number")}
            ${field("JPEG \u8D28\u91CF\uFF080.5-1\uFF09", "image.quality", "number")}
            ${field("\u5386\u53F2\u4FDD\u7559\u6761\u6570", "historyLimit", "number")}
            ${field("\u7F13\u5B58\u6709\u6548\u671F\uFF08\u5929\uFF09", "cacheTtlDays", "number")}
          </div>
          <label class="zygr-row"><input type="checkbox" data-field="image.cropToAnswer"> \u81EA\u52A8\u88C1\u5207\u767D\u8FB9\uFF08\u9ED8\u8BA4\u5173\u95ED\uFF0C\u4FDD\u6301\u7B54\u5377\u539F\u8C8C\uFF09</label>
          <h3>\u9650\u901F\u4E0E\u8D85\u65F6</h3>
          <div class="zygr-grid">
            ${field("\u5E76\u53D1\u4E0A\u9650", "pipeline.maxConcurrent", "number")}
            ${field("RPM \u9884\u7B97", "pipeline.maxRpm", "number")}
            ${field("TPM \u9884\u7B97", "pipeline.maxTpm", "number")}
            ${field("\u8BF7\u6C42\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09", "pipeline.timeoutMs", "number")}
          </div>
          <p class="zygr-hint">\u6240\u6709\u914D\u7F6E\u4EC5\u4FDD\u5B58\u5728\u5F53\u524D\u6CB9\u7334\u73AF\u5883\u4E2D\uFF0C\u4E0D\u4F1A\u8BFB\u53D6\u65E7\u63D2\u4EF6\u914D\u7F6E\uFF1B\u6E05\u7A7A\u6570\u636E\u540E\u9700\u91CD\u65B0\u586B\u5199\u3002</p>
        </div>
      </div>
      <div class="zygr-dialog-foot">
        <button class="zygr-btn zygr-ghost" data-act="export">\u5BFC\u51FA\u914D\u7F6E</button>
        <button class="zygr-btn zygr-ghost" data-act="import">\u5BFC\u5165\u914D\u7F6E</button>
        <button class="zygr-btn zygr-ghost" data-act="reset">\u91CD\u7F6E\u9ED8\u8BA4</button>
        <button class="zygr-btn zygr-ghost" data-act="clear">\u6E05\u7A7A\u6570\u636E</button>
        <button class="zygr-btn" data-act="cancel">\u5173\u95ED</button>
        <button class="zygr-btn zygr-primary" data-act="save">\u4FDD\u5B58\u914D\u7F6E</button>
      </div>
      <input type="file" data-config-file accept="application/json,.json" hidden>
      <div class="zygr-toast" data-toast hidden></div>
    </div></div>`;
    }
    q(selector) {
      const element = this.shadow.querySelector(selector);
      if (!element) throw new Error(`\u8BBE\u7F6E\u754C\u9762\u5143\u7D20\u7F3A\u5931\uFF1A${selector}`);
      return element;
    }
    bind() {
      this.shadow.addEventListener("click", (event) => {
        const target = event.target;
        const tab = target.closest("[data-tab]");
        if (tab) {
          this.shadow.querySelectorAll("[data-tab]").forEach((item) => item.classList.toggle("zygr-active", item === tab));
          this.shadow.querySelectorAll("[data-page]").forEach((page) => {
            page.hidden = page.getAttribute("data-page") !== tab.dataset.tab;
          });
          return;
        }
        const preset = target.closest("[data-preset]");
        if (preset) {
          const setField = (path, value) => {
            const element = this.shadow.querySelector(`[data-field="${path}"]`);
            if (element) element.value = value;
          };
          return;
        }
        const test = target.closest("[data-test]");
        if (test) {
          void this.test(test.dataset.test);
          return;
        }
        const action = target.closest("[data-act]")?.dataset.act;
        if (action === "gen-run") {
          void this.generateRubric();
          return;
        }
        if (action === "gen-apply") {
          const result = this.shadow.querySelector('[data-gen="result"]')?.value || "";
          if (!result.trim()) return this.toast("\u8BF7\u5148\u751F\u6210\u8BC4\u5206\u6807\u51C6");
          const genValue = (key) => String(this.shadow.querySelector(`[data-gen="${key}"]`)?.value ?? "").trim();
          const question = genValue("question");
          const answer = genValue("answer");
          const maxScore = Number(genValue("maxScore")) || 0;
          if (question) {
            const field = this.shadow.querySelector('[data-field="context.question"]');
            if (field) field.value = question;
          }
          if (answer) {
            const field = this.shadow.querySelector('[data-field="context.answer"]');
            if (field) field.value = answer;
          }
          if (maxScore > 0) {
            const field = this.shadow.querySelector('[data-field="context.maxScore"]');
            if (field) field.value = String(maxScore);
          }
          const rubricField = this.shadow.querySelector('[data-field="context.rubric"]');
          if (rubricField) rubricField.value = result;
          const contextTab = this.shadow.querySelector('[data-tab="context"]');
          if (contextTab) contextTab.click();
          this.toast("\u5DF2\u586B\u5165\u8BC4\u5206\u6807\u51C6\u3001\u9898\u76EE\u3001\u53C2\u8003\u7B54\u6848\u4E0E\u6EE1\u5206\uFF0C\u8BF7\u70B9\u300C\u4FDD\u5B58\u914D\u7F6E\u300D\u751F\u6548");
          return;
        }
        if (action === "gen-copy") {
          const result = this.shadow.querySelector('[data-gen="result"]')?.value || "";
          if (!result.trim()) return this.toast("\u8BF7\u5148\u751F\u6210\u8BC4\u5206\u6807\u51C6");
          void navigator.clipboard?.writeText(result).then(
            () => this.toast("\u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F"),
            () => this.toast("\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u9009\u4E2D\u6587\u672C\u590D\u5236")
          );
          return;
        }
        if (action === "gen-clear") {
          this.shadow.querySelectorAll('[data-gen="question"], [data-gen="answer"], [data-gen="result"]').forEach((element) => { element.value = ""; });
          const maxScoreField = this.shadow.querySelector('[data-gen="maxScore"]');
          if (maxScoreField) maxScoreField.value = "";
          this.rubricImages = [];
          const thumbs = this.shadow.querySelector("[data-gen-thumbs]");
          if (thumbs) thumbs.innerHTML = "";
          return;
        }
        if (action === "fetch-models") {
          void this.fetchModels();
          return;
        }
        if (action === "test-thinking") {
          void this.testThinking();
          return;
        }
        if (action === "apply-model") {
          const picker = this.shadow.querySelector("[data-field-model-picker]");
          if (picker?.value) {
            const modelField = this.shadow.querySelector('[data-field="pipeline.vlm.model"]');
            if (modelField) modelField.value = picker.value;
            this.toast("\u6A21\u578B\u5DF2\u586B\u5165\uFF0C\u8BF7\u70B9\u300C\u4FDD\u5B58\u914D\u7F6E\u300D\u751F\u6548");
          }
          return;
        }
        if (action === "export") {
          this.exportConfig();
          return;
        }
        if (action === "import") {
          this.q("[data-config-file]").click();
          return;
        }
        if (action === "preset-toggle") {
          const editor = this.shadow.querySelector("[data-preset-editor]");
          if (editor) {
            editor.hidden = !editor.hidden;
            if (!editor.hidden) this.refreshPlatformSelects();
          }
          return;
        }
        if (action === "preset-new") {
          this.loadPresetIntoForm(null);
          return;
        }
        if (action === "preset-save") {
          const presetData = this.collectPresetForm();
          if (!presetData.id) return this.toast("\u8BF7\u586B\u5199\u9884\u8BBE ID");
          if (isBuiltinPreset(presetData.id)) return this.toast("\u5185\u7F6E\u9884\u8BBE\u4E0D\u53EF\u8986\u76D6\uFF0C\u8BF7\u66F4\u6362 ID");
          if (upsertPlatformPreset(presetData)) {
            this.refreshPlatformSelects();
            this.toast(`\u9884\u8BBE\u300C${presetData.label}\u300D\u5DF2\u4FDD\u5B58`);
          } else this.toast("\u9884\u8BBE\u4FDD\u5B58\u5931\u8D25");
          return;
        }
        if (action === "preset-delete") {
          const selected = this.shadow.querySelector('[data-preset-field="existing"]')?.value;
          if (!selected) return this.toast("\u8BF7\u5148\u9009\u62E9\u81EA\u5B9A\u4E49\u9884\u8BBE");
          if (deletePlatformPreset(selected)) {
            this.refreshPlatformSelects();
            this.loadPresetIntoForm(null);
            this.toast("\u9884\u8BBE\u5DF2\u5220\u9664");
          }
          return;
        }
        if (action === "close" || action === "cancel") this.hide();
        else if (action === "save") {
          this.callbacks.onSave(this.getDraft());
          this.toast("\u914D\u7F6E\u5DF2\u4FDD\u5B58");
        } else if (action === "reset") {
          this.callbacks.onReset();
          this.toast("\u5DF2\u6062\u590D\u9ED8\u8BA4\u503C\uFF0C\u8BF7\u91CD\u65B0\u586B\u5199\u63A5\u53E3\u4FE1\u606F");
        } else if (action === "clear") {
          this.callbacks.onClear();
          this.toast("\u5DF2\u6E05\u7A7A\u5168\u90E8\u6570\u636E");
        }
      });
      this.shadow.addEventListener("change", (event) => {
        const target = event.target;
        if (target.dataset.gen === "subject") this.populateRubricTypes();
        if (target.dataset.gen === "images") {
          void this.loadRubricImages(target.files);
          target.value = "";
        }
        if (target.hasAttribute("data-platform-select")) this.applyPlatform(target.dataset.field || "", target.value);
        if (target.dataset.presetField === "existing") this.loadPresetIntoForm(target.value);
        if (target.hasAttribute("data-config-file") && target.files?.[0]) {
          void this.importConfig(target.files[0]);
          target.value = "";
        }
      });
    }
    refreshPlatformSelects() {
      const presets = listPlatformPresets();
      const options = presets.map((preset) => `<option value="${preset.id}">${preset.label}</option>`).join("");
      this.shadow.querySelectorAll("[data-platform-select]").forEach((element) => {
        const current = getPath(this.config, element.dataset.field || "") || element.value;
        element.innerHTML = options;
        element.value = presets.some((preset) => preset.id === current) ? current : "custom";
      });
      const existing = this.shadow.querySelector('[data-preset-field="existing"]');
      if (existing) {
        const customs = loadCustomPresets();
        existing.innerHTML = customs.length
          ? customs.map((preset) => `<option value="${preset.id}">${preset.label}</option>`).join("")
          : '<option value="">\uFF08\u6682\u65E0\u81EA\u5B9A\u4E49\u9884\u8BBE\uFF09</option>';
      }
    }
    applyPlatform(path, id) {
      const preset = getPlatformPreset(id);
      if (!preset || !path.endsWith(".platform")) return;
      const base = path.slice(0, -".platform".length);
      const getField = (fieldPath) => this.shadow.querySelector(`[data-field="${fieldPath}"]`);
      const setField = (fieldPath, value) => {
        const element = getField(fieldPath);
        if (element) element.value = value;
      };
      const keyElement = getField(`${base}.apiKey`);
      const modelElement = getField(`${base}.model`);
      const thinkingElement = getField("pipeline.thinkingMode");
      const oldPlatform = keyElement?.dataset.platformBound || getPath(this.config, path) || "custom";
      if (keyElement?.value?.trim()) setPlatformKey(oldPlatform, keyElement.value.trim());
      if (modelElement?.value?.trim()) setPlatformModel(oldPlatform, modelElement.value.trim());
      if (thinkingElement?.value) setPlatformThinkingMode(oldPlatform, thinkingElement.value);
      const rememberedKey = getPlatformKey(id);
      const rememberedModel = getPlatformModel(id);
      const rememberedThinking = getPlatformThinkingMode(id);
      if (keyElement) {
        keyElement.value = rememberedKey;
        keyElement.dataset.platformBound = id;
      }
      if (modelElement) {
        modelElement.value = rememberedModel || (preset.models && preset.models.length ? preset.models[0] : "");
        modelElement.dataset.platformBound = id;
      }
      if (thinkingElement && rememberedThinking) thinkingElement.value = rememberedThinking;
      if (preset.endpoint) setField(`${base}.endpoint`, preset.endpoint);
      this.toast(`\u5DF2\u5207\u6362\u5230\u300C${preset.label}\u300D\uFF0C\u5DF2\u6062\u590D\u8BE5\u5E73\u53F0\u8BB0\u5F55\u7684 API Key\u3001\u6A21\u578B\u4E0E\u601D\u8003\u6A21\u5F0F`);
    }
    loadPresetIntoForm(id) {
      const preset = id ? getPlatformPreset(id) : null;
      const value = (key, fallback = "") => String(preset?.[key] ?? fallback);
      const set = (key, val) => {
        const element = this.shadow.querySelector(`[data-preset-field="${key}"]`);
        if (element) element.value = val;
      };
      set("id", value("id"));
      set("label", value("label"));
      set("endpoint", value("endpoint"));
      set("models", Array.isArray(preset?.models) ? preset.models.join(", ") : "");
      set("authHeader", value("authHeader", "bearer"));
      set("disableThinkingKey", preset?.disableThinkingKey || "");
      set("thinkingFields", preset?.thinkingFields && Object.keys(preset.thinkingFields).length ? JSON.stringify(preset.thinkingFields) : "");
      set("stream", String(Boolean(preset?.stream)));
    }
    collectPresetForm() {
      const value = (key) => String(this.shadow.querySelector(`[data-preset-field="${key}"]`)?.value ?? "").trim();
      let thinkingFields = {};
      try {
        const parsed = JSON.parse(value("thinkingFields") || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) thinkingFields = parsed;
      } catch { /* 无效 JSON 时忽略映射 */ }
      return {
        id: value("id"),
        label: value("label") || value("id"),
        endpoint: value("endpoint"),
        models: value("models").split(/[,，]/).map((item) => item.trim()).filter(Boolean),
        authHeader: ["bearer", "api-key", "none"].includes(value("authHeader")) ? value("authHeader") : "bearer",
        disableThinkingKey: value("disableThinkingKey"),
        thinkingValues: {},
        thinkingFields,
        jsonModeKey: "response_format",
        stream: value("stream") === "true"
      };
    }
    exportConfig() {
      const data = {
        app: "zygr",
        version: 1,
        exportedAt: new Date().toISOString(),
        config: this.getDraft(),
        presets: loadCustomPresets(),
        keys: loadPlatformKeys(),
        models: loadPlatformModels(),
        thinkingModes: loadPlatformThinkingModes()
      };
      const now = new Date();
      const pad = (value) => String(value).padStart(2, "0");
      const filename = `\u667A\u9605\u6279\u6539\u52A9\u624B-\u914D\u7F6E-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
      downloadText(filename, JSON.stringify(data, null, 2), "application/json;charset=utf-8");
      this.toast("\u914D\u7F6E\u5DF2\u5BFC\u51FA\uFF08\u542B API Key\uFF0C\u8BF7\u59A5\u5584\u4FDD\u7BA1\uFF09");
    }
    async importConfig(file) {
      try {
        const text = await file.text();
        const data = parseConfigBackup(text);
        if (!data) throw new Error("\u914D\u7F6E\u6587\u4EF6\u683C\u5F0F\u4E0D\u6B63\u786E");
        this.callbacks.onImport(data);
        this.show(loadConfig());
        this.toast("\u914D\u7F6E\u5DF2\u5BFC\u5165");
      } catch (error) {
        this.toast(`\u5BFC\u5165\u5931\u8D25\uFF1A${error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF"}`);
      }
    }
    async fetchModels() {
      const draft = this.getDraft();
      const status = this.shadow.querySelector('[data-status="models"]');
      const pickerWrap = this.shadow.querySelector("[data-model-options]");
      const picker = this.shadow.querySelector("[data-field-model-picker]");
      const setStatus = (text, state = "") => {
        if (!status) return;
        status.textContent = text;
        status.className = `zygr-test-status${state ? ` zygr-${state}` : ""}`;
      };
      setStatus("\u83B7\u53D6\u4E2D\u2026");
      try {
        const models = await this.callbacks.onFetchModels(draft);
        if (picker) {
          picker.innerHTML = models.map((id) => `<option value="${String(id).replace(/"/g, "&quot;")}">${String(id).replace(/</g, "&lt;")}</option>`).join("");
        }
        if (pickerWrap) pickerWrap.hidden = false;
        const label = models.fallback
          ? `\u8BE5\u5E73\u53F0\u4E0D\u652F\u6301\u5728\u7EBF\u62C9\u53D6\uFF0C\u5DF2\u5217\u51FA\u9884\u8BBE\u63A8\u8350\u7684 ${models.length} \u4E2A\u6A21\u578B`
          : `\u83B7\u53D6\u5230 ${models.length} \u4E2A\u6A21\u578B`;
        setStatus(label, "ok");
        this.toast(`${label}\uFF0C\u8BF7\u9009\u62E9`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "\u83B7\u53D6\u5931\u8D25";
        setStatus(message, "bad");
        this.toast(error?.providerMessage ? String(error.providerMessage).slice(0, 120) : message.slice(0, 120));
      }
    }
    populateRubricTypes() {
      const subjectSelect = this.shadow.querySelector('[data-gen="subject"]');
      const typeSelect = this.shadow.querySelector('[data-gen="type"]');
      if (!subjectSelect || !typeSelect) return;
      const types = RUBRIC_SUBJECTS[subjectSelect.value] || [];
      typeSelect.innerHTML = types.map((type) => `<option value="${type}">${type}</option>`).join("");
    }
    async loadRubricImages(files) {
      if (!files || !files.length) return;
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => reject(new Error("read failed"));
            reader.readAsDataURL(file);
          });
          if (dataUrl) this.rubricImages.push(dataUrl);
        } catch { /* \u8BFB\u53D6\u5931\u8D25\u7684\u56FE\u7247\u8DF3\u8FC7 */ }
      }
      const thumbs = this.shadow.querySelector("[data-gen-thumbs]");
      if (thumbs) thumbs.textContent = `\u5DF2\u9009 ${this.rubricImages.length} \u5F20\u56FE\u7247`;
    }
    async generateRubric() {
      const draft = this.getDraft();
      const status = this.shadow.querySelector('[data-status="gen"]');
      const button = this.shadow.querySelector('[data-act="gen-run"]');
      const setStatus = (text, state = "") => {
        if (!status) return;
        status.textContent = text;
        status.className = `zygr-test-status${state ? ` zygr-${state}` : ""}`;
      };
      const value = (key) => String(this.shadow.querySelector(`[data-gen="${key}"]`)?.value ?? "").trim();
      const payload = {
        subject: value("subject"),
        questionType: value("type"),
        question: value("question"),
        answerText: value("answer"),
        maxScore: Number(value("maxScore")) || 0,
        answerImages: [...this.rubricImages]
      };
      if (!payload.subject || !payload.questionType) return this.toast("\u8BF7\u9009\u62E9\u5B66\u79D1\u4E0E\u9898\u578B");
      if (payload.questionType.indexOf("\u4F5C\u6587") >= 0 && !payload.question && payload.answerImages.length === 0) {
        return this.toast("\u4F5C\u6587\u7C7B\u8BF7\u586B\u5199\u9898\u76EE\u6216\u4E0A\u4F20\u56FE\u7247");
      }
      setStatus("\u751F\u6210\u4E2D\u2026");
      if (button) button.disabled = true;
      try {
        const result = await this.callbacks.onGenerateRubric(draft, payload);
        const resultField = this.shadow.querySelector('[data-gen="result"]');
        if (resultField) resultField.value = result;
        setStatus("\u751F\u6210\u5B8C\u6210", "ok");
        this.toast("\u751F\u6210\u5B8C\u6210\uFF0C\u8BF7\u68C0\u67E5\u5E76\u5FAE\u8C03");
      } catch (error) {
        const message = error instanceof Error ? error.message : "\u751F\u6210\u5931\u8D25";
        const detail = error?.configSummary ? ` | ${error.configSummary}` : "";
        setStatus(message + detail, "bad");
        this.toast(error?.providerMessage ? String(error.providerMessage).slice(0, 120) : message.slice(0, 120));
      } finally {
        if (button) button.disabled = false;
      }
    }
    async testThinking() {
      const draft = this.getDraft();
      const status = this.shadow.querySelector('[data-status="thinking"]');
      const button = this.shadow.querySelector('[data-act="test-thinking"]');
      const setStatus = (text, state = "") => {
        if (!status) return;
        status.textContent = text;
        status.className = `zygr-test-status${state ? ` zygr-${state}` : ""}`;
      };
      setStatus("\u6D4B\u8BD5\u4E2D\u2026");
      if (button) button.disabled = true;
      try {
        const result = await this.callbacks.onTestThinking(draft);
        setStatus(`${result.verdict}${result.detail ? ` | ${result.detail}` : ""}`, result.ok ? "ok" : "bad");
        this.toast(result.verdict);
      } catch (error) {
        const message = error instanceof Error ? error.message : "\u6D4B\u8BD5\u5931\u8D25";
        const detail = error?.configSummary ? ` | ${error.configSummary}` : "";
        setStatus(message + detail, "bad");
        this.toast(error?.providerMessage ? String(error.providerMessage).slice(0, 120) : message.slice(0, 120));
      } finally {
        if (button) button.disabled = false;
      }
    }
    async test(kind) {
      const draft = this.getDraft();
      const status = this.shadow.querySelector(`[data-status="${kind}"]`);
      const button = this.shadow.querySelector(`[data-test="${kind}"]`);
      const setStatus = (text, state = "") => {
        if (!status) return;
        status.textContent = text;
        status.className = `zygr-test-status${state ? ` zygr-${state}` : ""}`;
      };
      setStatus("\u6D4B\u8BD5\u4E2D\u2026");
      if (button) button.disabled = true;
      this.toast("\u6B63\u5728\u6D4B\u8BD5\u8FDE\u63A5\u2026");
      try {
        const ok = await this.callbacks.onTest(draft);
        const message = ok ? "\u8FDE\u63A5\u6B63\u5E38" : "\u8FDE\u63A5\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u914D\u7F6E";
        setStatus(message, ok ? "ok" : "bad");
        this.toast(message);
      } catch (error) {
        const message = error instanceof Error ? error.message : "\u8FDE\u63A5\u5931\u8D25";
        const providerMessage = error?.providerMessage ? String(error.providerMessage) : "";
        const detail = error?.configSummary ? ` | 实际配置: ${error.configSummary}` : "";
        setStatus(message + detail, "bad");
        this.toast(providerMessage ? providerMessage.slice(0, 120) : message.slice(0, 120));
      } finally {
        if (button) button.disabled = false;
      }
    }
    getDraft() {
      const draft = JSON.parse(JSON.stringify(this.config));
      this.shadow.querySelectorAll("[data-field]").forEach((element) => {
        const path = element.dataset.field;
        if (!path) return;
        const value = element instanceof HTMLInputElement && element.type === "checkbox" ? element.checked : element instanceof HTMLInputElement && element.type === "number" ? Number(element.value) : element.value;
        setPath(draft, path, value);
      });
      return draft;
    }
    toast(message) {
      const element = this.q("[data-toast]");
      element.textContent = message;
      element.hidden = false;
      window.clearTimeout(this.toastTimer);
      this.toastTimer = window.setTimeout(() => {
        element.hidden = true;
      }, 2600);
    }
    mount() {
      if (!this.host.isConnected) document.body.appendChild(this.host);
    }
    show(config) {
      this.config = config;
      this.mount();
      this.shadow.querySelectorAll("[data-field]").forEach((element) => {
        const value = getPath(config, element.dataset.field ?? "");
        if (element instanceof HTMLInputElement && element.type === "checkbox") element.checked = Boolean(value);
        else element.value = value === void 0 || value === null ? "" : String(value);
      });
      const boundPlatform = getPath(config, "pipeline.vlm.platform") || "custom";
      const keyElement = this.shadow.querySelector('[data-field="pipeline.vlm.apiKey"]');
      const modelElement = this.shadow.querySelector('[data-field="pipeline.vlm.model"]');
      if (keyElement) keyElement.dataset.platformBound = boundPlatform;
      if (modelElement) modelElement.dataset.platformBound = boundPlatform;
      this.refreshPlatformSelects();
      this.populateRubricTypes();
      this.q(".zygr-overlay").hidden = false;
    }
    hide() {
      this.q(".zygr-overlay").hidden = true;
    }
  };

  // src/main.ts
  function buildLimiter(config) {
    return new RateLimiter({
      maxConcurrent: config.pipeline.maxConcurrent,
      maxRpm: config.pipeline.maxRpm,
      maxTpm: config.pipeline.maxTpm
    });
  }
  function pipelineLabel(config) {
    return "\u591A\u6A21\u6001\u76F4\u8BC4";
  }
  async function bootstrap() {
    let config = loadConfig();
    let cache = new CacheStore(config.cacheTtlDays);
    let limiter = buildLimiter(config);
    let markingDoc = null;
    let currentQuestion = null;
    let lastResult = null;
    let lastHistoryId = "";
    let busy = false;
    let autoMode = false;
    let autoStopRequested = false;
    let observer = null;
    let observerTimer = 0;
    const panel = new GraderPanel({
      onGrade: () => {
        void runGrade2();
      },
      onContinuous: () => {
        void toggleContinuous();
      },
      onSubmit: (skipConfirm) => {
        void submitResult({ skipConfirm });
      },
      onHistory: () => historyPanel.show(loadHistory()),
      onSettings: () => settingsPanel.show(config)
    });
    const settingsPanel = new SettingsPanel({
      onSave: (draft) => {
        config = draft;
        saveConfig(config);
        syncKeysFromConfig(config);
        syncModelsFromConfig(config);
        syncThinkingModesFromConfig(config);
        cache = new CacheStore(config.cacheTtlDays);
        limiter = buildLimiter(config);
        panel.setCache(pipelineLabel(config));
        panel.setSubtitle("\u914D\u7F6E\u5DF2\u66F4\u65B0");
      },
      onTest: (draft) => testService(draft),
      onFetchModels: (draft) => fetchModels(draft.pipeline.vlm),
      onGenerateRubric: (draft, payload) => {
        const service = draft.pipeline.vlm;
        service.thinkingMode = normalizeThinkingMode(draft.pipeline.thinkingMode !== void 0 ? draft.pipeline.thinkingMode : draft.pipeline.disableThinking);
        return generateRubric(payload, service, buildLimiter(draft), draft.image);
      },
      onTestThinking: (draft) => {
        draft.pipeline.vlm.thinkingMode = normalizeThinkingMode(draft.pipeline.thinkingMode !== void 0 ? draft.pipeline.thinkingMode : draft.pipeline.disableThinking);
        draft.pipeline.vlm.timeoutMs = draft.pipeline.timeoutMs;
        return probeThinking(draft.pipeline.vlm, buildLimiter(draft));
      },
      onImport: (data) => {
        config = merge(DEFAULT_CONFIG, data.config);
        saveConfig(config);
        if (Array.isArray(data.presets)) saveCustomPresets(data.presets);
        if (isRecord(data.keys)) savePlatformKeys(data.keys);
        if (isRecord(data.models)) savePlatformModels(data.models);
        if (isRecord(data.thinkingModes)) savePlatformThinkingModes(data.thinkingModes);
        syncKeysFromConfig(config);
        syncModelsFromConfig(config);
        syncThinkingModesFromConfig(config);
        cache = new CacheStore(config.cacheTtlDays);
        limiter = buildLimiter(config);
        panel.setCache(pipelineLabel(config));
        panel.setSubtitle("\u914D\u7F6E\u5DF2\u5BFC\u5165");
      },
      onReset: () => {
        resetConfig();
        config = loadConfig();
        cache = new CacheStore(config.cacheTtlDays);
        limiter = buildLimiter(config);
        settingsPanel.show(config);
      },
      onClear: () => {
        clearAllData();
        cache.clear();
        config = loadConfig();
        limiter = buildLimiter(config);
        panel.setCache("\u672A\u914D\u7F6E", "warn");
        panel.setSubtitle("\u6570\u636E\u5DF2\u6E05\u7A7A");
        historyPanel.refresh([]);
        settingsPanel.show(config);
      }
    });
    const historyPanel = new HistoryPanel({
      onExport: (kind) => {
        downloadText(
          exportFilename(kind),
          kind === "csv" ? toCsv(loadHistory()) : toHtml(loadHistory()),
          kind === "csv" ? "text/csv;charset=utf-8" : "text/html;charset=utf-8"
        );
      },
      onClear: () => {
        clearHistory();
        historyPanel.refresh([]);
        panel.toast("\u5386\u53F2\u5DF2\u6E05\u7A7A");
      }
    });
    panel.mount();
    panel.setCache(pipelineLabel(config));
    if (validateConfig(config).length > 0) {
      panel.setSubtitle("\u8BF7\u70B9\u51FB\u300C\u8BBE\u7F6E\u300D\u5B8C\u6210\u914D\u7F6E");
    }
    async function testService(draft) {
      const serviceLimiter = buildLimiter(draft);
      draft.pipeline.vlm.thinkingMode = normalizeThinkingMode(draft.pipeline.thinkingMode !== void 0 ? draft.pipeline.thinkingMode : draft.pipeline.disableThinking);
      const service = draft.pipeline.vlm;
      if (!service.endpoint.trim() || !service.model.trim()) return false;
      return testConnection(service, serviceLimiter);
    }
    async function runGrade2() {
      if (busy) return false;
      if (!currentQuestion || !markingDoc) {
        panel.showError("\u5C1A\u672A\u8BFB\u53D6\u5230\u9898\u76EE\uFF0C\u8BF7\u6253\u5F00\u667A\u5B66\u7F51\u9605\u5377\u9875");
        return false;
      }
      const errors = validateConfig(config);
      if (errors.length > 0) {
        panel.showError(`${errors[0]}\uFF08\u8BF7\u70B9\u51FB\u300C\u8BBE\u7F6E\u300D\u624B\u52A8\u4FEE\u6539\uFF09`);
        return false;
      }
      const scoreError = checkMaxScore(config.context.maxScore, markingDoc);
      if (scoreError) {
        panel.showError(scoreError);
        return false;
      }
      busy = true;
      panel.setBusy(true);
      panel.clearError();
      try {
        panel.setStage("\u7B49\u5F85\u4F5C\u7B54\u56FE\u7247\u7A33\u5B9A");
        const images = await gatherAnswerImages();
        if (images.length === 0) throw new Error("\u4F5C\u7B54\u56FE\u7247\u5C1A\u672A\u7A33\u5B9A\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
        currentQuestion = { ...currentQuestion, images };
        panel.setQuestion(currentQuestion);
        const result = await gradeQuestion({
          config,
          question: currentQuestion,
          cache,
          rateLimiter: limiter,
          events: { onStage: (stage, detail) => panel.setStage(stage, detail) }
        });
        lastResult = result;
        panel.setResult(result);
        lastHistoryId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        appendHistory({
          id: lastHistoryId,
          createdAt: Date.now(),
          question: currentQuestion,
          result,
          submitted: false
        }, config.historyLimit);
        historyPanel.refresh(loadHistory());
        if (result.needsReview) panel.toast("\u6279\u6539\u5B8C\u6210\uFF0C\u5EFA\u8BAE\u4EBA\u5DE5\u590D\u6838");
        return true;
      } catch (error) {
        panel.showError(error instanceof Error ? error.message : "\u6279\u6539\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u63A5\u53E3\u914D\u7F6E");
        return false;
      } finally {
        busy = false;
        panel.setBusy(false);
      }
    }
    function applyScoreEdits() {
      const edits = typeof panel.getScoreEdits === "function" ? panel.getScoreEdits() : null;
      if (!edits || (!Number.isFinite(edits.total) && !edits.subScores)) return;
      // 批改结果与缓存共享 subScores 引用，先深拷贝再改，避免污染缓存。
      lastResult = { ...lastResult, subScores: lastResult.subScores.map((item) => ({ ...item })) };
      if (edits.subScores && edits.subScores.length === lastResult.subScores.length) {
        edits.subScores.forEach((value, index) => {
          if (!Number.isFinite(value)) return;
          const max = Number(lastResult.subScores[index].maxScore) || 999;
          lastResult.subScores[index].score = Math.min(Math.max(value, 0), max);
        });
        lastResult.score = lastResult.subScores.reduce((sum, item) => sum + Number(item.score || 0), 0);
      }
      if (Number.isFinite(edits.total)) {
        const total = Math.min(Math.max(edits.total, 0), Number(lastResult.maxScore) || 999);
        if (lastResult.subScores.length) {
          const currentSum = lastResult.subScores.reduce((sum, item) => sum + Number(item.score || 0), 0);
          if (currentSum > 0) {
            lastResult.subScores.forEach((item) => {
              const max = Number(item.maxScore) || 999;
              item.score = Math.min(Math.max(Number(item.score || 0) * total / currentSum, 0), max);
            });
            const newSum = lastResult.subScores.reduce((sum, item) => sum + Number(item.score || 0), 0);
            const diff = Math.round((total - newSum) * 10) / 10;
            if (diff !== 0 && lastResult.subScores.length) {
              const last = lastResult.subScores[lastResult.subScores.length - 1];
              last.score = Math.min(Math.max(Math.round((Number(last.score || 0) + diff) * 10) / 10, 0), Number(last.maxScore) || 999);
            }
          }
        }
        lastResult.score = total;
      }
    }
    async function submitResult(options = {}) {
      if (!lastResult || !markingDoc) {
        panel.showError("\u8BF7\u5148\u5B8C\u6210\u6279\u6539\u5E76\u8FDB\u5165\u9605\u5377\u9875\u9762");
        return { ok: false, oldIdentity: null };
      }
      applyScoreEdits();
      const inputs = getScoreInputs(markingDoc);
      const scores = inputs.length > 1 && lastResult.subScores.length === inputs.length ? lastResult.subScores.map((item) => item.score) : [Math.round(lastResult.score * 10) / 10];
      const label = scores.length > 1 ? `\u5404\u5C0F\u9898\u5206\u6570 ${scores.join("\u3001")}` : `${scores[0]} \u5206`;
      if (!options.silent && !options.skipConfirm && !window.confirm(`\u786E\u8BA4\u5199\u5165${label}\u5E76\u63D0\u4EA4\uFF1F`)) {
        return { ok: false, oldIdentity: null };
      }
      const oldIdentity = getPaperIdentity();
      if (!fillScores(scores, markingDoc)) {
        panel.showError("\u5206\u6570\u5199\u5165\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u6253\u5206\u7248\u8F93\u5165\u9879");
        return { ok: false, oldIdentity };
      }
      if (!submitGrade(markingDoc)) {
        panel.showError("\u5206\u6570\u5DF2\u586B\u5165\uFF0C\u4F46\u672A\u627E\u5230\u63D0\u4EA4\u6309\u94AE\uFF0C\u8BF7\u624B\u52A8\u63D0\u4EA4");
        return { ok: false, oldIdentity };
      }
      const history = loadHistory().map((entry) => entry.id === lastHistoryId ? { ...entry, result: lastResult, submitted: true } : entry);
      writeJson(STORAGE_KEYS.history, history);
      historyPanel.refresh(history);
      lastResult = null;
      panel.setSubtitle(options.silent ? "\u8FDE\u7EED\u6279\u9605\u4E2D" : "\u5DF2\u63D0\u4EA4\uFF0C\u7B49\u5F85\u4E0B\u4E00\u4EFD");
      if (options.silent) {
        panel.setStage("\u5DF2\u63D0\u4EA4\uFF0C\u7B49\u5F85\u6362\u5377");
      } else {
        panel.toast("\u5DF2\u63D0\u4EA4");
        void waitForNextPaper(oldIdentity).then((changed) => {
          if (changed) void detect();
          else panel.setSubtitle("\u672A\u68C0\u6D4B\u5230\u6362\u5377\uFF0C\u53EF\u7EE7\u7EED\u4EBA\u5DE5\u64CD\u4F5C");
        });
      }
      return { ok: true, oldIdentity };
    }
    async function toggleContinuous() {
      if (autoMode) {
        autoMode = false;
        autoStopRequested = true;
        panel.setAutoMode(false);
        panel.setSubtitle("\u5DF2\u505C\u6B62\u8FDE\u7EED\u6279\u9605");
        panel.toast("\u8FDE\u7EED\u6279\u9605\u5DF2\u505C\u6B62");
        return;
      }
      const confirmed = window.confirm("\u8FDE\u7EED\u6279\u9605\u4F1A\u81EA\u52A8\u6279\u6539\u5E76\u63D0\u4EA4\u6BCF\u4E00\u4EFD\uFF0C\u9047\u5230\u9519\u8BEF\u6216\u7B49\u4E0D\u5230\u6362\u5377\u4F1A\u505C\u6B62\u3002\u786E\u5B9A\u5F00\u59CB\uFF1F");
      if (!confirmed) return;
      autoMode = true;
      autoStopRequested = false;
      panel.setAutoMode(true);
      panel.clearError();
      let count = 0;
      while (autoMode && !autoStopRequested) {
        count += 1;
        panel.setSubtitle(`\u8FDE\u7EED\u6279\u9605\u4E2D \xB7 \u7B2C ${count} \u4EFD`);
        const graded = await runGrade2();
        if (!graded || !autoMode || autoStopRequested) break;
        const submitted = await submitResult({ silent: true });
        if (!submitted.ok || !autoMode || autoStopRequested) break;
        panel.setSubtitle(`\u8FDE\u7EED\u6279\u9605\u4E2D \xB7 \u7B2C ${count} \u4EFD\u5DF2\u63D0\u4EA4\uFF0C\u7B49\u5F85\u6362\u5377\uFF08\u53EF\u5207\u6362\u5230\u5176\u4ED6\u6807\u7B7E\u9875\uFF09`);
        const changed = await waitForNextPaper(submitted.oldIdentity);
        if (!changed || !autoMode || autoStopRequested) {
          if (autoMode) panel.showError("\u7B49\u5F85\u6362\u5377\u8D85\u65F6\uFF0C\u8FDE\u7EED\u6279\u9605\u5DF2\u505C\u6B62\u3002\u82E5\u521A\u624D\u5207\u6362\u4E86\u754C\u9762\uFF0C\u8BF7\u786E\u8BA4\u9605\u5377\u9875\u4ECD\u6253\u5F00\u4E14\u5DF2\u663E\u793A\u65B0\u4F5C\u7B54\u56FE\u540E\u91CD\u65B0\u5F00\u59CB");
          break;
        }
        await detect();
        await new Promise((resolve) => window.setTimeout(resolve, 300));
      }
      autoMode = false;
      autoStopRequested = false;
      panel.setAutoMode(false);
      panel.setSubtitle(`\u8FDE\u7EED\u6279\u9605\u5DF2\u505C\u6B62 \xB7 \u5171 ${count} \u4EFD`);
    }
    async function detect() {
      if (!isZhixueHost()) {
        panel.setSubtitle("\u5F53\u524D\u975E\u9605\u5377\u9875\u9762");
        return;
      }
      const doc = await waitForMarkingDocument();
      if (!doc) {
        panel.setSubtitle("\u672A\u68C0\u6D4B\u5230\u9605\u5377\u63A7\u4EF6");
        return;
      }
      markingDoc = doc;
      applyQuestion(readQuestion(doc));
      watchDocument(doc);
    }
    function applyQuestion(question) {
      if (!question) return;
      if (currentQuestion?.questionId === question.questionId && currentQuestion.images.length === question.images.length) return;
      currentQuestion = question;
      lastResult = null;
      panel.setQuestion(question);
      panel.setSubtitle(`\u5DF2\u8BFB\u53D6\u9898\u53F7 ${question.questionId}`);
      panel.clearError();
    }
    function watchDocument(doc) {
      observer?.disconnect();
      if (!doc.body) return;
      observer = new MutationObserver(() => {
        window.clearTimeout(observerTimer);
        observerTimer = window.setTimeout(() => applyQuestion(readQuestion(doc)), 600);
      });
      observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
    }
    GM_registerMenuCommand("\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u6253\u5F00\u9762\u677F", () => panel.show());
    GM_registerMenuCommand("\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u8FDE\u7EED\u6279\u9605", () => {
      void toggleContinuous();
    });
    GM_registerMenuCommand("\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u8BBE\u7F6E", () => settingsPanel.show(config));
    GM_registerMenuCommand("\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u5386\u53F2", () => historyPanel.show(loadHistory()));
    GM_registerMenuCommand("\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u6E05\u7A7A\u7F13\u5B58", () => {
      cache.clear();
      panel.toast("\u7F13\u5B58\u5DF2\u6E05\u7A7A");
    });
    await detect();
  }
  void bootstrap().catch((error) => {
    console.warn("[\u667A\u9605\u6279\u6539\u52A9\u624B] \u542F\u52A8\u5931\u8D25", error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF");
  });
})();
