// ==UserScript==
// @name         智阅批改助手
// @namespace    zygr.local.grader
// @version      1.0.2
// @description  智学网阅卷辅助：读取作答图并结合配置的评分标准打分，支持多模态直评或 OCR 加文本推理与历史导出。
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
  function visible(element) {
    if (element.getClientRects && !element.getClientRects().length) return false;
    const view = element.ownerDocument?.defaultView;
    if (!view) return true;
    const style = view.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
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
    const deadline = Date.now() + timeout;
    let candidate = null;
    let stable = 0;
    while (Date.now() < deadline) {
      const snapshot = answerSnapshot();
      if (snapshot.ready && snapshot.identity && snapshot.identity !== oldIdentity) {
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
      pipeline: "ocr+text",
      vlm: { endpoint: "", apiKey: "", model: "" },
      ocr: {
        provider: "vision-chat",
        endpoint: "https://api.siliconflow.cn/v1/chat/completions",
        apiKey: "",
        model: "deepseek-ai/DeepSeek-OCR",
        resultPath: "text"
      },
      text: { endpoint: "", apiKey: "", model: "" },
      disableThinking: true,
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
  function loadConfig() {
    const raw = readJson(STORAGE_KEYS.config, {});
    if (!isRecord(raw) || raw.version !== 1) return clone(DEFAULT_CONFIG);
    return merge(DEFAULT_CONFIG, raw);
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
    if (pipeline.pipeline === "vlm") {
      requireService("\u591A\u6A21\u6001\u670D\u52A1", pipeline.vlm);
    } else {
      requireService("OCR \u670D\u52A1", pipeline.ocr, pipeline.ocr.provider !== "local-http");
      requireService("\u6587\u672C\u63A8\u7406\u670D\u52A1", pipeline.text);
    }
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
  function makeOcrCacheKey(images, model, promptVersion) {
    return `ocr:${hashString(images.join("\0"))}:${hashString(model)}:${promptVersion}`;
  }
  function makeGradeCacheKey(input) {
    const payload = JSON.stringify({
      question: input.context.question || input.question.questionText,
      answer: input.context.answer,
      rubric: input.context.rubric,
      maxScore: input.context.maxScore,
      subs: input.question.subQuestions,
      ocr: input.ocrText ?? "",
      images: input.ocrText ? [] : input.question.images,
      model: input.model,
      pipeline: input.pipeline
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
      "\u5DF2\u63D0\u4EA4",
      "OCR \u6458\u8981"
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
      entry.submitted ? "\u662F" : "\u5426",
      (entry.result.ocrText ?? "").slice(0, 500)
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
      <td>${escapeHtml((entry.result.ocrText ?? "").slice(0, 1200))}</td>
    </tr>`).join("");
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u5386\u53F2\u5BFC\u51FA</title>
<style>
body{font:14px/1.6 "PingFang SC",sans-serif;color:#0f172a;background:#f8fafc;margin:24px}
h1{font-size:20px;margin:0 0 16px}table{width:100%;border-collapse:collapse;background:#fff}
th,td{border:1px solid #e2e8f0;padding:8px;vertical-align:top;text-align:left}
th{background:#eef2ff;color:#3730a3}tr:nth-child(even){background:#f8fafc}
</style></head><body><h1>\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u5386\u53F2\u5BFC\u51FA</h1>
<table><thead><tr><th>\u65F6\u95F4</th><th>\u9898\u53F7</th><th>\u94FE\u8DEF</th><th>\u72B6\u6001</th><th>\u5F97\u5206</th><th>\u5C0F\u9898\u5206</th><th>\u4F9D\u636E</th><th>\u6807\u8BB0</th><th>OCR \u6458\u8981</th></tr></thead><tbody>${rows}</tbody></table>
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

  // src/infra/api.ts
  var sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  function gmRequest(details) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...details,
        onload: (response) => {
          if (response.status >= 200 && response.status < 300) resolve(response);
          else {
            const hint = response.status === 400 ? "\u8BF7\u6C42\u53C2\u6570\u6216\u63D0\u793A\u8BCD\u683C\u5F0F\u53EF\u80FD\u4E0D\u88AB\u8BE5\u6A21\u578B\u652F\u6301" : response.status === 404 ? "接口地址或模型名称不匹配；火山方舟请填完整地址 https://ark.cn-beijing.volces.com/api/v3/chat/completions 或 https://ark.cn-beijing.volces.com/api/v3/responses，不要只填 /api/v3 基础地址" : "\u8BF7\u68C0\u67E5\u63A5\u53E3\u5730\u5740\u4E0E\u6A21\u578B\u540D\u79F0\u662F\u5426\u5339\u914D";
            reject(new Error(`\u63A5\u53E3\u8FD4\u56DE HTTP ${response.status}\uFF08${hint}\uFF09`));
          }
        },
        onerror: (response) => reject(new Error(`\u7F51\u7EDC\u9519\u8BEF\uFF08HTTP ${response.status || 0}\uFF09`)),
        ontimeout: () => reject(new Error("\u8BF7\u6C42\u8D85\u65F6"))
      });
    });
  }
  function estimateTokens(text, imageCount = 0) {
    return Math.ceil(text.length / 2) + imageCount * 1e3;
  }
  // 火山方舟等 OpenAI 兼容服务：基础地址自动补全为具体接口路径
  function normalizeEndpoint(endpoint) {
    const value = String(endpoint || "").trim().replace(/\/+$/, "");
    if (!value) return value;
    if (/\/chat\/completions$/i.test(value) || /\/responses$/i.test(value) || /\/messages$/i.test(value)) return value;
    if (/\/api\/v3$/i.test(value) || /\/v1$/i.test(value) || /^https?:\/\/[^/]+$/i.test(value)) {
      return `${value}/chat/completions`;
    }
    return value;
  }
  function apiStyle(endpoint) {
    return /\/responses\/?$/i.test(String(endpoint || "").trim()) ? "responses" : "chat";
  }
  function toResponsesInput(messages) {
    return messages.filter((message) => message.role !== "system").map((message) => {
      const content = Array.isArray(message.content)
        ? message.content.map((part) => {
            if (part && part.type === "image_url") {
              return { type: "input_image", image_url: String(part.image_url?.url ?? "") };
            }
            return { type: "input_text", text: String(part?.text ?? "") };
          })
        : [{ type: "input_text", text: String(message.content ?? "") }];
      return { role: message.role, content };
    });
  }
  function extractResponsesText(body) {
    const outputs = Array.isArray(body?.output) ? body.output : [];
    const texts = [];
    for (const item of outputs) {
      if (!item || item.type !== "message" || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part && (part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
          texts.push(part.text);
        }
      }
    }
    if (texts.length) return texts.join("\n");
    return typeof body?.output_text === "string" ? body.output_text : "";
  }
  // 关闭思考模式：按服务商注入对应字段，遇到不支持该字段的 400 会自动剥离重试
  function thinkingControl(payload, endpoint, style, disable) {
    const injected = [];
    if (!disable) return injected;
    if (style === "responses") {
      payload.reasoning = { effort: "none" };
      injected.push("reasoning");
      return injected;
    }
    const url = String(endpoint || "").toLowerCase();
    if (url.includes("siliconflow")) {
      payload.enable_thinking = false;
      injected.push("enable_thinking");
    } else if (url.includes("volces.com") || url.includes("volcengine") || url.includes("deepseek.com")) {
      payload.thinking = { type: "disabled" };
      injected.push("thinking");
    } else {
      payload.enable_thinking = false;
      injected.push("enable_thinking");
    }
    return injected;
  }
  async function chatCompletion(service, messages, options = {}) {
    const endpoint = normalizeEndpoint(service.endpoint);
    const style = apiStyle(endpoint);
    const payload = style === "responses"
      ? { model: service.model, input: toResponsesInput(messages), stream: false }
      : { model: service.model, messages, stream: false };
    const thinkingKeys = thinkingControl(payload, endpoint, style, options.disableThinking ?? service.disableThinking);
    if (style === "responses") {
      const instructions = messages.filter((message) => message.role === "system").map((message) => {
        if (typeof message.content === "string") return message.content;
        if (Array.isArray(message.content)) return message.content.map((part) => String(part?.text ?? "")).join("");
        return "";
      }).filter(Boolean).join("\n");
      if (instructions) payload.instructions = instructions;
    }
    const temperature = options.temperature === void 0 ? 0.2 : options.temperature;
    if (temperature !== null) payload.temperature = temperature;
    if (options.jsonMode) {
      if (style === "responses") payload.text = { format: { type: "json_object" } };
      else payload.response_format = { type: "json_object" };
    }
    const retries = options.retries ?? 2;
    let lastError = new Error("\u672A\u77E5\u9519\u8BEF");
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const execute = async () => gmRequest({
        method: "POST",
        url: endpoint,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${service.apiKey}`
        },
        data: JSON.stringify(payload),
        timeout: options.timeoutMs ?? 12e4
      });
      try {
        const response = options.rateLimiter ? await options.rateLimiter.run(execute, options.estimatedTokens ?? 0) : await execute();
        const body = JSON.parse(response.responseText ?? "{}");
        const content = style === "responses" ? extractResponsesText(body) : body.choices?.[0]?.message?.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) return content.map((part) => String(part.text ?? "")).join("");
        throw new Error("\u63A5\u53E3\u54CD\u5E94\u7F3A\u5C11\u6587\u672C\u5185\u5BB9");
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const message = lastError.message;
        if (message.includes("HTTP 400")) {
          let relaxed = false;
          if (options.jsonMode && (payload.response_format || payload.text)) {
            delete payload.response_format;
            delete payload.text;
            relaxed = true;
          }
          if (thinkingKeys.length) {
            for (const key of thinkingKeys) delete payload[key];
            thinkingKeys.length = 0;
            relaxed = true;
          }
          if (relaxed) continue;
        }
        const retryable = message.includes("429") || /HTTP 5\d\d/.test(message) || message.includes("\u8D85\u65F6") || message.includes("\u7F51\u7EDC\u9519\u8BEF");
        if (!retryable || attempt === retries) break;
        await sleep(600 * 2 ** attempt);
      }
    }
    throw lastError;
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

  // src/infra/ocr.ts
  var DEEPSEEK_OCR_PROMPT = "<image>\n<|grounding|>Convert the document to markdown.";
  function isDeepSeekOcr(model) {
    return /deepseek[-/]?ocr/i.test(model);
  }
  function pickPath(source, path) {
    const current = typeof source === "string" ? (() => {
      try {
        return JSON.parse(source);
      } catch {
        return source;
      }
    })() : source;
    return path.split(".").filter(Boolean).reduce((value, key) => {
      if (value && typeof value === "object" && key in value) {
        return value[key];
      }
      return void 0;
    }, current);
  }
  function firstText(value) {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(firstText).find(Boolean) ?? "";
    if (value && typeof value === "object") {
      for (const key of ["text", "markdown", "result", "content", "data"]) {
        const found = firstText(value[key]);
        if (found) return found;
      }
    }
    return "";
  }
  async function deepseekOcr(input) {
    const texts = [];
    for (const url of input.images) {
      const parts = [
        { type: "image_url", image_url: { url } },
        { type: "text", text: DEEPSEEK_OCR_PROMPT }
      ];
      const raw = await chatCompletion(
        input.config,
        [{ role: "user", content: parts }],
        {
          rateLimiter: input.rateLimiter,
          timeoutMs: input.timeoutMs,
          retries: 2,
          estimatedTokens: 1e3,
          temperature: null
        }
      );
      if (raw.trim()) texts.push(raw.trim());
    }
    const text = texts.join("\n\n---\n\n").trim();
    return { text, confidence: text ? 0.85 : 0.1 };
  }
  async function visionOcr(input) {
    const parts = [
      ...input.images.map((url) => ({
        type: "image_url",
        image_url: { url, detail: "high" }
      })),
      { type: "text", text: input.prompt }
    ];
    const text = await chatCompletion(
      input.config,
      [{ role: "user", content: parts }],
      {
        rateLimiter: input.rateLimiter,
        timeoutMs: input.timeoutMs,
        retries: 2,
        estimatedTokens: input.images.length * 1e3
      }
    );
    const clean = text.trim();
    return { text: clean, confidence: clean && !clean.includes("[\u7A7A\u767D]") ? 0.82 : 0.1 };
  }
  async function localOcr(input) {
    const run = async () => {
      const response = await gmRequest({
        method: "POST",
        url: input.config.endpoint,
        headers: {
          "Content-Type": "application/json",
          ...input.config.apiKey ? { Authorization: `Bearer ${input.config.apiKey}` } : {}
        },
        data: JSON.stringify({ model: input.config.model, prompt: input.prompt, images: input.images }),
        timeout: input.timeoutMs ?? 12e4
      });
      const parsed = JSON.parse(response.responseText ?? "{}");
      const selected = pickPath(parsed, input.config.resultPath || "text");
      const text = firstText(selected) || firstText(parsed);
      const confidenceValue = pickPath(parsed, "confidence");
      const confidence = typeof confidenceValue === "number" ? confidenceValue : text ? 0.8 : 0.1;
      return { text: text.trim(), confidence };
    };
    return input.rateLimiter ? input.rateLimiter.run(run, input.images.length * 200) : run();
  }
  async function recognizeAnswers(input) {
    if (input.config.provider === "local-http") return localOcr(input);
    if (isDeepSeekOcr(input.config.model)) return deepseekOcr(input);
    return visionOcr(input);
  }

  // src/core/prompt.ts
  var PROMPT_VERSION = "zygr-prompt-v2";
  var LIMITS = {
    clarity: 12e3,
    balanced: 6e3,
    saving: 3e3
  };
  function clip(text, max) {
    const value = text.trim();
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
    const limit = LIMITS[options.profile];
    const answer = options.ocrText?.trim() ? `\u3010\u5B66\u751F\u4F5C\u7B54\uFF08OCR \u6587\u672C\uFF09\u3011
${clip(options.ocrText, limit)}` : "\u3010\u5B66\u751F\u4F5C\u7B54\u3011\n\u89C1\u968F\u9644\u56FE\u7247\uFF0C\u6309\u56FE\u7247\u5185\u5BB9\u5224\u65AD";
    const sections = [
      "\u4F60\u662F\u9605\u5377\u52A9\u624B\u3002\u53EA\u4F9D\u636E\u7ED9\u5B9A\u5185\u5BB9\u8BC4\u5206\uFF0C\u4E0D\u8981\u81C6\u6D4B\u3002",
      "\u4E25\u683C\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u4E0D\u8981 Markdown \u4EE3\u7801\u5757\uFF0C\u4E0D\u8981\u989D\u5916\u89E3\u91CA\u3002",
      "\u5B57\u6BB5\uFF1Astatus\uFF08legible/partial/illegible/blank\uFF09\u3001score\uFF08\u6570\u5B57\uFF09\u3001subScores\uFF08\u6570\u7EC4\uFF1Alabel/score/maxScore/reason\uFF09\u3001reason\uFF08\u4E0D\u8D85\u8FC7 80 \u5B57\uFF09\u3001confidence\uFF080 \u5230 1\uFF09\u3002",
      "\u89C4\u5219\uFF1A\u672A\u4F5C\u7B54\u4E0D\u5F97\u7ED9\u6B63\u5206\uFF1B\u5212\u53BB\u7684\u5185\u5BB9\u4E0D\u8BA1\u5206\uFF1B\u7B49\u4EF7\u89E3\u6CD5\u5E94\u7ED9\u5206\uFF1B\u5206\u6570\u4E0D\u5F97\u8D85\u8FC7\u6EE1\u5206\uFF1B\u65E0\u6CD5\u8FA8\u8BA4\u65F6\u7ED9\u51FA legible/partial/illegible \u5E76\u8BF4\u660E\u3002",
      question.subQuestions.length > 0 ? "\u8BF7\u9010\u9879\u7ED9\u51FA subScores\uFF0Clabel \u5FC5\u987B\u4E0E\u8F93\u5165\u5C0F\u9898\u4E00\u81F4\uFF1B\u603B\u5206\u987B\u7B49\u4E8E\u5404\u5C0F\u9898\u5F97\u5206\u4E4B\u548C\u3002" : "subScores \u8FD4\u56DE\u7A7A\u6570\u7EC4\u5373\u53EF\u3002",
      "===== \u8F93\u5165 =====",
      `\u3010\u9898\u76EE\u3011
${clip(context.question || question.questionText, limit)}`,
      `\u3010\u53C2\u8003\u7B54\u6848\u3011
${clip(context.answer, limit)}`,
      `\u3010\u8BC4\u5206\u6807\u51C6\u3011
${clip(context.rubric, limit)}`,
      `\u3010\u5206\u503C\u3011
${maxScoreLine(context, question)}`,
      `\u3010\u5C0F\u9898\u3011
${subQuestionLines(question)}`,
      answer,
      options.fromImages ? "\u6CE8\u610F\uFF1A\u968F\u9644\u56FE\u7247\u4EC5\u4E3A\u672C\u6B21\u5B66\u751F\u4F5C\u7B54\uFF0C\u7B54\u5377\u4E0A\u7684\u5370\u5237\u9898\u5E72\u4E0D\u5C5E\u4E8E\u5B66\u751F\u4F5C\u7B54\u3002" : "",
      options.removedImages && options.removedImages > 0 ? `\u3010\u56FE\u7247\u8BF4\u660E\u3011\u5DF2\u5254\u9664 ${options.removedImages} \u5F20\u5E9F\u56FE\uFF0C\u8BF7\u57FA\u4E8E\u5269\u4F59\u56FE\u7247\u8BC4\u5224\u3002` : "",
      "===== \u8F93\u51FA =====",
      "\u53EA\u8F93\u51FA JSON\u3002"
    ];
    return sections.filter(Boolean).join("\n\n");
  }
  function buildOcrPrompt(question, context, profile) {
    const limit = LIMITS[profile];
    return [
      "\u4F60\u662F OCR \u8F6C\u5199\u5668\u3002\u8BF7\u9010\u5B57\u8F6C\u5199\u968F\u9644\u7684\u5B66\u751F\u4F5C\u7B54\u56FE\u7247\uFF0C\u4FDD\u7559\u9898\u53F7\u3001\u5C0F\u9898\u7F16\u53F7\u3001\u516C\u5F0F\u4E0E\u6D82\u6539\u6807\u8BB0\u3002",
      "\u53EA\u8F93\u51FA Markdown \u6587\u672C\uFF0C\u4E0D\u8981\u89E3\u91CA\u3001\u4E0D\u8981\u8BC4\u5206\u3001\u4E0D\u8981\u8865\u5168\u7B54\u6848\u3002",
      "\u65E0\u6CD5\u8FA8\u8BA4\u5904\u7528 [\u4E0D\u6E05] \u6807\u8BB0\uFF1B\u5B8C\u5168\u7A7A\u767D\u8F93\u51FA [\u7A7A\u767D]\u3002",
      `\u6CE8\u610F\uFF1A\u4EC5\u8F6C\u5199\u5B66\u751F\u4F5C\u7B54\uFF0C\u4E0D\u8981\u8F6C\u5199\u9898\u76EE\u3001\u53C2\u8003\u7B54\u6848\u6216\u8BC4\u5206\u6807\u51C6\u914D\u56FE\u3002\u5171 ${question.images.length} \u5F20\u4F5C\u7B54\u56FE\u7247\u3002`,
      `\u9898\u5E72\u6458\u8981\uFF1A${clip(context.question || question.questionText, Math.min(limit, 600))}`,
      `\u5C0F\u9898\u7F16\u53F7\uFF1A${subQuestionLines(question)}`
    ].join("\n\n");
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
  async function runGrade(service, question, maxScore, prompt, images, fromImages, config, rateLimiter) {
    const content = fromImages ? [
      { type: "text", text: prompt },
      ...images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl, detail: "high" } }))
    ] : prompt;
    const messages = [
      { role: "system", content: "\u4F60\u662F\u4E25\u683C\u4F46\u516C\u6B63\u7684\u9605\u5377\u52A9\u624B\uFF0C\u53EA\u8F93\u51FA JSON\u3002" },
      { role: "user", content }
    ];
    const raw = await chatCompletion(service, messages, {
      rateLimiter,
      timeoutMs: config.pipeline.timeoutMs,
      jsonMode: true,
      estimatedTokens: estimateTokens(prompt, fromImages ? images.length : 0)
    });
    if (!raw.trim()) throw new Error("\u6A21\u578B\u8FD4\u56DE\u4E3A\u7A7A");
    return parseGrade(raw, maxScore, question.subQuestions);
  }
  async function gradeQuestion(options) {
    const { config, question, cache, rateLimiter } = options;
    const thinkOff = config.pipeline.disableThinking !== false;
    config.pipeline.vlm.disableThinking = thinkOff;
    config.pipeline.ocr.disableThinking = thinkOff;
    config.pipeline.text.disableThinking = thinkOff;
    const startedAt = Date.now();
    const stage = (name, detail) => options.events?.onStage?.(name, detail);
    const reviewReasons = [];
    const maxScore = config.context.maxScore > 0 ? config.context.maxScore : question.maxScore;
    let pipeline = options.forcePipeline ?? config.pipeline.pipeline;
    let usedFallback = false;
    stage("\u51C6\u5907\u4F5C\u7B54\u56FE\u7247");
    const preparedList = (await Promise.all(
      question.images.map((src) => prepareImage(src, config.image).catch(() => null))
    )).filter((item) => item !== null);
    const prepared = dedupePrepared(preparedList);
    const removed = prepared.filter((image) => isBlankImage(image) || isWasteImage(image));
    const usable = prepared.filter((image) => !isBlankImage(image) && !isWasteImage(image));
    if (removed.length > 0) reviewReasons.push(`\u5DF2\u5254\u9664 ${removed.length} \u5F20\u5E9F\u56FE`);
    if (prepared.length === 0 || usable.length === 0) {
      throw new Error("\u672A\u83B7\u53D6\u5230\u53EF\u7528\u4F5C\u7B54\u56FE\u7247\uFF0C\u8BF7\u7B49\u5F85\u9605\u5377\u9875\u56FE\u7247\u52A0\u8F7D\u5B8C\u6210\u540E\u91CD\u8BD5");
    }
    let ocrText;
    if (pipeline === "ocr+text") {
      const ocrCacheKey = makeOcrCacheKey(usable.map((image) => image.hash), config.pipeline.ocr.model, PROMPT_VERSION);
      const cachedOcr = cache.get(ocrCacheKey);
      if (cachedOcr) {
        ocrText = cachedOcr.text;
        stage("OCR \u7F13\u5B58\u547D\u4E2D");
      } else {
        stage("OCR \u8BC6\u522B");
        try {
          const output = await recognizeAnswers({
            images: usable.map((image) => image.dataUrl),
            prompt: buildOcrPrompt(question, config.context, config.image.profile),
            config: config.pipeline.ocr,
            rateLimiter,
            timeoutMs: config.pipeline.timeoutMs
          });
          ocrText = output.text;
          if (output.confidence < 0.3) reviewReasons.push("OCR \u7F6E\u4FE1\u5EA6\u8F83\u4F4E");
          cache.set(ocrCacheKey, output);
        } catch (error) {
          const message = error instanceof Error ? error.message : "OCR \u8BF7\u6C42\u5931\u8D25";
          if (!configured(config.pipeline.vlm)) throw new Error(`${message}\uFF1B\u4E14\u672A\u914D\u7F6E\u591A\u6A21\u6001\u670D\u52A1\u7528\u4E8E\u590D\u6838`);
          usedFallback = true;
          reviewReasons.push("OCR \u8BF7\u6C42\u5931\u8D25\uFF0C\u5DF2\u5207\u6362\u591A\u6A21\u6001\u590D\u6838");
        }
      }
      if (!usedFallback && !ocrText?.trim()) {
        stage("\u672A\u8BC6\u522B\u5230\u4F5C\u7B54\u5185\u5BB9");
        const subScores = question.subQuestions.map((item) => ({
          label: item.label,
          score: 0,
          maxScore: item.maxScore,
          reason: "\u672A\u4F5C\u7B54"
        }));
        const blankKey = makeGradeCacheKey({
          question,
          context: config.context,
          ocrText: "",
          model: "blank-detector",
          pipeline: "blank",
          promptVersion: PROMPT_VERSION
        });
        const result2 = {
          status: "blank",
          score: 0,
          subScores,
          reason: "OCR \u672A\u8BC6\u522B\u5230\u6587\u5B57\uFF0C\u6309\u672A\u4F5C\u7B54\u5904\u7406",
          confidence: 1,
          raw: "",
          maxScore,
          pipeline,
          ocrText: "",
          needsReview: true,
          reviewReasons: [...reviewReasons, "\u8BF7\u4EBA\u5DE5\u786E\u8BA4\u662F\u5426\u767D\u5377\u6216 OCR \u6F0F\u8BC6"],
          usedFallback: false,
          cacheHit: false,
          cacheKey: blankKey,
          elapsedMs: Date.now() - startedAt,
          model: "blank-detector",
          createdAt: Date.now()
        };
        cache.set(blankKey, result2);
        return result2;
      }
    }
    const fromImages = pipeline === "vlm" || usedFallback;
    const gradeService = fromImages ? config.pipeline.vlm : config.pipeline.text;
    if (!configured(gradeService)) throw new Error("\u6279\u6539\u670D\u52A1\u672A\u914D\u7F6E\u5B8C\u6574\uFF0C\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u586B\u5199\u63A5\u53E3\u5730\u5740\u4E0E\u6A21\u578B");
    const prompt = buildGradingPrompt(question, config.context, {
      profile: config.image.profile,
      ocrText,
      fromImages,
      removedImages: removed.length
    });
    const cacheKey = makeGradeCacheKey({
      question,
      context: config.context,
      ocrText,
      model: gradeService.model,
      pipeline: usedFallback ? "vlm" : pipeline,
      promptVersion: PROMPT_VERSION
    });
    const cached = cache.get(cacheKey);
    if (cached) {
      stage("\u8BC4\u5206\u7F13\u5B58\u547D\u4E2D");
      return { ...cached, cacheHit: true, elapsedMs: Date.now() - startedAt, cacheKey };
    }
    stage("\u6A21\u578B\u8BC4\u5206", gradeService.model);
    const grade = await runGrade(
      gradeService,
      question,
      maxScore,
      prompt,
      usable,
      fromImages,
      config,
      rateLimiter
    );
    if (grade.status === "blank" && grade.score > 0) {
      reviewReasons.push("\u8BC6\u522B\u4E3A\u672A\u4F5C\u7B54\u4F46\u7ED9\u51FA\u4E86\u6B63\u5206\uFF0C\u8BF7\u4EBA\u5DE5\u6838\u67E5");
    }
    if (grade.confidence < 0.5) reviewReasons.push("\u6A21\u578B\u7F6E\u4FE1\u5EA6\u8F83\u4F4E\uFF0C\u5EFA\u8BAE\u4EBA\u5DE5\u590D\u6838");
    const result = {
      ...grade,
      maxScore,
      pipeline,
      ocrText,
      needsReview: reviewReasons.length > 0,
      reviewReasons,
      usedFallback,
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
.zygr-badge { padding: 4px 10px; border-radius: 999px; font-size: 11px; background: rgba(20,184,166,.12); color: #0f766e; border: 1px solid rgba(20,184,166,.24); }
.zygr-badge.zygr-risk { background: rgba(220,38,38,.1); color: #b91c1c; border-color: rgba(220,38,38,.22); }
.zygr-reason { margin-top: 10px; color: var(--zygr-muted); line-height: 1.65; }
.zygr-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
.zygr-table th, .zygr-table td { text-align: left; padding: 6px 5px; border-top: 1px solid var(--zygr-line); }
.zygr-table th { color: var(--zygr-muted); font-weight: 500; }
.zygr-reviews { margin-top: 8px; color: #b45309; line-height: 1.6; }
.zygr-error { padding: 9px 11px; border-radius: 10px; background: rgba(220,38,38,.08); color: #b91c1c; border: 1px solid rgba(220,38,38,.18); }
.zygr-actions {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; padding: 11px 14px 14px;
  border-top: 1px solid var(--zygr-line); background: rgba(255,255,255,.42);
}
.zygr-btn {
  padding: 8px 6px; border-radius: 10px; border: 1px solid rgba(79,70,229,.2);
  background: rgba(255,255,255,.78); color: #3730a3; font-size: 12px; transition: .18s;
}
.zygr-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 14px rgba(79,70,229,.16); }
.zygr-btn:focus-visible { outline: 2px solid var(--zygr-sky); outline-offset: 2px; }
.zygr-btn.zygr-primary { color: #fff; border-color: transparent; background: linear-gradient(135deg, var(--zygr-primary), var(--zygr-sky)); }
.zygr-btn.zygr-running { color: #fff; border-color: transparent; background: linear-gradient(135deg, #dc2626, #f59e0b); }
.zygr-btn.zygr-ghost { color: var(--zygr-muted); border-color: var(--zygr-line); background: transparent; }
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
  var GraderPanel = class {
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.toastTimer = 0;
      this.host = document.createElement("div");
      this.host.className = "zygr-host";
      this.shadow = this.host.attachShadow({ mode: "open" });
      this.shadow.innerHTML = `<style>${STYLES}</style>${this.markup()}`;
      this.panel = this.q(".zygr-panel");
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
        <button class="zygr-btn" data-act="review">\u591A\u6A21\u6001\u590D\u6838</button>
        <button class="zygr-btn" data-act="submit">\u63D0\u4EA4\u7ED3\u679C</button>
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
        } else if (action === "review") {
          this.callbacks.onReviewVlm();
        } else if (action === "submit") {
          this.callbacks.onSubmit();
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
      score.className = "zygr-score";
      score.textContent = String(Math.round(result.score * 10) / 10);
      const unit = document.createElement("small");
      unit.textContent = ` / ${result.maxScore || "\u2014"} \u5206`;
      score.appendChild(unit);
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
        for (const item of result.subScores) {
          const tr = document.createElement("tr");
          const cells = [`${item.label}/${item.maxScore}`, `${item.score}`, item.reason || "\u2014"];
          cells.forEach((value) => {
            const td = document.createElement("td");
            td.textContent = value;
            tr.appendChild(td);
          });
          body.appendChild(tr);
        }
        table.append(head, body);
        container.appendChild(table);
      }
      const reviews = [...result.reviewReasons];
      if (result.usedFallback) reviews.unshift("\u5DF2\u5207\u6362\u591A\u6A21\u6001\u590D\u6838");
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
      this.setCache(result.cacheHit ? "\u7F13\u5B58\u547D\u4E2D" : result.usedFallback ? "\u5DF2\u56DE\u9000" : "\u65B0\u7ED3\u679C", result.cacheHit ? "ok" : result.needsReview ? "warn" : "idle");
      this.setStage("\u5B8C\u6210");
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
          <select data-filter="pipeline" aria-label="\u94FE\u8DEF\u7B5B\u9009"><option value="">\u5168\u90E8\u94FE\u8DEF</option><option value="vlm">\u591A\u6A21\u6001</option><option value="ocr+text">OCR \u52A0\u6587\u672C</option></select>
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
      const pipeline = this.q("[data-filter='pipeline']").value;
      const review = this.q("[data-filter='review']").value;
      const keyword = this.q("[data-filter='keyword']").value.trim().toLowerCase();
      return this.entries.filter((entry) => {
        if (pipeline && entry.result.pipeline !== pipeline) return false;
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
        `\u5C0F\u9898\uFF1A${entry.result.subScores.map((item) => `${item.label} ${item.score}/${item.maxScore}`).join("\uFF1B") || "\u65E0"}`,
        `OCR \u539F\u6587\uFF1A${(entry.result.ocrText || "\u65E0").slice(0, 1500)}`
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
      return `<div class="zygr-overlay" hidden><div class="zygr-dialog zygr-wide">
      <div class="zygr-dialog-head"><h2>\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u8BBE\u7F6E</h2><button class="zygr-icon" data-act="close" aria-label="\u5173\u95ED">\xD7</button></div>
      <div class="zygr-dialog-body">
        <div class="zygr-tabs">
          <button class="zygr-tab zygr-active" data-tab="context">\u6279\u6539\u4E0A\u4E0B\u6587</button>
          <button class="zygr-tab" data-tab="api">\u63A5\u53E3\u4E0E\u94FE\u8DEF</button>
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
          <h3>\u8BC6\u522B\u94FE\u8DEF</h3>
          <div class="zygr-grid">
            ${select("\u6279\u6539\u94FE\u8DEF", "pipeline.pipeline", [["ocr+text", "OCR \u8BC6\u522B + \u6587\u672C\u63A8\u7406\uFF08\u7701 Token\uFF09"], ["vlm", "\u591A\u6A21\u6001\u6A21\u578B\u76F4\u8BC4"]])}
          </div>
          <label class="zygr-row"><input type="checkbox" data-field="pipeline.disableThinking"> \u5173\u95ED\u601D\u8003\u6A21\u5F0F\uFF08\u63A8\u8350\uFF1A\u7701 Token\u3001\u66F4\u5FEB\uFF09</label>
          <p class="zygr-hint">\u5BF9 DeepSeek-V4.1-Flash \u7B49\u9ED8\u8BA4\u5F00\u601D\u8003\u7684\u6A21\u578B\u751F\u6548\uFF0C\u81EA\u52A8\u6309\u670D\u52A1\u5546\u53D1\u9001\u5173\u95ED\u53C2\u6570\uFF08\u7845\u57FA\u6D41\u52A8\u3001\u706B\u5C71\u65B9\u821F\u3001DeepSeek \u5B98\u65B9\u5747\u652F\u6301\uFF09\u3002\u82E5\u67D0\u6A21\u578B\u4E0D\u652F\u6301\u8BE5\u5B57\u6BB5\u4F1A\u81EA\u52A8\u5218\u9664\u91CD\u8BD5\u3002\u9047\u96BE\u9898\u53EF\u53D6\u6D88\u52FE\u9009\u4EE5\u5F00\u601D\u8003\u3002</p>

          <div data-pipeline-section="ocr">
            <div class="zygr-grid">
              ${select("OCR \u670D\u52A1\u7C7B\u578B", "pipeline.ocr.provider", [["vision-chat", "\u4E91\u7AEF\u89C6\u89C9 OCR\uFF08OpenAI \u517C\u5BB9\uFF09"], ["local-http", "\u672C\u5730 HTTP OCR \u670D\u52A1"]])}
            </div>
            <p class="zygr-hint">deepseek-ai/DeepSeek-OCR \u662F\u7845\u57FA\u6D41\u52A8\u6A21\u578B\uFF0C\u63A5\u53E3\u5730\u5740\u5E94\u4E3A https://api.siliconflow.cn/v1/chat/completions\uFF1BDeepSeek \u5B98\u65B9\u5730\u5740\u4E0D\u652F\u6301\u8BE5\u6A21\u578B\uFF0C\u4F1A\u8FD4\u56DE 404\u3002L0 \u9650\u989D RPM 1000 / TPM 80000\uFF0C\u901A\u5E38\u4EC5\u4F9B\u6279\u91CF\u9650\u901F\u53C2\u8003\u3002</p>
            <div class="zygr-row"><button class="zygr-btn" data-preset="siliconflow-ocr">\u586B\u5165\u7845\u57FA\u6D41\u52A8 OCR \u9884\u8BBE</button><button class="zygr-btn" data-preset="volc-ocr">填入火山方舟 OCR 预设</button></div>
            <h3>OCR \u670D\u52A1</h3>
            <div class="zygr-grid">
              ${field("\u63A5\u53E3\u5730\u5740", "pipeline.ocr.endpoint")}${field("API Key", "pipeline.ocr.apiKey", "password")}
              ${field("\u6A21\u578B", "pipeline.ocr.model")}${field("\u672C\u5730\u8FD4\u56DE\u5B57\u6BB5\u8DEF\u5F84", "pipeline.ocr.resultPath")}
            </div>
            <div class="zygr-row"><button class="zygr-btn" data-test="ocr">\u6D4B\u8BD5 OCR</button><span class="zygr-test-status" data-status="ocr"></span></div>
          </div>

          <div data-pipeline-section="text">
            <h3>\u6587\u672C\u63A8\u7406\u670D\u52A1</h3>
            <div class="zygr-grid">
              ${field("\u63A5\u53E3\u5730\u5740", "pipeline.text.endpoint")}${field("API Key", "pipeline.text.apiKey", "password")}
              ${field("\u6A21\u578B", "pipeline.text.model")}
            </div>
            <p class="zygr-hint">火山方舟：接口地址填 https://ark.cn-beijing.volces.com/api/v3/chat/completions ，模型名填 doubao-seed-2-1-lite-260915 等；也可填 .../api/v3/responses 使用 Responses 接口。</p>
            <div class="zygr-row"><button class="zygr-btn" data-preset="volc-text">填入火山方舟文本预设</button></div>
            <div class="zygr-row"><button class="zygr-btn" data-test="text">\u6D4B\u8BD5\u6587\u672C\u63A8\u7406</button><span class="zygr-test-status" data-status="text"></span></div>
          </div>

          <h3>\u591A\u6A21\u6001\u670D\u52A1\uFF08\u76F4\u8BC4\u4E0E OCR \u590D\u6838\uFF09</h3>
          <div class="zygr-grid">
            ${field("\u63A5\u53E3\u5730\u5740", "pipeline.vlm.endpoint")}${field("API Key", "pipeline.vlm.apiKey", "password")}
            ${field("\u6A21\u578B", "pipeline.vlm.model")}
          </div>
          <p class="zygr-hint">火山方舟：接口地址必须填完整地址 https://ark.cn-beijing.volces.com/api/v3/chat/completions（Chat API，推荐），或 https://ark.cn-beijing.volces.com/api/v3/responses（Responses API）；只填 https://ark.cn-beijing.volces.com/api/v3 基础地址会返回 404。模型名可用 doubao-seed-2-1-lite-260915、doubao-seed-2-1-turbo-260628 等视觉理解模型。</p>
          <div class="zygr-row"><button class="zygr-btn" data-preset="volc-vlm">填入火山方舟多模态预设</button></div>
          <div class="zygr-row"><button class="zygr-btn" data-test="vlm">\u6D4B\u8BD5\u591A\u6A21\u6001</button><span class="zygr-test-status" data-status="vlm"></span></div>
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
        <button class="zygr-btn zygr-ghost" data-act="reset">\u91CD\u7F6E\u9ED8\u8BA4</button>
        <button class="zygr-btn zygr-ghost" data-act="clear">\u6E05\u7A7A\u6570\u636E</button>
        <button class="zygr-btn" data-act="cancel">\u5173\u95ED</button>
        <button class="zygr-btn zygr-primary" data-act="save">\u4FDD\u5B58\u914D\u7F6E</button>
      </div>
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
          const kind = preset.dataset.preset;
          const arkEndpoint = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
          const arkModel = "doubao-seed-2-1-lite-260915";
          if (kind === "siliconflow-ocr") {
            setField("pipeline.ocr.endpoint", "https://api.siliconflow.cn/v1/chat/completions");
            setField("pipeline.ocr.model", "deepseek-ai/DeepSeek-OCR");
            this.toast("\u5DF2\u586B\u5165\u7845\u57FA\u6D41\u52A8 OCR \u9884\u8BBE\uFF0C\u8BF7\u8865 API Key");
          } else if (kind === "volc-ocr") {
            setField("pipeline.ocr.endpoint", arkEndpoint);
            setField("pipeline.ocr.model", arkModel);
            this.toast("已填入火山方舟 OCR 预设，请补 API Key");
          } else if (kind === "volc-text") {
            setField("pipeline.text.endpoint", arkEndpoint);
            setField("pipeline.text.model", arkModel);
            this.toast("已填入火山方舟文本预设，请补 API Key");
          } else if (kind === "volc-vlm") {
            setField("pipeline.vlm.endpoint", arkEndpoint);
            setField("pipeline.vlm.model", arkModel);
            this.toast("已填入火山方舟多模态预设，请补 API Key");
          }
          return;
        }
        const test = target.closest("[data-test]");
        if (test) {
          void this.test(test.dataset.test);
          return;
        }
        const action = target.closest("[data-act]")?.dataset.act;
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
        if (target.dataset.field === "pipeline.pipeline") this.syncPipelineVisibility();
      });
    }
    syncPipelineVisibility() {
      const select = this.shadow.querySelector('[data-field="pipeline.pipeline"]');
      const isVlm = select?.value === "vlm";
      this.shadow.querySelectorAll("[data-pipeline-section]").forEach((section) => {
        const kind = section.dataset.pipelineSection;
        section.hidden = isVlm && (kind === "ocr" || kind === "text");
      });
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
        const ok = await this.callbacks.onTest(kind, draft);
        const message = ok ? "\u8FDE\u63A5\u6B63\u5E38" : "\u8FDE\u63A5\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u914D\u7F6E";
        setStatus(message, ok ? "ok" : "bad");
        this.toast(message);
      } catch (error) {
        const message = error instanceof Error ? error.message : "\u8FDE\u63A5\u5931\u8D25";
        setStatus(message, "bad");
        this.toast(message);
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
      this.syncPipelineVisibility();
      this.q(".zygr-overlay").hidden = false;
    }
    hide() {
      this.q(".zygr-overlay").hidden = true;
    }
  };

  // src/main.ts
  function makeTestImage() {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#0f172a";
      ctx.font = "20px sans-serif";
      ctx.fillText("OCR TEST", 24, 56);
    }
    return canvas.toDataURL("image/png");
  }
  function buildLimiter(config) {
    return new RateLimiter({
      maxConcurrent: config.pipeline.maxConcurrent,
      maxRpm: config.pipeline.maxRpm,
      maxTpm: config.pipeline.maxTpm
    });
  }
  function pipelineLabel(config) {
    return config.pipeline.pipeline === "vlm" ? "\u591A\u6A21\u6001\u76F4\u8BC4" : "OCR + \u6587\u672C";
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
      onReviewVlm: () => {
        void runGrade2("vlm");
      },
      onSubmit: () => {
        void submitResult();
      },
      onHistory: () => historyPanel.show(loadHistory()),
      onSettings: () => settingsPanel.show(config)
    });
    const settingsPanel = new SettingsPanel({
      onSave: (draft) => {
        config = draft;
        saveConfig(config);
        cache = new CacheStore(config.cacheTtlDays);
        limiter = buildLimiter(config);
        panel.setCache(pipelineLabel(config));
        panel.setSubtitle("\u914D\u7F6E\u5DF2\u66F4\u65B0");
      },
      onTest: (kind, draft) => testService(kind, draft),
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
    async function testService(kind, draft) {
      const serviceLimiter = buildLimiter(draft);
      const thinkOff = draft.pipeline.disableThinking !== false;
      draft.pipeline.vlm.disableThinking = thinkOff;
      draft.pipeline.ocr.disableThinking = thinkOff;
      draft.pipeline.text.disableThinking = thinkOff;
      if (kind === "ocr") {
        if (draft.pipeline.ocr.provider === "local-http") return Boolean(draft.pipeline.ocr.endpoint.trim());
        await recognizeAnswers({
          images: [makeTestImage()],
          prompt: "\u8BF7\u53EA\u56DE\u590D ok",
          config: draft.pipeline.ocr,
          rateLimiter: serviceLimiter,
          timeoutMs: 15e3
        });
        return true;
      }
      const service = kind === "vlm" ? draft.pipeline.vlm : draft.pipeline.text;
      if (!service.endpoint.trim() || !service.model.trim()) return false;
      return testConnection(service, serviceLimiter);
    }
    async function runGrade2(forcePipeline) {
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
          forcePipeline,
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
    async function submitResult(options = {}) {
      if (!lastResult || !markingDoc) {
        panel.showError("\u8BF7\u5148\u5B8C\u6210\u6279\u6539\u5E76\u8FDB\u5165\u9605\u5377\u9875\u9762");
        return { ok: false, oldIdentity: null };
      }
      const inputs = getScoreInputs(markingDoc);
      const scores = inputs.length > 1 && lastResult.subScores.length === inputs.length ? lastResult.subScores.map((item) => item.score) : [Math.round(lastResult.score * 10) / 10];
      const label = scores.length > 1 ? `\u5404\u5C0F\u9898\u5206\u6570 ${scores.join("\u3001")}` : `${scores[0]} \u5206`;
      if (!options.silent && !window.confirm(`\u786E\u8BA4\u5199\u5165${label}\u5E76\u63D0\u4EA4\uFF1F`)) {
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
      const history = loadHistory().map((entry) => entry.id === lastHistoryId ? { ...entry, submitted: true } : entry);
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
        const changed = await waitForNextPaper(submitted.oldIdentity);
        if (!changed || !autoMode || autoStopRequested) {
          if (autoMode) panel.showError("\u672A\u68C0\u6D4B\u5230\u6362\u5377\uFF0C\u8FDE\u7EED\u6279\u9605\u5DF2\u505C\u6B62");
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
