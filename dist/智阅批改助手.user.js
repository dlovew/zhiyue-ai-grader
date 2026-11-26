// ==UserScript==
// @name         智阅批改助手
// @namespace    zygr.local.grader
// @version      1.0.5
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
    const domId = normalizeQuestion(scoringQuestion) || normalizeQuestion(heading) || new URLSearchParams(window.location.search).get("topicId") || "\u5F53\u524D\u9898\u76EE";
    // 接口的 topicNumStr（如 43,1）比 DOM 文本更规范，优先作为题号，两者都保留。
    const hookTopic = hookCurrentField("topicNumStr");
    const topicNumStr = hookTopic ? String(hookTopic).trim() : domId;
    const maxScore = resolveMaxScore(doc) || inputs.reduce((sum, input) => sum + input.maxScore, 0);
    const subQuestions = inputs.length > 1 ? inputs.map((input) => ({ label: input.label, maxScore: input.maxScore })) : [];
    return {
      questionId: topicNumStr,
      topicNumStr,
      questionText: heading,
      maxScore,
      subQuestions,
      images: answerSnapshot(doc).urls
    };
  }
  // 接口优先的当前题字段：观察器没装或没数据时返回 null，由调用方退回 DOM。
  function hookCurrentField(key) {
    try {
      if (typeof currentHookIdentity !== "function") return null;
      const value = currentHookIdentity()?.[key];
      return value === void 0 || value === null || value === "" ? null : value;
    } catch {
      return null;
    }
  }
  function resolveMaxScore(doc) {
    const observed = Number(hookCurrentField("subTopicScore"));
    if (Number.isFinite(observed) && observed > 0) return observed;
    const maxima = getScoreInputs(doc).map((input) => input.maxScore).filter((value) => value > 0);
    return maxima.reduce((sum, value) => sum + value, 0);
  }
  function currentScanRecordId() {
    return String(hookCurrentField("scanRecordId") || "");
  }
  // 满分以页面/接口为准：不再阻断批改，由上层自动写回配置并提示一行。
  function checkMaxScore(configured2, doc) {
    const maxScore = resolveMaxScore(doc);
    return { maxScore, mismatch: maxScore > 0 && Math.abs(maxScore - Number(configured2 || 0)) > 1e-6 };
  }
  // 提交回执：接口观察器装上后写入，未装上时保持未激活，提交沿用「点过即提交」的旧行为。
  var commitFeed = { active: false, last: null, resetAt: 0 };
  // 这些按钮会把卷子直接判成满分/零分/问题卷，点错一次就是错卷，永远不碰。
  var FORBIDDEN_BUTTON = /\u6EE1\u5206|\u96F6\u5206|\u95EE\u9898\u5377|\u4F11\u5377|\u4F5C\u5E9F/;
  function hookActive() {
    return commitFeed.active;
  }
  function markHookActive() {
    commitFeed.active = true;
  }
  function pushCommitSignal(result) {
    commitFeed.active = true;
    commitFeed.last = { ok: String(result || "").toLowerCase() === "success", result: String(result || ""), at: Date.now() };
  }
  function resetCommitSignal() {
    commitFeed.last = null;
    // 回执可能比 waitCommitSignal 更早到达（本地很快），以重置时刻为基线判断新旧。
    commitFeed.resetAt = Date.now();
  }
  async function waitCommitSignal(timeout = 2500) {
    const startedAt = Date.now();
    const since = commitFeed.resetAt;
    while (Date.now() - startedAt < timeout) {
      if (commitFeed.last && commitFeed.last.at >= since) return commitFeed.last;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    return null;
  }
  // 填分 + 回读：页面上的输入框可能被框架改回原值，写不进去就不能假装提交成功。
  function fillScores(scores, doc) {
    const inputs = getScoreInputs(doc);
    if (inputs.length === 0 || scores.length > inputs.length) return { ok: false, error: "\u672A\u627E\u5230\u6253\u5206\u8F93\u5165\u6846" };
    for (let i = 0; i < inputs.length; i += 1) {
      const score = scores[i];
      if (score === void 0 || score === null || !Number.isFinite(Number(score))) {
        return { ok: false, error: `\u7B2C ${i + 1} \u4E2A\u5206\u6570\u4E0D\u662F\u6709\u6548\u6570\u5B57` };
      }
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) return { ok: false, error: "\u6253\u5206\u6846\u4E0D\u53EF\u5199" };
    for (let i = 0; i < inputs.length; i += 1) {
      const input = inputs[i].element;
      const target = Math.round(Number(scores[i]) * 10) / 10;
      setter.call(input, String(target));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      // 回读校验：值不一致说明页面拒收或被其它脚本覆盖，必须中止。
      if (String(input.value).trim() === "" || Number(input.value) !== target) {
        return { ok: false, error: `\u7B2C ${i + 1} \u4E2A\u6253\u5206\u6846\u56DE\u8BFB\u4E0D\u4E00\u81F4\uFF08\u671F\u671B ${target}\uFF0C\u5B9E\u9645 ${input.value}\uFF09` };
      }
    }
    return { ok: true, error: "" };
  }
  function submitGrade(doc) {
    const iframe = getIframeDoc();
    const candidates = [iframe, doc, mainDoc()].filter((item, index, all) => Boolean(item) && all.indexOf(item) === index);
    for (const root of candidates) {
      const byText = Array.from(root.querySelectorAll("button")).find((button2) => {
        const text = button2.textContent || "";
        return !FORBIDDEN_BUTTON.test(text) && text.includes(SELECTORS.submitText);
      });
      const button = root.querySelector(SELECTORS.submitButton) ?? byText;
      if (button && !FORBIDDEN_BUTTON.test(button.textContent || "")) {
        button.click();
        return true;
      }
    }
    return false;
  }
  function getPaperIdentity() {
    return answerSnapshot().identity;
  }
  async function waitForNextPaper(oldIdentity, oldScan = "", timeout = 25e3) {
    if (!oldIdentity && !oldScan) return false;
    const startedAt = Date.now();
    // 主判据（scanRecordId 变化）只在前 8 秒内生效：接口没反应就退回图片判定。
    const scanWindow = 8e3;
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
      if (oldScan && now - startedAt <= scanWindow) {
        const nextScan = currentScanRecordId();
        if (nextScan && nextScan !== oldScan) return true;
      }
      if (!oldIdentity) {
        await new Promise((resolve) => window.setTimeout(resolve, 200));
        continue;
      }
      const snapshot = answerSnapshot();
      // 兜底：图片 URL 集合变化并连续两次稳定（后台标签页图片常未 complete，不要求加载完成）。
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

// src/adapters/zhixue-hook.ts
// 只读接口观察器：包装 iframe 里的 XMLHttpRequest，只解析三个接口的响应体。
// 不改写请求、不重发、不影响原有回调；任何异常都静默降级到 DOM 判定。
var ZHIXUE_HOOK_FLAG = "__zygrHooked";
var HOOK_COMMIT = /commitTopic/i;
var HOOK_NEXT = /preLoadScanrecorddetail/i;
var HOOK_CURRENT = /scanrecorddetail/i;
var hookState = { installed: false, doc: null, current: null, next: null, updatedAt: 0 };

// 平台响应层级不固定，按字段名深搜第一个非空值即可，别假设固定路径。
function hookField(node, key, depth = 0) {
  if (!node || depth > 4) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = hookField(item, key, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  const own = node[key];
  if (own !== void 0 && own !== null && own !== "") return own;
  for (const value of Object.values(node)) {
    const hit = hookField(value, key, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}
function hookIdentity(body) {
  return {
    scanRecordId: hookField(body, "scanRecordId"),
    topicNumStr: hookField(body, "topicNumStr"),
    userCode: hookField(body, "userCode"),
    subTopicScore: hookField(body, "subTopicScore"),
    topicImageIds: hookField(body, "topicImageIds"),
    paperImgIds: hookField(body, "paperImgIds"),
    hasPrev: hookField(body, "hasPrev"),
    hasNext: hookField(body, "hasNext")
  };
}
// 从接口字段里捞出 http(s) 图片地址（签名 URL 只有几分钟有效期，需要时才算）。
function hookUrlsFrom(value, out) {
  if (!value || out.length >= 12) return out;
  if (typeof value === "string") {
    if (/^https?:\/\/\S+$/i.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) hookUrlsFrom(item, out);
    return out;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) hookUrlsFrom(item, out);
  }
  return out;
}
function handleHookResponse(url, text) {
  if (!url || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return false;
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return false;
  }
  const body = data && typeof data === "object" && data.data !== void 0 ? data.data : data;
  // 提交回执：优先看 result，兼容只有 success 的写法。
  if (HOOK_COMMIT.test(url)) {
    const result = hookField(body, "result");
    const success = hookField(body, "success");
    pushCommitSignal(typeof result === "string" ? result : success === true ? "success" : "");
    return true;
  }
  // preLoad 的地址里也含 scanrecorddetail，必须先判 next。
  if (HOOK_NEXT.test(url)) {
    hookState.next = hookIdentity(body);
    hookState.updatedAt = Date.now();
    return true;
  }
  if (HOOK_CURRENT.test(url)) {
    hookState.current = hookIdentity(body);
    hookState.updatedAt = Date.now();
    return true;
  }
  return false;
}
function installZhixueHook(doc) {
  let win = null;
  try {
    win = doc?.defaultView || null;
  } catch {
    return false;
  }
  if (!win || !win.XMLHttpRequest) return false;
  const proto = win.XMLHttpRequest.prototype;
  try {
    if (proto[ZHIXUE_HOOK_FLAG]) {
      hookState.installed = true;
      hookState.doc = doc;
      markHookActive();
      return true;
    }
  } catch {
    return false;
  }
  const originalOpen = proto.open;
  const originalSend = proto.send;
  proto.open = function (method, url, ...rest) {
    try {
      this.__zygrUrl = typeof url === "string" ? url : String(url || "");
    } catch { /* 记录 URL 失败不影响原请求 */ }
    return originalOpen.call(this, method, url, ...rest);
  };
  proto.send = function (...args) {
    try {
      this.addEventListener("loadend", () => {
        try {
          const text = typeof this.responseText === "string"
            ? this.responseText
            : typeof this.response === "string" ? this.response : "";
          handleHookResponse(this.__zygrUrl, text);
        } catch { /* 解析失败按未捕获处理 */ }
      });
    } catch { /* 挂不上 loadend 就降级 */ }
    return originalSend.apply(this, args);
  };
  try {
    proto[ZHIXUE_HOOK_FLAG] = true;
  } catch {
    return false;
  }
  hookState.installed = true;
  hookState.doc = doc;
  markHookActive();
  return true;
}
// iframe 被替换后 hook 随旧 window 一起消失，每次拿到阅卷文档都要校验一次。
function ensureZhixueHook(doc) {
  if (!doc) return false;
  try {
    if (hookState.installed && hookState.doc === doc && doc.defaultView?.XMLHttpRequest?.prototype?.[ZHIXUE_HOOK_FLAG]) return true;
  } catch { /* 跨域访问失败则重新装 */ }
  return installZhixueHook(doc);
}
function currentHookIdentity() {
  return hookState.current;
}
function nextHookIdentity() {
  return hookState.next;
}
// 缓存/换卷用的稳定身份：台账号 + 题号，跨账号一致，不含签名。
function hookIdentityKey() {
  const current = hookState.current;
  if (!current || !current.scanRecordId) return "";
  return `${current.scanRecordId}|${current.topicNumStr || ""}`;
}
function freshAnswerImages() {
  const urls = [];
  hookUrlsFrom(hookState.current?.topicImageIds, urls);
  if (urls.length === 0) hookUrlsFrom(hookState.current?.paperImgIds, urls);
  if (urls.length === 0) hookUrlsFrom(hookState.next?.topicImageIds, urls);
  return [...new Set(urls)];
}
  // src/infra/storage.ts
  var STORAGE_KEYS = {
    config: "zygr.config.v1",
    history: "zygr.history.v1",
    cache: "zygr.cache.v1",
    stats: "zygr.stats.v1",
    thinkingForced: "zygr.thinking-forced.v1"
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
      outputMode: "standard",
      maxConcurrent: 2,
      maxRpm: 60,
      maxTpm: 6e4,
      timeoutMs: 12e4
    },
    context: {
      question: "",
      answer: "",
      rubric: "",
      maxScore: 0,
      subject: ""
    },
    image: {
      // 图片只做等比缩小：裁切、切条重排、多图合并都会改变版面或牺牲单页分辨率。
      maxEdge: 1600,
      quality: 0.82,
      detail: "high",
      autoBySubject: true
    },
    promptVersion: "zygr-prompt-v2",
    historyLimit: 500,
    cacheTtlDays: 30,
    cacheMaxEntries: 2000
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
    // merge 只接受默认配置里存在的键，旧版本遗留的裁切/切条/合并开关会被自动丢弃。
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
    removeKey(STORAGE_KEYS.stats);
    removeKey(STORAGE_KEYS.thinkingForced);
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
// src/core/submit.ts
// 提交结果判定：接口观察器可用时以平台回执为准；没有观察能力时退回「点过即提交」的旧行为，
// 保证观察器没装上、接口改版或 iframe 跨域时不会把整条提交链路卡死。
function judgeSubmit(hookActive2, signal) {
  if (!hookActive2) return { ok: true, confirmed: false, reason: "" };
  // 观察器活着但没等到 commitTopic 回执：分数很可能没写进平台，宁可让老师看一眼。
  if (!signal) {
    return {
      ok: false,
      confirmed: false,
      reason: "\u672A\u6536\u5230\u5E73\u53F0\u63D0\u4EA4\u56DE\u6267\uFF0C\u5206\u6570\u53EF\u80FD\u672A\u5199\u5165\uFF0C\u8BF7\u68C0\u67E5\u6253\u5206\u6846\u540E\u91CD\u8BD5"
    };
  }
  if (signal.ok === true) return { ok: true, confirmed: true, reason: "" };
  return {
    ok: false,
    confirmed: false,
    reason: `\u5E73\u53F0\u62D2\u7EDD\u63D0\u4EA4\uFF1A${signal.result || "\u672A\u77E5\u539F\u56E0"}`
  };
}
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
  // 用量与命中：旧记录可能没有 usage / cacheHit，这里统一兜底为 0 与 false。
  function entryUsage(entry) {
    const usage = entry?.result?.usage || {};
    return {
      prompt: Number(usage.prompt || 0),
      cached: Number(usage.cached || 0),
      completion: Number(usage.completion || 0),
      reasoning: Number(usage.reasoning || 0)
    };
  }
  function entryElapsed(entry) {
    return (Number(entry?.result?.elapsedMs || 0) / 1e3).toFixed(1);
  }
  function entryHitText(entry) {
    if (entry?.result?.cacheHit) return "\u672C\u5730\u547D\u4E2D";
    return entryUsage(entry).cached > 0 ? "\u524D\u7F00\u547D\u4E2D" : "\u672A\u547D\u4E2D";
  }
  function percentText(value, total) {
    return total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
  }
  // 汇总只在本地相加历史记录里的用量，不产生任何请求。
  function summarizeEntries(entries) {
    const total = entries.length;
    const hits = entries.filter((entry) => Boolean(entry?.result?.cacheHit)).length;
    const totals = { prompt: 0, cached: 0, completion: 0, reasoning: 0 };
    for (const entry of entries) {
      const usage = entryUsage(entry);
      totals.prompt += usage.prompt;
      totals.cached += usage.cached;
      totals.completion += usage.completion;
      totals.reasoning += usage.reasoning;
    }
    return {
      total,
      hits,
      hitRate: percentText(hits, total),
      prompt: totals.prompt,
      cached: totals.cached,
      cacheRate: percentText(totals.cached, totals.prompt),
      completion: totals.completion,
      reasoning: totals.reasoning
    };
  }
  function summaryText(entries) {
    const summary = summarizeEntries(entries);
    const reasoning = summary.reasoning ? `\uFF08\u542B\u601D\u8003 ${summary.reasoning}\uFF09` : "";
    return `\u5171 ${summary.total} \u6761 \xB7 \u672C\u5730\u547D\u4E2D ${summary.hits} \u6B21\uFF08${summary.hitRate}\uFF09 \xB7 \u8F93\u5165 ${summary.prompt} token\uFF08\u524D\u7F00\u547D\u4E2D ${summary.cached}\uFF0C${summary.cacheRate}\uFF09 \xB7 \u8F93\u51FA ${summary.completion} token${reasoning}`;
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
      "\u8F93\u5165 Token",
      "\u524D\u7F00\u547D\u4E2D Token",
      "\u8F93\u51FA Token",
      "\u601D\u8003 Token",
      "\u547D\u4E2D",
      "\u8017\u65F6\uFF08\u79D2\uFF09"
    ];
    const rows = entries.map((entry) => {
      const usage = entryUsage(entry);
      return [
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
        usage.prompt,
        usage.cached,
        usage.completion,
        usage.reasoning,
        entryHitText(entry),
        entryElapsed(entry)
      ];
    });
    const summary = summarizeEntries(entries);
    // 末尾追加一行汇总：第 3～12 列是逐条字段，留空避免与逐条数据混读；只填合计列。
    const summaryRow = [
      "\u6C47\u603B",
      `\u5171 ${summary.total} \u6761`,
      // 时间到已提交共 10 列留空（第 3～12 列）
      "", "", "", "", "", "", "", "", "", "",
      summary.prompt,
      summary.cached,
      summary.completion,
      summary.reasoning,
      `\u672C\u5730\u547D\u4E2D ${summary.hits} \u6B21\uFF08${summary.hitRate}\uFF09`,
      ""
    ];
    return `\uFEFF${[header, ...rows, summaryRow].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function toHtml(entries) {
    const rows = entries.map((entry) => {
      const usage = entryUsage(entry);
      return `
     <tr>
       <td>${escapeHtml(new Date(entry.createdAt).toLocaleString("zh-CN"))}</td>
       <td>${escapeHtml(entry.question.questionId)}</td>
       <td>${escapeHtml(entry.result.pipeline)}</td>
       <td>${escapeHtml(entry.result.model)}</td>
       <td>${escapeHtml(entry.result.status)}</td>
       <td>${escapeHtml(entry.result.score)} / ${escapeHtml(entry.result.maxScore)}</td>
       <td>${escapeHtml(subScoreText(entry))}</td>
       <td>${escapeHtml(entry.result.reason)}</td>
       <td>${escapeHtml(usage.prompt)}</td>
       <td>${escapeHtml(usage.cached)}</td>
       <td>${escapeHtml(usage.completion)}</td>
       <td>${escapeHtml(usage.reasoning)}</td>
       <td>${escapeHtml(entryHitText(entry))}</td>
       <td>${escapeHtml(entryElapsed(entry))}</td>
       <td>${entry.result.needsReview ? "\u9700\u590D\u6838" : "\u6B63\u5E38"}</td>
     </tr>`;
    }).join("");
    return `<!doctype html>
  <html lang="zh-CN"><head><meta charset="utf-8"><title>\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u5386\u53F2\u5BFC\u51FA</title>
  <style>
  body{font:14px/1.6 "PingFang SC",sans-serif;color:#0f172a;background:#f8fafc;margin:24px}
  h1{font-size:20px;margin:0 0 16px}table{width:100%;border-collapse:collapse;background:#fff}
  th,td{border:1px solid #e2e8f0;padding:8px;vertical-align:top;text-align:left}
  th{background:#eef2ff;color:#3730a3}tr:nth-child(even){background:#f8fafc}
  .zygr-summary{margin:0 0 14px;padding:10px 12px;border-radius:10px;background:#eef2ff;color:#3730a3;font-size:13px}
  </style></head><body><h1>\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u5386\u53F2\u5BFC\u51FA</h1>
  <p class="zygr-summary">${escapeHtml(summaryText(entries))}</p>
  <table><thead><tr><th>\u65F6\u95F4</th><th>\u9898\u53F7</th><th>\u94FE\u8DEF</th><th>\u6A21\u578B</th><th>\u72B6\u6001</th><th>\u5F97\u5206</th><th>\u5C0F\u9898\u5206</th><th>\u4F9D\u636E</th><th>\u8F93\u5165 Token</th><th>\u524D\u7F00\u547D\u4E2D</th><th>\u8F93\u51FA Token</th><th>\u601D\u8003 Token</th><th>\u547D\u4E2D</th><th>\u8017\u65F6\uFF08\u79D2\uFF09</th><th>\u6807\u8BB0</th></tr></thead><tbody>${rows}</tbody></table>
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

  // 思考强度档位名称：各平台可选项不同，统一取这套标签。
  var THINKING_LEVEL_LABELS = {
    off: "\u5173\u95ED\u601D\u8003",
    auto: "\u6A21\u578B\u9ED8\u8BA4\uFF08\u4E0D\u4F20\u5F3A\u5EA6\u53C2\u6570\uFF09",
    minimal: "minimal \u6700\u4F4E",
    low: "low \u4F4E",
    medium: "medium \u4E2D",
    high: "high \u9AD8",
    xhigh: "xhigh \u6781\u9AD8",
    max: "max \u6700\u9AD8"
  };

  // 内置预设只提供建议端点/模型与协议档案；用户已填写的 endpoint / model / apiKey 始终优先。
  // authHeader: bearer | api-key | none；全部请求统一为 Chat Completions。
  // 思考只暴露「关闭 / 模型默认」两档；thinkingFields 是各平台强度到请求字段的映射。
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
      id: "deepseek",
      label: "DeepSeek",
      endpoint: "https://api.deepseek.com/chat/completions",
      models: ["deepseek-flash", "deepseek-v4-pro"],
      authHeader: "bearer",
      // 官方文档（2026）：thinking.type 控制开关，reasoning_effort 取 none|low|high|max，
      // 省略即"模型默认"（默认开启思考）；minimal→low、medium/xhigh→high。
      thinkingFields: {
        off: { reasoning_effort: "none" },
        low: { reasoning_effort: "low" },
        high: { reasoning_effort: "high" },
        max: { reasoning_effort: "max" }
      },
      disableThinkingKey: "thinking",
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "sensenova",
      label: "商汤日日新（SenseNova）",
      // 官方示例：POST https://token.sensenova.cn/v1/chat/completions，Bearer 鉴权。
      endpoint: "https://token.sensenova.cn/v1/chat/completions",
      models: ["sensenova-6.8-flash"],
      authHeader: "bearer",
      // 模型列表与推理同域：GET https://token.sensenova.cn/v1/models。
      modelsEndpoint: "https://token.sensenova.cn/v1/models",
      // 官方文档：thinking.type 控制开关（默认 enabled），reasoning_effort 取 low~max、默认 high，
      // 且 reasoning_effort 设为 none 即可关闭思考。这里统一用单一字段关闭，少一个参数少一分风险。
      thinkingFields: {
        off: { reasoning_effort: "none" },
        minimal: { reasoning_effort: "minimal" },
        low: { reasoning_effort: "low" },
        medium: { reasoning_effort: "medium" },
        high: { reasoning_effort: "high" },
        xhigh: { reasoning_effort: "xhigh" },
        max: { reasoning_effort: "max" }
      },
      disableThinkingKey: null,
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
      thinkingFields: { off: { thinking: { type: "disabled" } } },
      disableThinkingKey: "thinking",
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "dashscope",
      label: "通义千问 / DashScope",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      models: ["qwen-vl-max", "qwen-vl-plus", "qwen-plus"],
      authHeader: "bearer",
      thinkingFields: { off: { enable_thinking: false } },
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
      // 智谱官方格式：thinking.type 只接受 enabled（glm-5.x 强制思考），
      // 强度由独立的 reasoning_effort 字段控制（low/high/max，默认 max）。
      // 关闭写了 disabled 会触发错误码 1210「该模型始终思考，不支持关闭思考」，
      // 所以该平台的「关闭」不注入参数（等同模型默认），避免 400 重试。
      disableThinkingKey: null,
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
      thinkingFields: { off: { thinking: { type: "disabled" } } },
      disableThinkingKey: "thinking",
      jsonModeKey: "response_format",
      stream: false
    },
  ];

  // 同一平台的不同模型支持的强度档位并不一致，因此界面统一只给「关闭」与「模型默认」两档；
  // thinkingFields 里保留各平台的强度映射，供底层与将来扩展使用。
  var THINKING_LEVELS = ["off", "auto"];
  function getPlatformThinkingLevels() {
    return THINKING_LEVELS.slice();
  }

  function thinkingLevelLabel(level) {
    return THINKING_LEVEL_LABELS[level] || String(level);
  }

  // 只允许两档：关闭(off) 与 不指定强度(auto)；历史配置里的 low/high/max 一律收敛为 auto。
  function clampThinkingLevel(id, value) {
    const mode = String(value || "").trim().toLowerCase();
    return THINKING_LEVELS.indexOf(mode) >= 0 ? mode : "auto";
  }

  // 能否关闭思考取决于模型，而不是平台：这里维护"强制思考"的已知名单，
  // 同时把运行时踩到的 400 结果记下来，避免每次批改都先失败一次。
  var FORCED_THINKING_PATTERNS = [/^glm-5\.3(?:$|[-_.])/i];
  function loadForcedThinking() {
    const raw = readJson(STORAGE_KEYS.thinkingForced, {});
    return isRecord(raw) ? raw : {};
  }
  function markForcedThinking(platformId, model) {
    const name = String(model || "").trim();
    if (!name) return false;
    const map = loadForcedThinking();
    const key = `${String(platformId || "custom")}|${name}`;
    if (map[key]) return true;
    map[key] = Date.now();
    return writeJson(STORAGE_KEYS.thinkingForced, map);
  }
  function isForcedThinkingModel(platformId, model) {
    const name = String(model || "").trim();
    if (!name) return false;
    if (FORCED_THINKING_PATTERNS.some((pattern) => pattern.test(name))) return true;
    return Boolean(loadForcedThinking()[`${String(platformId || "custom")}|${name}`]);
  }

  function normalizeThinkingValues(value) {
    if (!isRecord(value)) return {};
    const result = {};
    // 覆盖所有平台可能出现的档位，否则 minimal/medium/xhigh 会被丢掉。
    for (const mode of ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"]) {
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
    return BUILTIN_PLATFORM_PRESETS.slice();
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

  // 已下线的内置平台：预设条目已删除，这里只保留鉴权方式，避免历史配置静默退回 bearer 而失效。
  var LEGACY_PLATFORM_AUTH = { "azure-openai": "api-key" };

  // 把平台预设与服务上的手动覆盖合并成统一的请求档案。
  // 显式字段（service.endpoint / service.model）优先，预设只在其为空时提供建议值。
  function resolveProfile(service) {
    const src = isRecord(service) ? service : {};
    const preset = getPlatformPreset(src.platform) || getPlatformPreset("custom") || {};
    const compat = isRecord(src.compat) ? src.compat : {};
    const legacyAuth = LEGACY_PLATFORM_AUTH[String(src.platform || "")];
    const authHeader = ["bearer", "api-key", "none"].includes(compat.authHeader) ? compat.authHeader : (legacyAuth || preset.authHeader || "bearer");
    return {
      id: preset.id || "custom",
      label: preset.label || "自定义",
      endpoint: normalizeEndpoint(String(src.endpoint || preset.endpoint || "")),
      model: String(src.model || ""),
      models: Array.isArray(preset.models) ? preset.models : [],
      // 个别平台的模型列表接口与推理接口不同域，预设可单独指定。
      modelsUrl: String(preset.modelsEndpoint || "").trim(),
      thinkingLevels: getPlatformThinkingLevels(preset.id),
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
      let settled = false;
      let timer = 0;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) window.clearTimeout(timer);
        fn(value);
      };
      const request = GM_xmlhttpRequest({
        ...details,
        onload: (response) => {
          // 少数油猴实现会在异常路径下不传 response，这里兜底避免 "reading 'status'" 之类报错。
          const status = Number(response?.status || 0);
          if (status >= 200 && status < 300) return finish(resolve, response);
          finish(reject, createApiError(status, response?.responseText || "", response));
        },
        onerror: (response) => {
          const detail = response?.error ? `\uFF1A${response.error}` : "";
          finish(reject, new Error(`\u7F51\u7EDC\u9519\u8BEF\uFF08HTTP ${response?.status || 0}\uFF09${detail}`));
        },
        ontimeout: () => finish(reject, new Error("\u8BF7\u6C42\u8D85\u65F6"))
      });
      // 本地硬超时兜底：油猴少数实现不回调 ontimeout 时，仍保证 promise 结束、按钮不卡在"测试中"。
      const limit = Number(details.timeout) || 12e4;
      timer = window.setTimeout(() => {
        finish(reject, new Error("\u8BF7\u6C42\u8D85\u65F6\uFF08\u672C\u5730\u4FDD\u62A4\uFF09"));
        try { request?.abort?.(); } catch { /* 忽略中止失败 */ }
      }, limit + 2e3);
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

  var THINKING_MODES = ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"];
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

  // 读取响应里的用量：DeepSeek 用 prompt_cache_hit_tokens，
  // 其他 OpenAI 兼容平台用 prompt_tokens_details.cached_tokens。无 usage 时返回 null。
  function extractUsage(body) {
    const usage = body?.usage || {};
    const details = usage.prompt_tokens_details || {};
    const prompt = Number(usage.prompt_tokens ?? 0) || 0;
    const completion = Number(usage.completion_tokens ?? 0) || 0;
    const cached = Number(usage.prompt_cache_hit_tokens ?? details.cached_tokens ?? 0) || 0;
    const reasoning = Number(usage.completion_tokens_details?.reasoning_tokens ?? 0) || 0;
    if (!prompt && !completion && !cached) return null;
    return { prompt, completion, cached, reasoning };
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
    // 输出 token 按更高单价计费，限制上限可挡住模型絮叨产生的长尾。
    if (options.maxTokens > 0) payload.max_tokens = Math.round(options.maxTokens);
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
        const body = parseJsonResponse(response.responseText);
        // 思考占满输出预算时正文会被截断：这种结果不能用，整次作废，别把空正文当零分。
        if (body?.choices?.[0]?.finish_reason === "length") {
          const truncated = new Error("\u6A21\u578B\u8F93\u51FA\u88AB\u957F\u5EA6\u4E0A\u9650\u622A\u65AD\uFF08finish_reason=length\uFF09\uFF0C\u672C\u6B21\u7ED3\u679C\u4F5C\u5E9F\uFF1A\u8BF7\u8C03\u9AD8\u8F93\u51FA\u6863\u4F4D\u3001\u5173\u95ED\u601D\u8003\u6216\u7F29\u77ED\u8BC4\u5206\u6807\u51C6");
          truncated.code = "truncated";
          throw truncated;
        }
        const content = extractContent(body);
        // usage 是响应自带字段，读取它不会产生任何额外 token。
        if (typeof options.onUsage === "function") {
          try {
            options.onUsage(extractUsage(body));
          } catch { /* 回调异常不影响批改 */ }
        }
        if (typeof content === "string" && content) return content;
        throw new Error("\u63A5\u53E3\u54CD\u5E94\u7F3A\u5C11\u6587\u672C\u5185\u5BB9");
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (lastError.status === 400 || lastError.status === 422) {
          let relaxed = false;
          if (jsonInjectedKey) {
            delete payload[jsonInjectedKey];
            jsonInjectedKey = null;
            relaxed = true;
          }
          // 仅「关闭」模式可降级重试；low/high/max 是用户明确选择，降级会静默改变意图。
          if (thinkingKeys.length && thinkingMode === "off") {
            // 仅当报错像是"该模型不支持关闭思考"时才记下模型能力，
            // 避免把其它 400（如参数拼写）误记成强制思考。
            if (/thinking|reasoning|思考|1210/i.test(lastError.message || "")) {
              try {
                options.onThinkingForced?.(profile.model);
              } catch { /* 记忆失败不影响重试 */ }
            }
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

  // 拉取平台可用模型列表；返回模型 ID 字符串数组。
  // 平台没有 /models 端点（GET 返回 405 等）或返回空列表时不做预设回退：
  // 返回空数组并带 manual 标记与提示文案，由界面提示用户手动填写模型名称。
  var MODELS_UNSUPPORTED_MESSAGE = "\u8BE5\u5E73\u53F0\u4E0D\u652F\u6301\u5728\u7EBF\u83B7\u53D6\u6A21\u578B\u5217\u8868\uFF0C\u8BF7\u624B\u52A8\u586B\u5199\u6A21\u578B\u540D\u79F0";
  async function fetchModels(service, timeoutMs = 15e3) {
    const profile = resolveProfile(service);
    // 有些平台（如商汤日日新）的模型列表在独立主机上，预设可覆盖。
    const url = String(profile.modelsUrl || "").trim() || modelsEndpoint(profile.endpoint);
    if (!url) throw new Error("\u8BF7\u5148\u586B\u5199\u63A5\u53E3\u5730\u5740");
    const headers = { "Content-Type": "application/json" };
    if (profile.authHeader === "api-key") headers["api-key"] = profile.apiKey;
    else if (profile.authHeader === "bearer") headers.Authorization = `Bearer ${profile.apiKey}`;
    const manualOnly = (message) => {
      const result = [];
      result.manual = true;
      result.message = message;
      return result;
    };
    let response;
    try {
      response = await gmRequest({ method: "GET", url, headers, timeout: timeoutMs });
    } catch (error) {
      if (error?.status === 405 || error?.status === 404 || error?.status === 400) return manualOnly(MODELS_UNSUPPORTED_MESSAGE);
      throw error;
    }
    const body = parseJsonResponse(response.responseText);
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body?.result) ? body.result : [];
    // 支持图片输入的模型排前面（阅卷必须用视觉模型），其余保持平台返回顺序。
    const entries = list.map((item) => {
      if (typeof item === "string") return { id: item, vision: false };
      const modalities = Array.isArray(item?.input_modalities) ? item.input_modalities : [];
      return { id: item?.id, vision: modalities.includes("image") };
    }).filter((entry) => typeof entry.id === "string" && entry.id.trim());
    entries.sort((a, b) => Number(b.vision) - Number(a.vision));
    const ids = entries.map((entry) => entry.id);
    if (!ids.length) return manualOnly("\u63A5\u53E3\u672A\u8FD4\u56DE\u53EF\u7528\u6A21\u578B\u5217\u8868\uFF0C\u8BF7\u624B\u52A8\u586B\u5199\u6A21\u578B\u540D\u79F0");
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
    const wantedMode = normalizeThinkingMode(service.thinkingMode !== void 0 ? service.thinkingMode : service.disableThinking);
    // 强制思考的模型（如 glm-5.3 系列）直接按默认走，避免关闭参数触发 1210/400。
    const forcedByModel = wantedMode === "off" && isForcedThinkingModel(service.platform || profile.id, profile.model);
    const thinkingMode = forcedByModel ? "auto" : wantedMode;
    const thinkingKeys = thinkingControl(payload, profile, thinkingMode);
    const headers = { "Content-Type": "application/json" };
    if (profile.authHeader === "api-key") headers["api-key"] = profile.apiKey;
    else if (profile.authHeader === "bearer") headers.Authorization = `Bearer ${profile.apiKey}`;
    // 推理模型（如 Qwen3.5-27B）默认长链思考需要时间，但不跟随可能设得很大的批改超时：
    // 测试走独立固定超时（最多 60 秒），且不经过限流器（限流 acquire 在低 TPM 预算下会无限等待，卡住按钮）。
    const probeTimeout = 6e4;
    const response = await gmRequest({ method: "POST", url: profile.endpoint, headers, data: JSON.stringify(payload), timeout: probeTimeout });
    const body = parseJsonResponse(response.responseText);
    const reasoning = detectReasoning(body);
    const hasThinking = reasoning.fields.length > 0 || reasoning.tokens > 0;
    const injected = thinkingKeys.length ? thinkingKeys.join(" / ") : "";
    let verdict;
    let ok;
    if (thinkingMode === "auto") {
      ok = true;
      verdict = forcedByModel
        ? "该模型强制思考、不支持关闭，已按模型默认运行"
        : "未干预思考模式，将使用模型默认设置";
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
  // 学科策略：公式/符号密集的学科保分辨率；文字为主的科目适度收敛以省 token。
  // 只在用户明确选了学科时生效，detail 一律高精度，避免手写小字被糊掉。
  var SUBJECT_IMAGE_PROFILES = {
    "\u6570\u5B66": { maxEdge: 1600, detail: "high" },
    "\u7269\u7406": { maxEdge: 1600, detail: "high" },
    "\u5316\u5B66": { maxEdge: 1600, detail: "high" },
    "\u751F\u7269": { maxEdge: 1440, detail: "high" },
    "\u8BED\u6587": { maxEdge: 1440, detail: "high" },
    "\u82F1\u8BED": { maxEdge: 1440, detail: "high" },
    "\u5386\u53F2": { maxEdge: 1280, detail: "high" },
    "\u653F\u6CBB": { maxEdge: 1280, detail: "high" },
    "\u5730\u7406": { maxEdge: 1280, detail: "high" }
  };
  // 把配置规整成一次批改真正使用的图片参数；学科自动策略优先于手动尺寸。
  function resolveImageOptions(config) {
    const image = isRecord(config?.image) ? config.image : {};
    const positive = (value, fallback) => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? number : fallback;
    };
    const resolved = {
      maxEdge: Math.min(2400, Math.max(600, positive(image.maxEdge, 1600))),
      quality: Math.min(1, Math.max(0.5, positive(image.quality, 0.82))),
      detail: ["high", "auto", "low"].includes(image.detail) ? image.detail : "high"
    };
    const subject = String(config?.context?.subject || "").trim();
    const preset = image.autoBySubject === false ? null : SUBJECT_IMAGE_PROFILES[subject];
    if (preset) {
      resolved.maxEdge = preset.maxEdge;
      resolved.detail = preset.detail;
      resolved.subject = subject;
    }
    return resolved;
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
    // 只做等比缩小，绝不放大：放大不会带来新信息，只会被服务商的短边归一化规则再插值一次。
    const scale = Math.min(1, config.maxEdge / Math.max(sourceWidth, sourceHeight));
    const output = document.createElement("canvas");
    output.width = Math.max(1, Math.round(sourceWidth * scale));
    output.height = Math.max(1, Math.round(sourceHeight * scale));
    const outputCtx = output.getContext("2d");
    if (!outputCtx) throw new Error("\u65E0\u6CD5\u521B\u5EFA\u753B\u5E03\u4E0A\u4E0B\u6587");
    outputCtx.drawImage(work, 0, 0, output.width, output.height);
    const encoded = output.toDataURL("image/jpeg", Math.min(1, Math.max(0.5, config.quality)));
    return {
      dataUrl: encoded,
      hash: await sha256(encoded),
      width: output.width,
      height: output.height,
      blankRatio: ratio,
      // 只有"原图本来够清晰、被我们缩到看不清"才算问题；题块裁切图本身短边就小，属正常。
      lowRes: Math.min(output.width, output.height) < 320 && Math.min(sourceWidth, sourceHeight) >= 320
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
var PROMPT_VERSION = "zygr-prompt-v6-vlm";
// 输出档位：直接决定模型要写多少字，也就决定输出 token。
var OUTPUT_MODES = {
  brief: { label: "\u7B80\u7565\uFF08\u53EA\u7ED9\u5206\uFF0C\u6700\u7701 token\uFF09", maxTokens: 400 },
  standard: { label: "\u6807\u51C6\uFF08\u603B\u8BC4\u8BED + \u6263\u5206\u7406\u7531\uFF09", maxTokens: 800 },
  detailed: { label: "\u8BE6\u7EC6\uFF08\u6BCF\u9898\u7ED9\u4F9D\u636E\uFF0C\u66F4\u8D39 token\uFF09", maxTokens: 1400 }
};
function normalizeOutputMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(OUTPUT_MODES, mode) ? mode : "standard";
}
function clip(text, max) {
  const value = String(text ?? "").trim();
  if (!value) return "\uFF08\u65E0\uFF09";
  return value.length > max ? `${value.slice(0, max)}
\u2026\u2026\uFF08\u5185\u5BB9\u5DF2\u622A\u65AD\uFF09` : value;
}
function subQuestionLines(question) {
  if (question.subQuestions.length === 0) return "\uFF08\u65E0\u5206\u5C0F\u9898\u4FE1\u606F\uFF09";
  return question.subQuestions.map((item, index) => `- ${index}\uFF1A${item.label}\uFF08\u6EE1\u5206 ${item.maxScore > 0 ? item.maxScore : "\u672A\u6307\u5B9A"}\uFF09`).join("\n");
}
function maxScoreLine(context, question) {
  const max = context.maxScore > 0 ? context.maxScore : question.maxScore;
  return max > 0 ? `\u6EE1\u5206 ${max} \u5206` : "\u6EE1\u5206\u672A\u6307\u5B9A\uFF0C\u6309\u5E38\u89C4\u5224\u65AD";
}
function schemaLine(mode) {
  if (mode === "brief") {
    return "\u5B57\u6BB5\uFF1As\uFF08l \u53EF\u8FA8\u8BA4 / p \u90E8\u5206\u4E0D\u6E05 / i \u65E0\u6CD5\u8FA8\u8BA4 / b \u672A\u4F5C\u7B54\uFF09\u3001sc\uFF08\u5F97\u5206\u6570\u5B57\uFF09\u3001c\uFF08\u7F6E\u4FE1\u5EA6 0-1\uFF0C\u4E00\u4F4D\u5C0F\u6570\uFF09\u3001sub\uFF08\u6570\u7EC4\uFF1Ai \u5C0F\u9898\u5E8F\u53F7\u4ECE 0 \u5F00\u59CB\u3001sc \u5F97\u5206\uFF09\u3002\u4E0D\u8981\u8F93\u51FA\u4EFB\u4F55\u7406\u7531\u3001\u8BC4\u8BED\u6216\u89E3\u91CA\u3002";
  }
  if (mode === "detailed") {
    return "\u5B57\u6BB5\uFF1As\uFF08l \u53EF\u8FA8\u8BA4 / p \u90E8\u5206\u4E0D\u6E05 / i \u65E0\u6CD5\u8FA8\u8BA4 / b \u672A\u4F5C\u7B54\uFF09\u3001sc\uFF08\u5F97\u5206\u6570\u5B57\uFF09\u3001c\uFF08\u7F6E\u4FE1\u5EA6 0-1\uFF0C\u4E00\u4F4D\u5C0F\u6570\uFF09\u3001r\uFF08\u603B\u8BC4\u8BED\uFF0C\u4E0D\u8D85\u8FC7 60 \u5B57\uFF0C\u5199\u660E\u4E3B\u8981\u5F97\u5206\u70B9\u4E0E\u6263\u5206\u70B9\uFF09\u3001sub\uFF08\u6570\u7EC4\uFF1Ai \u5C0F\u9898\u5E8F\u53F7\u4ECE 0 \u5F00\u59CB\u3001sc \u5F97\u5206\u3001r \u6BCF\u9898\u4E0D\u8D85\u8FC7 40 \u5B57\uFF0C\u5199\u660E\u4F9D\u636E\uFF09\u3002";
  }
  return "\u5B57\u6BB5\uFF08\u52A1\u5FC5\u7CBE\u7B80\uFF09\uFF1As\uFF08l \u53EF\u8FA8\u8BA4 / p \u90E8\u5206\u4E0D\u6E05 / i \u65E0\u6CD5\u8FA8\u8BA4 / b \u672A\u4F5C\u7B54\uFF09\u3001sc\uFF08\u5F97\u5206\u6570\u5B57\uFF09\u3001c\uFF08\u7F6E\u4FE1\u5EA6 0-1\uFF0C\u4E00\u4F4D\u5C0F\u6570\uFF09\u3001r\uFF08\u603B\u8BC4\u8BED\uFF0C\u4E0D\u8D85\u8FC7 30 \u5B57\uFF09\u3001sub\uFF08\u6570\u7EC4\uFF1Ai \u5C0F\u9898\u5E8F\u53F7\u4ECE 0 \u5F00\u59CB\u3001sc \u5F97\u5206\u3001r \u4EC5\u5728\u6263\u5206\u65F6\u7ED9\u4E0D\u8D85\u8FC7 20 \u5B57\u7684\u6263\u5206\u539F\u56E0\uFF09\u3002";
}
// 固定段落（角色/规则/输出协议）必须逐字不变，才能命中平台侧前缀缓存；
// 动态内容一律放到后面的【输入】段，且不得插入固定段落之间。
function buildGradingPrompt(question, context, options) {
  const mode = normalizeOutputMode(options?.outputMode);
  const answer = "\u3010\u5B66\u751F\u4F5C\u7B54\u3011\n\u89C1\u968F\u9644\u56FE\u7247\uFF0C\u6309\u56FE\u7247\u5185\u5BB9\u5224\u65AD";
  const sections = [
    "\u4F60\u662F\u9605\u5377\u52A9\u624B\u3002\u53EA\u4F9D\u636E\u7ED9\u5B9A\u5185\u5BB9\u4E0E\u968F\u9644\u56FE\u7247\u8BC4\u5206\uFF0C\u4E0D\u8981\u81C6\u6D4B\u3002",
    "\u4E25\u683C\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u4E0D\u8981 Markdown \u4EE3\u7801\u5757\uFF0C\u4E0D\u8981\u989D\u5916\u89E3\u91CA\u3002\u4E0D\u8981\u56DE\u5199\u9898\u76EE\u3001\u53C2\u8003\u7B54\u6848\u3001\u5C0F\u9898\u540D\u79F0\u4E0E\u6EE1\u5206\u3002",
    schemaLine(mode),
    "\u89C4\u5219\uFF1A\u672A\u4F5C\u7B54\u4E0D\u5F97\u7ED9\u6B63\u5206\uFF1B\u5212\u53BB\u7684\u5185\u5BB9\u4E0D\u8BA1\u5206\uFF1B\u7B49\u4EF7\u89E3\u6CD5\u5E94\u7ED9\u5206\uFF1B\u5206\u6570\u4E0D\u5F97\u8D85\u8FC7\u6EE1\u5206\uFF1B\u65E0\u6CD5\u8FA8\u8BA4\u65F6\u7528 i/p \u5E76\u8BF4\u660E\u3002",
    question.subQuestions.length > 0 ? "\u5FC5\u987B\u9010\u5C0F\u9898\u8FD4\u56DE sub\uFF0Ci \u4ECE 0 \u5F00\u59CB\u3001\u4E0E\u3010\u5C0F\u9898\u3011\u5217\u8868\u7F16\u53F7\u4E00\u4E00\u5BF9\u5E94\uFF0C\u4E0D\u8DF3\u53F7\u3001\u4E0D\u5408\u5E76\u3001\u4E0D\u91CD\u6392\uFF1B\u56FE\u4E2D\u5E76\u6392\u7684\u591A\u4E2A\u7B54\u9898\u533A\u6309\u4ECE\u5DE6\u5230\u53F3\u3001\u4ECE\u4E0A\u5230\u4E0B\u4E0E\u5C0F\u9898\u987A\u5E8F\u5BF9\u5E94\uFF1B\u603B\u5206 sc \u7B49\u4E8E\u5404\u5C0F\u9898 sc \u4E4B\u548C\u3002" : "sub \u8FD4\u56DE\u7A7A\u6570\u7EC4\u5373\u53EF\u3002",
    mode === "brief" ? "" : mode === "detailed" ? "\u6BCF\u4E2A\u5C0F\u9898\u90FD\u8981\u5199 sub.r\uFF0C\u5199\u6E05\u5F97\u5206\u4F9D\u636E\u4E0E\u6263\u5206\u4F9D\u636E\uFF1B\u4E0D\u8981\u590D\u8FF0\u5B66\u751F\u539F\u6587\u3002" : "\u6EE1\u5206\u5C0F\u9898\u7684 sub.r \u7701\u7565\uFF1B\u6263\u5206\u5C0F\u9898\u7684 sub.r \u53EA\u5199\u5173\u952E\u6263\u5206\u70B9\u3002",
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
    "\u6CE8\u610F\uFF1A\u968F\u9644\u56FE\u7247\u4EC5\u4E3A\u672C\u6B21\u5B66\u751F\u4F5C\u7B54\uFF0C\u7B54\u5377\u4E0A\u7684\u5370\u5237\u9898\u5E72\u4E0D\u5C5E\u4E8E\u5B66\u751F\u4F5C\u7B54\uFF1B\u82E5\u5DF2\u5254\u9664\u7A7A\u767D\u6216\u91CD\u590D\u56FE\u7247\uFF0C\u4EC5\u57FA\u4E8E\u5269\u4F59\u56FE\u7247\u8BC4\u5224\uFF1B\u56FE\u7247\u53EF\u80FD\u88AB\u5207\u5757\u540E\u4ECE\u5DE6\u5230\u53F3\u3001\u4ECE\u4E0A\u5230\u4E0B\u91CD\u6392\uFF0C\u8BF7\u6309\u8BE5\u987A\u5E8F\u9605\u8BFB\u3002",
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
        const image = await prepareImage(src, imageConfig || {});
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
    l: "legible",
    p: "partial",
    i: "illegible",
    b: "blank",
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
  // 分数提取：先看【得分】标注（"3/5" 取分子），再看带标签的数字，最后只在全文只有一个数字时才采信。
  // 仍然无法确定就返回 uncertain，交给上层标记人工复核，绝不瞎猜一个数。
  function extractScore(text, maxScore) {
    const labeled = text.match(/【得分】\s*([+\-]?\d+(?:\.\d+)?)\s*(?:\/\s*\d+(?:\.\d+)?)?/);
    if (labeled) return { value: clamp(Number(labeled[1]), maxScore), certain: true };
    const tagged = text.match(/(?:得分|分数|总评|总分|score)\s*[:：=]?\s*([+\-]?\d+(?:\.\d+)?)/i);
    if (tagged) return { value: clamp(Number(tagged[1]), maxScore), certain: true };
    const numbers = [...text.matchAll(/[+\-]?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
    if (numbers.length === 1) return { value: clamp(numbers[0], maxScore), certain: true };
    return { value: 0, certain: false };
  }
  // 兼容两种协议：紧凑版（i/sc/r）与旧版（label/score/maxScore/reason）。
  // 小题名称与满分由输入给出，模型不再回写，避免每份卷子白花几十个输出 token。
  function parseSubScores(value, maxScore, subQuestions = []) {
    if (!Array.isArray(value)) return [];
    // 模型偶尔按 1 开始编号：仅当没有任何 0 号、且最大号不超过小题数时，整体左移一位。
    const rawIndexes = value
      .map((item) => Number(asRecord(item)?.i ?? asRecord(item)?.index))
      .filter((index) => Number.isInteger(index) && index >= 0);
    const shifted = rawIndexes.length > 0 && !rawIndexes.includes(0) && Math.max(...rawIndexes) <= subQuestions.length;
    return value.flatMap((item) => {
      const record = asRecord(item);
      if (!record) return [];
      const rawIndex = Number(record.i ?? record.index);
      const index = Number.isInteger(rawIndex) && rawIndex >= 0 ? (shifted ? rawIndex - 1 : rawIndex) : -1;
      const base = index >= 0 && index < subQuestions.length ? subQuestions[index] : null;
      const label = String(record.label ?? base?.label ?? "").trim();
      if (!label) return [];
      const itemMax = clamp(Number(record.maxScore ?? base?.maxScore ?? 0), maxScore);
      return [{
        label,
        score: clamp(Number(record.sc ?? record.score ?? 0), itemMax > 0 ? itemMax : maxScore),
        maxScore: itemMax,
        reason: String(record.r ?? record.reason ?? "").slice(0, 200)
      }];
    });
  }
  function fromJson(raw, maxScore, subQuestions = []) {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const record = asRecord(JSON.parse(cleaned.slice(start, end + 1)));
      if (!record) return null;
      const subScores = parseSubScores(record.subScores ?? record.sub, maxScore, subQuestions);
      const subSum = subScores.reduce((sum, item) => sum + item.score, 0);
      const declared = record.sc ?? record.score;
      // 小题分齐全时以小题合计为准：模型自报的总分经常与明细对不上。
      const complete = subScores.length > 0 && (subQuestions.length === 0 || subScores.length >= subQuestions.length);
      let scoreValue = declared;
      let scoreAdjusted = false;
      let scoreUncertain = false;
      if (complete) {
        scoreAdjusted = declared !== void 0 && Math.abs(Number(declared) - subSum) > 0.01;
        scoreValue = subSum;
      } else if (declared === void 0) {
        scoreValue = subSum;
        scoreUncertain = subScores.length === 0;
      }
      return {
        status: mapStatus(record.s ?? record.status),
        score: clamp(Number(scoreValue), maxScore),
        subScores,
        reason: String(record.r ?? record.reason ?? "").slice(0, 300),
        confidence: clamp(Number(record.c ?? record.confidence ?? 0.7), 1),
        scoreAdjusted,
        scoreUncertain,
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
    const fallback = extractScore(raw, maxScore);
    return {
      status: statusMatch ? mapStatus(statusMatch[1]) : "legible",
      score: subScores.length > 0 ? subTotal : fallback.value,
      subScores,
      reason: reasonMatch ? reasonMatch[1].trim().slice(0, 300) : "",
      confidence: 0.5,
      scoreAdjusted: false,
      scoreUncertain: subScores.length === 0 && !fallback.certain,
      raw
    };
  }
  function parseGrade(raw, maxScore, subQuestions = []) {
    return fromJson(raw, maxScore, subQuestions) ?? fromText(raw, maxScore, subQuestions);
  }

// src/core/pipeline.ts
function configured(service) {
  return Boolean(service.endpoint.trim() && service.model.trim());
}
async function runGrade(service, question, maxScore, prompt, images, config, rateLimiter, imageOptions, forcedByModel) {
  const detail = imageOptions?.detail || "high";
  const content = [
    { type: "text", text: prompt },
    ...images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl, detail } }))
  ];
  const messages = [
    { role: "system", content: "\u4F60\u662F\u4E25\u683C\u4F46\u516C\u6B63\u7684\u9605\u5377\u52A9\u624B\uFF0C\u53EA\u8F93\u51FA JSON\u3002" },
    { role: "user", content }
  ];
  // 输出档位决定基础预算；思考模式会额外消耗输出预算，开启时放宽，避免 JSON 被截断。
  const mode = normalizeOutputMode(config.pipeline?.outputMode);
  const thinking = normalizeThinkingMode(service.thinkingMode);
  const baseTokens = OUTPUT_MODES[mode]?.maxTokens || 800;
  const maxTokens = thinking === "off" ? baseTokens : Math.round(baseTokens * 1.8);
  let usage = null;
  let forcedDetected = false;
  const raw = await chatCompletion(service, messages, {
    rateLimiter,
    timeoutMs: config.pipeline.timeoutMs,
    jsonMode: true,
    maxTokens,
    estimatedTokens: estimateTokens(prompt, images.length),
    onUsage: (value) => {
      if (value) usage = value;
    },
    // 运行期才发现"该模型不支持关闭思考"：记住它，下次不再浪费一次失败请求。
    onThinkingForced: () => {
      forcedDetected = true;
      markForcedThinking(service.platform, service.model);
    }
  });
  if (!raw.trim()) throw new Error("\u6A21\u578B\u8FD4\u56DE\u4E3A\u7A7A");
  const grade = parseGrade(raw, maxScore, question.subQuestions);
  grade.usage = usage;
  grade.outputMode = mode;
  grade.thinkingForced = forcedDetected || Boolean(forcedByModel);
  return grade;
}
async function gradeQuestion(options) {
  const { config, question, cache, rateLimiter } = options;
  const wanted = normalizeThinkingMode(config.pipeline.thinkingMode !== void 0 ? config.pipeline.thinkingMode : config.pipeline.disableThinking);
  const forcedByModel = wanted === "off" && isForcedThinkingModel(config.pipeline.vlm.platform, config.pipeline.vlm.model);
  // 已知强制思考的模型直接按「模型默认」走，省掉一次注定失败的 400 请求。
  config.pipeline.vlm.thinkingMode = forcedByModel ? "auto" : clampThinkingLevel(config.pipeline.vlm.platform, wanted);
  const startedAt = Date.now();
  const stage = (name, detail) => options.events?.onStage?.(name, detail);
  const reviewReasons = [];
  const maxScore = config.context.maxScore > 0 ? config.context.maxScore : question.maxScore;
  const gradeService = config.pipeline.vlm;
  if (!configured(gradeService)) throw new Error("\u6279\u6539\u670D\u52A1\u672A\u914D\u7F6E\u5B8C\u6574\uFF0C\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u586B\u5199\u591A\u6A21\u6001\u670D\u52A1\u7684\u63A5\u53E3\u5730\u5740\u4E0E\u6A21\u578B");
  // 学科策略优先于手动尺寸；未选学科时完全按手动参数。
  const imageOptions = resolveImageOptions(config);
  const outputMode = normalizeOutputMode(config.pipeline?.outputMode);
  // 缓存键只依赖原始作答图地址与批改参数，与图片预处理结果无关。
  // 先查缓存能在命中时跳过下载与缩放：双评第二遍几乎不用等图。
  const cacheKey = makeGradeCacheKey({
    question,
    context: config.context,
    model: gradeService.model,
    image: imageOptions,
    thinkingMode: gradeService.thinkingMode,
    outputMode,
    // 接口身份（scanRecordId + 题号）优先，跨账号一致；没有时缓存键退回图片地址归一化。
    identity: question.identity || null,
    promptVersion: PROMPT_VERSION
  });
  const cached = cache.get(cacheKey);
  if (cached) {
    stage("\u8BC4\u5206\u7F13\u5B58\u547D\u4E2D");
    recordUsage({ graded: true, localHit: true });
    return { ...cached, cacheHit: true, elapsedMs: Date.now() - startedAt, cacheKey, usage: null };
  }
  stage("\u51C6\u5907\u4F5C\u7B54\u56FE\u7247");
  const preparedList = (await Promise.all(
    question.images.map((src) => prepareImage(src, imageOptions).catch(() => null))
  )).filter((item) => item !== null);
  const prepared = dedupePrepared(preparedList);
  const removed = prepared.filter((image) => isBlankImage(image) || isWasteImage(image));
  const usable = prepared.filter((image) => !isBlankImage(image) && !isWasteImage(image));
  if (removed.length > 0) reviewReasons.push(`\u5DF2\u5254\u9664 ${removed.length} \u5F20\u5E9F\u56FE`);
  const lowResCount = usable.filter((image) => image.lowRes).length;
  if (lowResCount > 0) reviewReasons.push(`\u6709 ${lowResCount} \u5F20\u56FE\u7247\u5206\u8FA8\u7387\u504F\u4F4E\uFF0C\u624B\u5199\u5C0F\u5B57\u53EF\u80FD\u8BC6\u522B\u4E0D\u51C6`);
  if (imageOptions.detail === "low") reviewReasons.push("\u56FE\u7247\u4F7F\u7528\u4F4E\u7CBE\u5EA6\u6A21\u5F0F\uFF0C\u5206\u6570\u5EFA\u8BAE\u4EBA\u5DE5\u590D\u6838");
  if (usable.length === 0) {
    throw new Error("\u672A\u83B7\u53D6\u5230\u53EF\u7528\u4F5C\u7B54\u56FE\u7247\uFF1A\u56FE\u7247\u94FE\u63A5\u53EF\u80FD\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u70B9\u9605\u5377\u9875\u300C\u5237\u65B0\u300D\u540E\u91CD\u8BD5");
  }
  const payloadImages = usable;
  const prompt = buildGradingPrompt(question, config.context, {
    outputMode,
    removedImages: removed.length
  });
  stage("\u6A21\u578B\u8BC4\u5206", gradeService.model);
  const grade = await runGrade(gradeService, question, maxScore, prompt, payloadImages, config, rateLimiter, imageOptions, forcedByModel);
  if (grade.status === "blank" && grade.score > 0) {
    reviewReasons.push("\u8BC6\u522B\u4E3A\u672A\u4F5C\u7B54\u4F46\u7ED9\u51FA\u4E86\u6B63\u5206\uFF0C\u8BF7\u4EBA\u5DE5\u6838\u67E5");
  }
  // 无法辨认却给了分：多半是模型凭印象打分，必须人工确认。
  if (grade.status === "illegible" && grade.score > 0) {
    reviewReasons.push("\u8BC6\u522B\u4E3A\u65E0\u6CD5\u8FA8\u8BA4\u5374\u7ED9\u4E86\u6B63\u5206\uFF0C\u8BF7\u4EBA\u5DE5\u6838\u5B9E");
  }
  if (grade.scoreUncertain) reviewReasons.push("\u672A\u80FD\u4ECE\u6A21\u578B\u8F93\u51FA\u4E2D\u786E\u5B9A\u5206\u6570\uFF0C\u8BF7\u4EBA\u5DE5\u6838\u5B9A");
  if (grade.scoreAdjusted) reviewReasons.push("\u603B\u5206\u4E0E\u5C0F\u9898\u5408\u8BA1\u4E0D\u4E00\u81F4\uFF0C\u5DF2\u6309\u5C0F\u9898\u91CD\u7B97");
  const missingSubs = question.subQuestions.length - grade.subScores.length;
  if (question.subQuestions.length > 0 && missingSubs > 0) {
    reviewReasons.push(`\u6709 ${missingSubs} \u4E2A\u5C0F\u9898\u672A\u8FD4\u56DE\u5206\u6570\uFF0C\u8BF7\u6838\u5BF9`);
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
  recordUsage({
    graded: true,
    request: true,
    prompt: grade.usage?.prompt || 0,
    cached: grade.usage?.cached || 0,
    completion: grade.usage?.completion || 0,
    reasoning: grade.usage?.reasoning || 0
  });
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
    async acquire(estimatedTokens, timeoutMs = 3e4) {
      // 单次请求就超预算时永远等不到配额，直接拒绝比死循环好。
      if (this.options.maxTpm > 0 && estimatedTokens > this.options.maxTpm) {
        throw new Error(`\u5355\u6B21\u8BF7\u6C42\u9884\u4F30 ${estimatedTokens} token\uFF0C\u5DF2\u8D85\u8FC7 TPM \u9884\u7B97 ${this.options.maxTpm}\uFF0C\u8BF7\u8C03\u5927 TPM \u6216\u51CF\u5C11\u56FE\u7247`);
      }
      const deadline = this.now() + timeoutMs;
      for (; ; ) {
        this.prune();
        const rpmFull = this.starts.length >= this.options.maxRpm;
        const tpmFull = this.tokenUsed() + estimatedTokens > this.options.maxTpm;
        const concurrencyFull = this.active >= this.options.maxConcurrent;
        if (!rpmFull && !tpmFull && !concurrencyFull) break;
        // 配额一直不释放时给个上限，避免按钮永远卡在「处理中」。
        if (this.now() >= deadline) {
          throw new Error("\u7B49\u5F85\u9650\u6D41\u914D\u989D\u8D85\u65F6\uFF0830 \u79D2\uFF09\uFF0C\u8BF7\u8C03\u5927\u5E76\u53D1\uFF0FRPM \u6216 TPM");
        }
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
.zygr-summary { margin: -6px 0 0; font-size: 11px; color: var(--zygr-muted); line-height: 1.6; }
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
  // 所有面板输入框都拦下 Enter：页面本身可能把回车当提交，会把半截分数写进平台。
  // 只阻止冒泡；文本域仍保留换行（不 preventDefault）。
  function guardEnter(root) {
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      const target = event.target;
      if (!target || !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || "")) return;
      event.stopPropagation();
      if (target.tagName !== "TEXTAREA") event.preventDefault();
    });
  }
  var GraderPanel = class {
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.toastTimer = 0;
      this.host = document.createElement("div");
      this.host.className = "zygr-host";
      this.shadow = this.host.attachShadow({ mode: "open" });
      this.shadow.innerHTML = `<style>${STYLES}</style>${this.markup()}`;
      guardEnter(this.shadow);
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
      // 用量直接取自响应里的 usage，读取它不消耗 token。
      const usage = result.usage;
      const usageText = usage && (usage.prompt || usage.completion)
        ? ` \xB7 \u8F93\u5165 ${usage.prompt}${usage.cached ? `\uFF08\u524D\u7F00\u547D\u4E2D ${usage.cached}\uFF09` : ""} \xB7 \u8F93\u51FA ${usage.completion}${usage.reasoning ? `\uFF08\u542B\u601D\u8003 ${usage.reasoning}\uFF09` : ""}`
        : "";
      meta.textContent = `\u94FE\u8DEF ${result.pipeline} \xB7 \u6A21\u578B ${result.model} \xB7 \u8017\u65F6 ${(result.elapsedMs / 1e3).toFixed(1)}s${usageText}`;
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
      guardEnter(this.shadow);
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
        <div class="zygr-summary" data-summary></div>
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
      // 汇总只统计当前筛选结果，方便核对某个范围内的输入/输出与命中情况。
      this.q("[data-summary]").textContent = summaryText(entries);
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
      const usage = entryUsage(entry);
      const lines = [
        `\u9898\u53F7\uFF1A${entry.question.questionId}`,
        `\u94FE\u8DEF / \u6A21\u578B\uFF1A${entry.result.pipeline} / ${entry.result.model}`,
        `\u7ED3\u679C\uFF1A${entry.result.score} / ${entry.result.maxScore}\uFF08${entry.result.status}\uFF09`,
        `\u7528\u91CF\uFF1A\u8F93\u5165 ${usage.prompt}${usage.cached ? `\uFF08\u524D\u7F00\u547D\u4E2D ${usage.cached}\uFF09` : ""} \xB7 \u8F93\u51FA ${usage.completion}${usage.reasoning ? `\uFF08\u542B\u601D\u8003 ${usage.reasoning}\uFF09` : ""}`,
        `\u7F13\u5B58 / \u8017\u65F6\uFF1A${entryHitText(entry)} / ${entryElapsed(entry)}s`,
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
      guardEnter(this.shadow);
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
          <div class="zygr-grid">
            ${field("\u672C\u65B9\u6848\u6EE1\u5206", "context.maxScore", "number")}
            ${select("\u5B66\u79D1\uFF08\u7528\u4E8E\u81EA\u52A8\u5957\u7528\u56FE\u7247\u7B56\u7565\uFF09", "context.subject", [["", "\u4E0D\u6307\u5B9A\uFF08\u6309\u624B\u52A8\u53C2\u6570\uFF09"], ...Object.keys(RUBRIC_SUBJECTS).map((name) => [name, name])])}
          </div>
        </div>

        <div class="zygr-section" data-page="api" hidden>
          <h3>\u5E73\u53F0\u9884\u8BBE</h3>
          <p class="zygr-hint">\u9009\u62E9\u5E73\u53F0\u4F1A\u586B\u5165\u63A5\u53E3\u5730\u5740\uFF0C\u5E76\u6062\u590D\u8BE5\u5E73\u53F0\u8BB0\u5F55\u7684 Key\u3001\u6A21\u578B\u4E0E\u601D\u8003\u6A21\u5F0F\u3002\u5176\u4ED6\u5E73\u53F0\u8BF7\u9009\u300C\u81EA\u5B9A\u4E49\uFF08\u624B\u52A8\u586B\u5199\uFF09\u300D\u3002</p>

          <h3>\u591A\u6A21\u6001\u76F4\u8BC4</h3>
          <p class="zygr-hint">\u8BC4\u5206\u53EA\u4F7F\u7528\u591A\u6A21\u6001\u89C6\u89C9\u6A21\u578B\uFF1A\u76F4\u63A5\u8BFB\u53D6\u4F5C\u7B54\u56FE\u7247\u5E76\u6309\u8BC4\u5206\u6807\u51C6\u8F93\u51FA JSON\u3002\u6A21\u578B\u5FC5\u987B\u652F\u6301\u56FE\u7247\u8F93\u516E\u3002</p>
          ${select("\u601D\u8003\u6A21\u5F0F", "pipeline.thinkingMode", [["off", thinkingLevelLabel("off")], ["auto", thinkingLevelLabel("auto")]])}
          <div class="zygr-row"><button class="zygr-btn zygr-ghost" data-act="test-thinking">\u6D4B\u8BD5\u5F53\u524D\u601D\u8003\u6A21\u5F0F\u662F\u5426\u751F\u6548</button><span class="zygr-test-status" data-status="thinking"></span></div>
          <p class="zygr-hint">\u9ED8\u8BA4\u5173\u95ED\u601D\u8003\uFF0C\u754C\u9762\u53EA\u7ED9\u4E24\u6863\uFF1A\u300C\u5173\u95ED\u601D\u8003\u300D\u4E0E\u300C\u6A21\u578B\u9ED8\u8BA4\u300D\uFF08\u4E0D\u4F20\u5F3A\u5EA6\u53C2\u6570\uFF09\u3002\u80FD\u4E0D\u80FD\u5173\u95ED\u53D6\u51B3\u4E8E\u6A21\u578B\u800C\u4E0D\u662F\u5E73\u53F0\uFF1A\u5DF2\u77E5 GLM-5.3\u3001GLM-5.3-FLASH \u5F3A\u5236\u601D\u8003\uFF0C\u9009\u5173\u95ED\u4E5F\u4E0D\u4F1A\u62A5\u9519\uFF0C\u4F1A\u76F4\u63A5\u6309\u6A21\u578B\u9ED8\u8BA4\u8FD0\u884C\uFF1B\u5176\u5B83\u6A21\u578B\u5982\u679C\u8FD4\u56DE\u201C\u4E0D\u652F\u6301\u5173\u95ED\u601D\u8003\u201D\uFF0C\u7A0B\u5E8F\u4F1A\u81EA\u52A8\u8BC6\u522B\u5E76\u8BB0\u4F4F\uFF0C\u4E0B\u6B21\u4E0D\u518D\u91CD\u590D\u8BD5\u9519\u3002</p>

          ${platformSelect("\u5E73\u53F0\u9884\u8BBE", "pipeline.vlm.platform")}
          <h3>\u591A\u6A21\u6001\u670D\u52A1</h3>
          <div class="zygr-grid">
            ${field("\u63A5\u53E3\u5730\u5740", "pipeline.vlm.endpoint")}${field("API Key", "pipeline.vlm.apiKey", "password")}
            ${field("\u6A21\u578B", "pipeline.vlm.model")}
          </div>
          <p class="zygr-hint">\u586B OpenAI \u517C\u5BB9 Chat Completions \u5730\u5740\u4E0E\u89C6\u89C9\u6A21\u578B\u540D\u3002</p>
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
            ${select("\u56FE\u7247\u7CBE\u5EA6", "image.detail", [["high", "\u9AD8\u7CBE\u5EA6\uFF08\u63A8\u8350\uFF0C\u624B\u5199\u5FC5\u9009\uFF09"], ["auto", "\u81EA\u52A8\uFF08\u7531\u5E73\u53F0\u51B3\u5B9A\uFF09"], ["low", "\u4F4E\u7CBE\u5EA6\uFF08\u4EC5\u9009\u62E9/\u586B\u7A7A\u5224\u5BF9\u9519\uFF09"]])}
            ${select("\u8F93\u51FA\u6863\u4F4D", "pipeline.outputMode", [["brief", OUTPUT_MODES.brief.label], ["standard", OUTPUT_MODES.standard.label], ["detailed", OUTPUT_MODES.detailed.label]])}
            ${field("\u56FE\u7247\u957F\u8FB9\u4E0A\u9650\uFF08px\uFF09", "image.maxEdge", "number")}
            ${field("JPEG \u8D28\u91CF\uFF080.5-1\uFF09", "image.quality", "number")}
            ${field("\u5386\u53F2\u4FDD\u7559\u6761\u6570", "historyLimit", "number")}
            ${field("\u7F13\u5B58\u6709\u6548\u671F\uFF08\u5929\uFF09", "cacheTtlDays", "number")}
            ${field("\u7F13\u5B58\u6761\u6570\u4E0A\u9650", "cacheMaxEntries", "number")}
          </div>
          <label class="zygr-row"><input type="checkbox" data-field="image.autoBySubject"> \u6309\u5B66\u79D1\u81EA\u52A8\u5957\u7528\u56FE\u7247\u7B56\u7565\uFF08\u5DF2\u9009\u5B66\u79D1\u65F6\u751F\u6548\uFF09</label>
          <p class="zygr-hint">\u56FE\u7247 token \u53EA\u53D7\u5C3A\u5BF8\u4E0E\u7CBE\u5EA6\u5F71\u54CD\uFF0CJPEG \u8D28\u91CF\u4E0D\u5F71\u54CD\u8BA1\u8D39\uFF1B\u4F4E\u7CBE\u5EA6\u4E0E\u4F4E\u5206\u8FA8\u7387\u4F1A\u81EA\u52A8\u6807\u8BB0\u4EBA\u5DE5\u590D\u6838\u3002\u8F93\u51FA\u6863\u4F4D\u76F4\u63A5\u5F71\u54CD\u8F93\u51FA token\uFF1A\u7B80\u7565\u6700\u7701\u3001\u6807\u51C6\u9002\u4E2D\u3001\u8BE6\u7EC6\u6700\u8D35\u3002\u7F13\u5B58\u6761\u6570\u4E0A\u9650\u9ED8\u8BA4 2000\uFF0C\u53CC\u8BC4\u5927\u5377\u53EF\u63D0\u5230 3000\u3002\u5B66\u79D1\u7B56\u7565\uFF08\u6570\u5B66/\u7269\u7406/\u5316\u5B66 1600px\uFF0C\u8BED\u6587/\u82F1\u8BED/\u751F\u7269 1440px\uFF0C\u5386\u53F2/\u653F\u6CBB/\u5730\u7406 1280px\uFF0C\u5747\u4E3A\u9AD8\u7CBE\u5EA6\uFF09\u4F18\u5148\u4E8E\u624B\u52A8\u5C3A\u5BF8\u3002\u56FE\u7247\u53EA\u6309\u957F\u8FB9\u7B49\u6BD4\u7F29\u5C0F\uFF0C\u7EDD\u4E0D\u653E\u5927\uFF1A\u539F\u56FE\u672C\u6765\u5C31\u5C0F\u4E8E\u8BE5\u957F\u8FB9\u65F6\u4FDD\u6301\u539F\u59CB\u50CF\u7D20\uFF0C\u4EA4\u7ED9\u670D\u52A1\u5546\u5F52\u4E00\u5316\u4E5F\u4E0D\u4F1A\u4E22\u4FE1\u606F\u3002</p>
          <p class="zygr-hint" data-stats>\u7D2F\u8BA1\u7528\u91CF\uFF1A\u6682\u65E0</p>
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
        if (target.hasAttribute("data-config-file") && target.files?.[0]) {
          void this.importConfig(target.files[0]);
          target.value = "";
        }
      });
    }
    // 思考只保留两档，历史配置里的 low/high/max 在回填时收敛为「模型默认」。
    clampThinkingSelect() {
      const element = this.shadow.querySelector('[data-field="pipeline.thinkingMode"]');
      if (element instanceof HTMLSelectElement) element.value = clampThinkingLevel("", element.value);
    }
    // 累计用量来自本地计数，不触发任何请求。
    refreshStats() {
      const element = this.shadow.querySelector("[data-stats]");
      if (!element) return;
      const stats = loadUsageStats();
      if (!stats.graded) {
        element.textContent = "\u7D2F\u8BA1\u7528\u91CF\uFF1A\u6682\u65E0";
        return;
      }
      const hitRate = stats.graded > 0 ? Math.round((stats.localHits / stats.graded) * 100) : 0;
      const cacheRate = stats.promptTokens > 0 ? Math.round((stats.cachedTokens / stats.promptTokens) * 100) : 0;
      const reasoning = stats.reasoningTokens > 0 ? ` \xB7 \u601D\u8003 ${stats.reasoningTokens} token` : "";
      element.textContent = `\u7D2F\u8BA1\uFF1A\u6279\u6539 ${stats.graded} \u6B21 \xB7 \u672C\u5730\u547D\u4E2D ${stats.localHits} \u6B21\uFF08${hitRate}%\uFF09 \xB7 \u8BF7\u6C42 ${stats.requests} \u6B21 \xB7 \u8F93\u5165 ${stats.promptTokens} token\uFF08\u524D\u7F00\u547D\u4E2D ${stats.cachedTokens}\uFF0C${cacheRate}%\uFF09 \xB7 \u8F93\u51FA ${stats.completionTokens} token${reasoning}`;
    }
    refreshPlatformSelects() {
      const presets = listPlatformPresets();
      const options = presets.map((preset) => `<option value="${preset.id}">${preset.label}</option>`).join("");
      this.shadow.querySelectorAll("[data-platform-select]").forEach((element) => {
        const current = getPath(this.config, element.dataset.field || "") || element.value;
        element.innerHTML = options;
        element.value = presets.some((preset) => preset.id === current) ? current : "custom";
      });
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
        modelElement.value = rememberedModel;
        modelElement.dataset.platformBound = id;
      }
      // 历史记忆里可能是 low/high/max，统一收敛为「模型默认」。
      if (thinkingElement) thinkingElement.value = clampThinkingLevel(id, rememberedThinking || thinkingElement.value || "off");
      if (preset.endpoint) setField(`${base}.endpoint`, preset.endpoint);
      this.toast(`\u5DF2\u5207\u6362\u5230\u300C${preset.label}\u300D\uFF0C\u5DF2\u6062\u590D\u8BE5\u5E73\u53F0\u8BB0\u5F55\u7684 API Key\u3001\u6A21\u578B\u4E0E\u601D\u8003\u6A21\u5F0F`);
    }
    exportConfig() {
      const data = {
        app: "zygr",
        version: 1,
        exportedAt: new Date().toISOString(),
        config: this.getDraft(),
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
        // 平台不支持在线列表时不提供任何候选，只提示手动填写模型名称。
        if (models.manual) {
          if (picker) picker.innerHTML = "";
          if (pickerWrap) pickerWrap.hidden = true;
          const message = models.message || "\u8BE5\u5E73\u53F0\u4E0D\u652F\u6301\u5728\u7EBF\u83B7\u53D6\u6A21\u578B\u5217\u8868\uFF0C\u8BF7\u624B\u52A8\u586B\u5199\u6A21\u578B\u540D\u79F0";
          setStatus(message);
          this.toast(message);
          return;
        }
        if (picker) {
          picker.innerHTML = models.map((id) => `<option value="${String(id).replace(/"/g, "&quot;")}">${String(id).replace(/</g, "&lt;")}</option>`).join("");
        }
        if (pickerWrap) pickerWrap.hidden = false;
        const label = `\u83B7\u53D6\u5230 ${models.length} \u4E2A\u6A21\u578B`;
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
      const startedAt = Date.now();
      setStatus("\u6D4B\u8BD5\u4E2D\u2026 0s\uFF08\u957F\u94FE\u63A8\u7406\u6A21\u578B\u53EF\u80FD\u9700\u6570\u5341\u79D2\uFF09");
      if (button) button.disabled = true;
      const ticker = window.setInterval(() => {
        setStatus(`\u6D4B\u8BD5\u4E2D\u2026 ${Math.round((Date.now() - startedAt) / 1000)}s\uFF08\u957F\u94FE\u63A8\u7406\u6A21\u578B\u53EF\u80FD\u9700\u6570\u5341\u79D2\uFF09`);
      }, 1000);
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
        window.clearInterval(ticker);
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
      const boundPlatform = getPath(config, "pipeline.vlm.platform") || "custom";
      this.refreshPlatformSelects();
      this.shadow.querySelectorAll("[data-field]").forEach((element) => {
        const value = getPath(config, element.dataset.field ?? "");
        if (element instanceof HTMLInputElement && element.type === "checkbox") element.checked = Boolean(value);
        else element.value = value === void 0 || value === null ? "" : String(value);
      });
      this.clampThinkingSelect();
      const keyElement = this.shadow.querySelector('[data-field="pipeline.vlm.apiKey"]');
      const modelElement = this.shadow.querySelector('[data-field="pipeline.vlm.model"]');
      if (keyElement) keyElement.dataset.platformBound = boundPlatform;
      if (modelElement) modelElement.dataset.platformBound = boundPlatform;
      this.refreshStats();
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
    let cache = null;
    // 缓存条数上限可配（默认 2000）：双评大卷时同一份卷可能在很后面再次出现。
    const createCache = () => new CacheStore(config.cacheTtlDays, config.cacheMaxEntries, {
      onStorageError: () => panel.toast("\u5B58\u50A8\u914D\u989D\u5DF2\u6EE1\uFF0C\u672C\u5730\u7F13\u5B58\u5DF2\u505C\u6B62\u5199\u5165\uFF0C\u8BF7\u6E05\u7406\u5386\u53F2\u6216\u7F13\u5B58")
    });
    let limiter = buildLimiter(config);
    let markingDoc = null;
    let currentQuestion = null;
    let lastResult = null;
    let lastHistoryId = "";
    let busy = false;
    // 提交互斥与冷却：连续批阅与手动点击可能同时触发提交，必须串行化。
    let submitting = false;
    let lastSubmitAt = 0;
    const SUBMIT_COOLDOWN = 1500;
    const forcedNotified = new Set();
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
    cache = createCache();
    const settingsPanel = new SettingsPanel({
      onSave: (draft) => {
        config = draft;
        saveConfig(config);
        // TPM 太低时大图会长期排队，提示一次而不是等用户自己发现。
        if (config.pipeline.maxTpm < 12000) panel.toast("TPM \u9884\u7B97\u4F4E\u4E8E 12000\uFF0C\u5927\u56FE\u5BB9\u6613\u6392\u961F\uFF0C\u5EFA\u8BAE\u8C03\u5927");
        syncKeysFromConfig(config);
        syncModelsFromConfig(config);
        syncThinkingModesFromConfig(config);
        cache = createCache();
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
        return probeThinking(draft.pipeline.vlm);
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
        cache = createCache();
        limiter = buildLimiter(config);
        panel.setCache(pipelineLabel(config));
        panel.setSubtitle("\u914D\u7F6E\u5DF2\u5BFC\u5165");
      },
      onReset: () => {
        resetConfig();
        config = loadConfig();
        cache = createCache();
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
      // 满分以页面（接口优先）为准：不一致就自动写回配置，不再阻断批改。
      const scoreCheck = checkMaxScore(config.context.maxScore, markingDoc);
      if (scoreCheck.maxScore > 0 && scoreCheck.mismatch) {
        config.context.maxScore = scoreCheck.maxScore;
        saveConfig(config);
        panel.toast(`\u5DF2\u6309\u9875\u9762\u540C\u6B65\u6EE1\u5206\uFF1A${scoreCheck.maxScore} \u5206`);
      }
      const errors = validateConfig(config);
      if (errors.length > 0) {
        panel.showError(`${errors[0]}\uFF08\u8BF7\u70B9\u51FB\u300C\u8BBE\u7F6E\u300D\u624B\u52A8\u4FEE\u6539\uFF09`);
        return false;
      }
      busy = true;
      panel.setBusy(true);
      panel.clearError();
      try {
        panel.setStage("\u7B49\u5F85\u4F5C\u7B54\u56FE\u7247\u7A33\u5B9A");
        let images = await gatherAnswerImages();
        if (images.length === 0) {
          // DOM 一直不稳或链接已过期时，用接口观察到的新鲜地址兜底。
          images = freshAnswerImages();
        }
        if (images.length === 0) throw new Error("\u4F5C\u7B54\u56FE\u7247\u5C1A\u672A\u7A33\u5B9A\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
        // 身份只取台账号与题号：跨账号一致，且不含会过期的签名。
        const observedIdentity = currentHookIdentity();
        const identity = observedIdentity && observedIdentity.scanRecordId
          ? { scanRecordId: observedIdentity.scanRecordId, topicNumStr: observedIdentity.topicNumStr || "" }
          : null;
        currentQuestion = { ...currentQuestion, images, identity };
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
          question: historyQuestion(currentQuestion),
          result,
          submitted: false
        }, config.historyLimit);
        historyPanel.refresh(loadHistory());
        if (result.needsReview) panel.toast("\u6279\u6539\u5B8C\u6210\uFF0C\u5EFA\u8BAE\u4EBA\u5DE5\u590D\u6838");
        // 强制思考的模型只提示一次，避免每份卷子都弹。
        if (result.thinkingForced && !forcedNotified.has(config.pipeline.vlm.model)) {
          forcedNotified.add(config.pipeline.vlm.model);
          panel.toast(`\u300C${config.pipeline.vlm.model}\u300D\u5F3A\u5236\u601D\u8003\u3001\u65E0\u6CD5\u5173\u95ED\uFF0C\u5DF2\u6309\u6A21\u578B\u9ED8\u8BA4\u8FD0\u884C`);
        }
        return true;
      } catch (error) {
        panel.showError(error instanceof Error ? error.message : "\u6279\u6539\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u63A5\u53E3\u914D\u7F6E");
        return false;
      } finally {
        busy = false;
        panel.setBusy(false);
      }
    }
    // 历史只留定位字段与归一化后的图片键：签名 URL / data URI 会过期并迅速撑爆存储。
    function historyQuestion(question) {
      return {
        questionId: question.questionId,
        // 题号与接口原始题号都留一份，方便按平台口径对账。
        topicNumStr: question.topicNumStr || question.questionId,
        questionText: question.questionText,
        maxScore: question.maxScore,
        subQuestions: question.subQuestions,
        identity: question.identity || null,
        imageKeys: (question.images || []).map(stableImageKey)
      };
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
      // 互斥 + 冷却：连点会把同一份卷提交两次，也会让提交回执错位到下一次点击上。
      if (submitting) return { ok: false, oldIdentity: null };
      if (Date.now() - lastSubmitAt < SUBMIT_COOLDOWN) {
        panel.toast("\u521A\u63D0\u4EA4\u8FC7\uFF0C\u8BF7\u7A0D\u5019\u518D\u8BD5");
        return { ok: false, oldIdentity: null };
      }
      submitting = true;
      try {
        applyScoreEdits();
        const inputs = getScoreInputs(markingDoc);
        const scores = inputs.length > 1 && lastResult.subScores.length === inputs.length ? lastResult.subScores.map((item) => item.score) : [Math.round(lastResult.score * 10) / 10];
        const label = scores.length > 1 ? `\u5404\u5C0F\u9898\u5206\u6570 ${scores.join("\u3001")}` : `${scores[0]} \u5206`;
        if (!options.silent && !options.skipConfirm && !window.confirm(`\u786E\u8BA4\u5199\u5165${label}\u5E76\u63D0\u4EA4\uFF1F`)) {
          return { ok: false, oldIdentity: null };
        }
        const oldIdentity = getPaperIdentity();
        // 换卷判据需要提交前的 scanRecordId；接口没给就留空、退回图片判定。
        const oldScan = currentScanRecordId();
        // 填分必须回读一致才算写入成功，否则宁可不提交。
        const filled = fillScores(scores, markingDoc);
        if (!filled.ok) {
          panel.showError(`\u5206\u6570\u672A\u5199\u5165\uFF0C\u5DF2\u4E2D\u6B62\u63D0\u4EA4\uFF1A${filled.error}`);
          return { ok: false, oldIdentity };
        }
        // iframe 可能刚被路由替换，提交前再确认一次观察器存活。
        ensureZhixueHook(markingDoc);
        resetCommitSignal();
        if (!submitGrade(markingDoc)) {
          panel.showError("\u5206\u6570\u5DF2\u586B\u5165\uFF0C\u4F46\u672A\u627E\u5230\u63D0\u4EA4\u6309\u94AE\uFF0C\u8BF7\u624B\u52A8\u63D0\u4EA4");
          return { ok: false, oldIdentity };
        }
        lastSubmitAt = Date.now();
        // 有接口观察器就以平台回执为准（最多等 2.5 秒）；没有观察器时保持旧行为。
        const observed = hookActive();
        const signal = observed ? await waitCommitSignal(2500) : null;
        const verdict = judgeSubmit(observed, signal);
        if (!verdict.ok) {
          panel.showError(verdict.reason);
          return { ok: false, oldIdentity };
        }
        const history = loadHistory().map((entry) => entry.id === lastHistoryId ? { ...entry, result: lastResult, submitted: true, submitConfirmed: verdict.confirmed } : entry);
        writeJson(STORAGE_KEYS.history, history);
        historyPanel.refresh(history);
        // 把人工改过的分数回写缓存：双评换第二个账号时命中缓存拿到的是最终分，而不是模型原始分。
        if (cache && lastResult.cacheKey) cache.set(lastResult.cacheKey, lastResult);
        lastResult = null;
        panel.setSubtitle(options.silent ? "\u8FDE\u7EED\u6279\u9605\u4E2D" : "\u5DF2\u63D0\u4EA4\uFF0C\u7B49\u5F85\u4E0B\u4E00\u4EFD");
        if (options.silent) {
          panel.setStage("\u5DF2\u63D0\u4EA4\uFF0C\u7B49\u5F85\u6362\u5377");
        } else {
          panel.toast(verdict.confirmed ? "\u5DF2\u63D0\u4EA4\uFF08\u5E73\u53F0\u5DF2\u786E\u8BA4\uFF09" : "\u5DF2\u63D0\u4EA4");
          void waitForNextPaper(oldIdentity, oldScan).then((changed) => {
            if (changed) void detect();
            else panel.setSubtitle("\u672A\u68C0\u6D4B\u5230\u6362\u5377\uFF0C\u53EF\u7EE7\u7EED\u4EBA\u5DE5\u64CD\u4F5C");
          });
        }
        return { ok: true, oldIdentity, oldScan };
      } finally {
        submitting = false;
      }
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
        const changed = await waitForNextPaper(submitted.oldIdentity, submitted.oldScan);
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
      // 每次拿到阅卷文档都校验一次：平台路由切换会换掉 iframe，旧 hook 随之失效。
      ensureZhixueHook(doc);
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
    // 缓存写入是合并批量的，页面关闭前补一次落盘，避免丢最后几份结果。
    window.addEventListener("pagehide", () => cache?.flush?.());
    await detect();
  }
  void bootstrap().catch((error) => {
    console.warn("[\u667A\u9605\u6279\u6539\u52A9\u624B] \u542F\u52A8\u5931\u8D25", error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF");
  });
})();
