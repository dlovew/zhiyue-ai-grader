// ==UserScript==
// @name         智阅批改助手
// @namespace    zygr.local.grader
// @version      1.3.7
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
var ZYGR_VERSION = "1.3.7";
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
    scoreTotal: "#containter_topicTxt #totalScore",
    progress: ".progress"
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
  // 上一个命中的阅卷控件；容器页可能有多个 iframe（任务列表、图表、广告位），
  // 只认「打分框 + 提交按钮」都在的那个，否则填分和提交会打到别的 frame 上。
  // 新版智学网用 wujie 微前端把阅卷页渲染在 <wujie-app> 的 shadow root 里，
  // 所以这里找的是「根」：Document 或 ShadowRoot。
  var lastMarkingRoot = null;
  var capturedShadowRoots = [];
  // closed shadow root 拿不到 host.shadowRoot，只能在启动时包一层 attachShadow 记下来。
  function captureShadowRoots() {
    try {
      const win = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
      const proto = win?.Element?.prototype;
      if (!proto || typeof proto.attachShadow !== "function" || proto.attachShadow.__zygrCapture) return;
      const original = proto.attachShadow;
      const patched = function (init) {
        const root = original.call(this, init);
        try {
          if (String(this.tagName || "").toLowerCase() === "wujie-app") {
            capturedShadowRoots.push(root);
            if (capturedShadowRoots.length > 40) capturedShadowRoots.shift();
          }
        } catch { /* 记录失败不影响页面 */ }
        return root;
      };
      patched.__zygrCapture = true;
      proto.attachShadow = patched;
    } catch { /* 页面禁用或跨域时忽略 */ }
  }
  function shadowRootsOf(root) {
    const out = [];
    let hosts = [];
    try { hosts = Array.from(root.querySelectorAll("wujie-app")); } catch { return out; }
    for (const host of hosts) {
      const shadow = host.shadowRoot;
      if (!shadow || out.includes(shadow)) continue;
      out.push(shadow);
      for (const nested of shadowRootsOf(shadow)) out.push(nested);
    }
    return out;
  }
  function rootAlive(root) {
    if (!root) return false;
    try {
      if (root.nodeType === 11) return Boolean(root.host && root.host.isConnected);
      const win = root.defaultView;
      // iframe 整页导航后旧 document 会被换掉，win.document 不再指向它。
      if (!win || win.closed || win.document !== root) return false;
      const frame = win.frameElement;
      return !frame || frame.isConnected;
    } catch {
      return false;
    }
  }
  function rootWindow(root) {
    if (!root) return null;
    try {
      if (root.nodeType === 11) return root.ownerDocument?.defaultView || null;
      return root.defaultView || null;
    } catch {
      return null;
    }
  }
  function accessibleRoots() {
    const roots = [];
    const add = (root) => {
      if (root && !roots.includes(root)) roots.push(root);
    };
    const main = mainDoc();
    add(main);
    for (const shadow of shadowRootsOf(main)) add(shadow);
    for (const shadow of capturedShadowRoots) {
      try {
        if (shadow.host?.isConnected) add(shadow);
      } catch { /* 已失效的 root 跳过 */ }
    }
    for (const frame of Array.from(mainDoc().querySelectorAll("iframe"))) {
      try {
        const doc = frame.contentDocument ?? frame.contentWindow?.document ?? null;
        if (!doc) continue;
        add(doc);
        for (const shadow of shadowRootsOf(doc)) add(shadow);
      } catch { /* 跨域 frame 跳过 */ }
    }
    return roots;
  }
  function getMarkingRoot() {
    if (lastMarkingRoot && rootAlive(lastMarkingRoot)) return lastMarkingRoot;
    lastMarkingRoot = null;
    let fallback = null;
    for (const root of accessibleRoots()) {
      if (hasScoreInput(root) && hasSubmitButton(root)) {
        lastMarkingRoot = root;
        return root;
      }
      // 只有打分框、提交按钮还没渲染出来时先记着，等下一轮再确认。
      if (!fallback && hasScoreInput(root)) fallback = root;
    }
    return fallback;
  }
  captureShadowRoots();
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
    // do-while：timeout 为 0 时也要先扫一遍，供「没找到就轻量轮询」的调用方复用。
    do {
      for (const doc of accessibleRoots()) {
        if (hasScoreInput(doc) && hasSubmitButton(doc)) return doc;
        if (hasScoreInput(doc)) candidate = doc;
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    } while (true);
    return candidate;
  }
  function snapshotFrom(root) {
    let images = [];
    let fallback = [];
    for (const selector of [SELECTORS.answerImage, SELECTORS.answerImageNew]) {
      const found = Array.from(root.querySelectorAll(selector)).filter((image) => image.src);
      if (found.length === 0) continue;
      const shown = found.filter(visible);
      if (shown.length > 0) {
        images = shown;
        break;
      }
      // 首次打开时图片常常还没完成布局，getClientRects() 为空会被误判成隐藏。
      // 只要这个容器里一张可见的都没有，就退回未过滤的集合先把 URL 抓到，
      // 等图片 load 完成后由观察器再刷新一次。
      if (fallback.length === 0) fallback = found;
    }
    if (images.length === 0) images = fallback;
    if (images.length === 0) return { urls: [], keys: [], identity: null, ready: false };
    const urls = [...new Set(images.map((image) => image.currentSrc || image.src))];
    const rawKeys = images.map((image) => resourceKey(image.currentSrc || image.src));
    const keys = rawKeys.filter((key) => Boolean(key));
    const ready = images.every((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
    const identity = keys.length === images.length ? `zhixue:images:${JSON.stringify([...new Set(keys)].sort())}` : null;
    return { urls, keys, identity, ready: Boolean(identity) && ready };
  }
  function answerSnapshot(doc) {
    const primary = doc ? snapshotFrom(doc) : null;
    if (primary && primary.urls.length > 0) return primary;
    // 没有指定文档时先认阅卷控件；指定了但该文档里没图（图在别的 frame/shadow root）时也补扫一遍。
    const marking = getMarkingRoot();
    if (marking && marking !== doc) {
      const snapshot = snapshotFrom(marking);
      if (snapshot.urls.length > 0) return snapshot;
    }
    for (const root of accessibleRoots()) {
      if (root === doc) continue;
      const snapshot = snapshotFrom(root);
      if (snapshot.urls.length > 0) return snapshot;
    }
    return primary || { urls: [], keys: [], identity: null, ready: false };
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
    const root = doc ?? getMarkingRoot() ?? mainDoc();
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
      // 同一小题换人时题号不变，必须靠 scanRecordId 判断是否真的换卷。
      scanRecordId: String(hookCurrentField("scanRecordId") || ""),
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
  // 进度：页面文本「初评已阅量/任务量： 532/147」优先，接口 teacherMarked/teacherTodo 兜底。
  function readProgress(doc) {
    const root = doc ?? getMarkingRoot() ?? mainDoc();
    const text = root.querySelector(SELECTORS.progress)?.textContent || "";
    const match = text.match(/已阅量\s*\/\s*任务量\s*[：:]\s*(\d+)\s*\/\s*(\d+)/) || text.match(/(\d+)\s*\/\s*(\d+)/);
    if (match) return { marked: Number(match[1]), todo: Number(match[2]) };
    try {
      if (typeof hookProgress === "function") return hookProgress();
    } catch { /* 观察器不可用时忽略 */ }
    return null;
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
    if (inputs.length === 0) return { ok: false, error: "\u672A\u627E\u5230\u6253\u5206\u8F93\u5165\u6846" };
    // 数量对不上就说清楚是哪边少：报「第 2 个分数不是有效数字」没人看得懂。
    if (scores.length < inputs.length) {
      return { ok: false, error: `\u8FD9\u4EFD\u5377\u5B50\u6709 ${inputs.length} \u4E2A\u6253\u5206\u6846\uFF0C\u5F53\u524D\u7ED3\u679C\u53EA\u6709 ${scores.length} \u4E2A\u5206\u6570\uFF0C\u8BF7\u5148\u8865\u9F50\u5C0F\u9898\u5206` };
    }
    if (scores.length > inputs.length) {
      return { ok: false, error: `\u7ED3\u679C\u6709 ${scores.length} \u4E2A\u5206\u6570\uFF0C\u9875\u9762\u53EA\u6709 ${inputs.length} \u4E2A\u6253\u5206\u6846\uFF0C\u8BF7\u6838\u5BF9\u5C0F\u9898\u6570` };
    }
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
    const iframe = getMarkingRoot();
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
  // 打分框里当前的分数：定位到历史那一条后用它和记录分对账，识别「已被他人改分」。
  function readFilledScores(doc) {
    return getScoreInputs(doc)
      .map((input) => Number(input.element.value))
      .filter((value) => Number.isFinite(value));
  }
  // 换卷后打分框会先清空、再回填记录分。给平台一点时间落值，否则会读到空值或上一份的残留值。
  async function waitScoresSettled(doc, before, timeout = 1500) {
    const unchanged = (list) => list.length === before.length && list.every((value, index) => Math.abs(value - before[index]) < 0.05);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const current = readFilledScores(doc);
      if (current.length > 0 && !unchanged(current)) return current;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    return readFilledScores(doc);
  }
  // 短时换卷探测：提交回执丢失时用它兜底判定，纯墙钟计时，不受标签页是否可见影响。
  async function waitPaperChanged(oldIdentity, oldScan = "", timeout = 3e3) {
    if (!oldIdentity && !oldScan) return false;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const scan = currentScanRecordId();
      if (oldScan && scan && scan !== oldScan) return true;
      if (oldIdentity) {
        const snapshot = answerSnapshot();
        if (snapshot.identity && snapshot.identity !== oldIdentity) return true;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    }
    return false;
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
// 「回评上一份 / 下一份」走的是 markingBack / markingNext，返回结构与 scanrecorddetail 相同。
var HOOK_NAV = /markingBack|markingNext/i;
// 「阅卷记录」里点某一份走的是 loadMarked，返回结构同样属于「当前卷」。
var HOOK_LOAD = /loadMarked/i;
var hookState = { installed: false, doc: null, current: null, next: null, root: null, origin: "", updatedAt: 0 };

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
// 真机结构（2026-11 取样）：
// data.topicNumStr / data.topicInfo.topicNumStr = "43,1"
// data.topicInfo.detail = { scanRecordId, userCode, topicImageIds[签名URL], paperImgIds }
// data.cutBlock.subTopicScore = 当前小题满分（与打分框 score 属性一致）
// data.hasPrev / data.hasNext / data.markingCount / data.teacherTopic[]（teacherMarked/teacherTodo）
// preLoad 返回的是 data.nextTopicInfo，结构与 topicInfo 相同。
function hookIdentity(body, mode = "current") {
  const root = body && typeof body === "object" && body.data !== void 0 ? body.data : body;
  const info = (mode === "next" ? root?.nextTopicInfo : root?.topicInfo) || null;
  const detail = info?.detail || null;
  const cutBlock = root?.cutBlock || null;
  return {
    scanRecordId: detail?.scanRecordId || null,
    topicNumStr: info?.topicNumStr || (mode === "current" ? root?.topicNum : null) || null,
    userCode: detail?.userCode || null,
    markingPaperId: detail?.markingPaperId || root?.markingPaperId || null,
    // scanrecorddetail 在「未批过」的卷子上 trace 为 null，只有回评/记录跳转才有 trace.id。
    traceId: info?.trace?.id || null,
    // 只有 current 的 cutBlock 才有当前小题满分，next 里没有。
    subTopicScore: mode === "current" ? cutBlock?.subTopicScore ?? null : null,
    topicImageIds: detail?.topicImageIds || null,
    paperImgIds: detail?.paperImgIds || null,
    hasPrev: root?.hasPrev ?? null,
    hasNext: root?.hasNext ?? null
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
// 观察器拿到新卷后通知上层刷新题号/进度：页面 DOM 往往比请求先就绪，光靠 MutationObserver 会漏。
var hookListener = null;
function onHookUpdate(fn) {
  hookListener = typeof fn === "function" ? fn : null;
}
function notifyHookUpdate() {
  try {
    hookListener?.();
  } catch { /* 上层异常不影响解析 */ }
}
function handleHookResponse(url, payload) {
  if (!url || payload === null || payload === void 0) return false;
  // 阅卷接口的域名由平台路由下发（pt-ali-bj / pt-ali-hz ...），记下实际 origin 供回评检索复用。
  try {
    if (/\/marking\/marking\//i.test(url)) {
      const origin = new URL(url, "https://www.zhixue.com").origin;
      if (/^https?:$/.test(new URL(url, "https://www.zhixue.com").protocol)) hookState.origin = origin;
    }
  } catch { /* 解析失败保持上一次的 origin */ }
  let data = payload;
  // 多数请求 responseType 为空（文本），个别封装会直接给对象，两种都支持。
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return false;
    try {
      data = JSON.parse(trimmed);
    } catch {
      return false;
    }
  }
  if (!data || typeof data !== "object") return false;
  const body = data.data !== void 0 ? data.data : data;
  // 提交回执：优先看 result，兼容只有 success 的写法。
  if (HOOK_COMMIT.test(url)) {
    const result = hookField(body, "result");
    const success = hookField(body, "success");
    pushCommitSignal(typeof result === "string" ? result : success === true ? "success" : "");
    return true;
  }
  // preLoad 的地址里也含 scanrecorddetail，必须先判 next。
  if (HOOK_NEXT.test(url)) {
    hookState.next = hookIdentity(body, "next");
    hookState.updatedAt = Date.now();
    notifyHookUpdate();
    return true;
  }
  if (HOOK_CURRENT.test(url) || HOOK_NAV.test(url) || HOOK_LOAD.test(url)) {
    hookState.current = hookIdentity(body, "current");
    hookState.root = body && typeof body === "object" && body.data !== void 0 ? body.data : body;
    hookState.updatedAt = Date.now();
    notifyHookUpdate();
    return true;
  }
  return false;
}
function installZhixueHook(doc) {
  let win = null;
  try {
    win = rootWindow(doc);
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
          // responseType 为空时用文本，其它情况直接拿已解析对象。
          const raw = this.responseType === "" || this.responseType === "text"
            ? this.responseText
            : this.response;
          handleHookResponse(this.__zygrUrl, raw);
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
    if (hookState.installed && hookState.doc === doc && rootWindow(doc)?.XMLHttpRequest?.prototype?.[ZHIXUE_HOOK_FLAG]) return true;
  } catch { /* 跨域访问失败则重新装 */ }
  return installZhixueHook(doc);
}
function currentHookIdentity() {
  return hookState.current;
}
function nextHookIdentity() {
  return hookState.next;
}
// 阅卷接口实际域名：记录检索要用同一个 origin，硬编码会在换集群后 404。
function hookMarkingOrigin() {
  return hookState.origin || "";
}
// 当前小题的批量份数：>0 说明开了批量阅卷，直接调回评会把整批拉进来。
function hookCurrentBatchSize() {
  const root = hookState.root;
  const list = Array.isArray(root?.teacherTopic) ? root.teacherTopic : [];
  const current = hookState.current || {};
  const topic = list.find((item) => item && item.topicNumStr === current.topicNumStr) || null;
  return Number(topic?.batchSize ?? 0) || 0;
}
function freshAnswerImages() {
  const urls = [];
  hookUrlsFrom(hookState.current?.topicImageIds, urls);
  if (urls.length === 0) hookUrlsFrom(hookState.current?.paperImgIds, urls);
  if (urls.length === 0) hookUrlsFrom(hookState.next?.topicImageIds, urls);
  return [...new Set(urls)];
}
// 进度：markingCount 是已批份数，teacherTodo 是当前小题任务量（真机字段）。
function hookProgress() {
  const root = hookState.root;
  if (!root) return null;
  const list = Array.isArray(root.teacherTopic) ? root.teacherTopic : [];
  const current = hookState.current || {};
  const topic = list.find((item) => item && item.topicNumStr === current.topicNumStr) || list[0] || null;
  const marked = Number(root.markingCount ?? topic?.teacherMarked ?? 0) || 0;
  const todo = Number(topic?.teacherTodo ?? 0) || 0;
  if (!marked && !todo) return null;
  return { marked, todo };
}
// src/adapters/zhixue-jump.ts
// 历史记录「定位到该卷」：完全复用阅卷页自己的「阅卷记录」链路——
// 先按题号对齐，再用 searchMarked 把学号换成记录 id，最后调页面自己的回评方法（内部走 loadMarked）。
// 不硬编码接口域名：origin 取自观察器实际看到的阅卷接口地址。
var JUMP_PAGE_CONCURRENCY = 4;
var JUMP_MAX_PAGES = 80;
var JUMP_CACHE_TTL = 6e4;
var jumpRecordCache = { key: "", at: 0, map: null };

// 题号口径：接口的 "43,1" 对应页面上的 "43(1)"，"44" 保持原样。
function jumpTopicLabel(topicNumStr) {
  const text = String(topicNumStr || "").trim();
  if (!text) return "";
  const parts = text.split(",");
  return parts.length > 1 ? `${parts[0]}(${parts[1]})` : parts[0];
}
// 反向归一：历史里可能存的是 DOM 口径 "43(1)"（当时还没拿到接口题号），
// 检索接口只认 "43,1"，不转就会查不到任何记录。
function jumpApiTopicNum(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d+)\s*[（(]\s*(\d+)\s*[)）]$/);
  return match ? `${match[1]},${match[2]}` : text;
}
function jumpCurrentTopicLabel(doc) {
  const root = doc || getMarkingRoot() || mainDoc();
  const text = (root.querySelector(SELECTORS.topicIndex)?.textContent || "").replace(/\s/g, "");
  return text.replace(/^第/, "").replace(/题$/, "");
}
function jumpWaitFor(predicate, timeout, step = 150) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeout;
    const tick = () => {
      let ok = false;
      try {
        ok = Boolean(predicate());
      } catch {
        ok = false;
      }
      if (ok) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      window.setTimeout(tick, step);
    };
    tick();
  });
}
// Vue 2 把组件实例挂在根元素上，从已知节点往上摸一层就能拿到页面组件。
function jumpVueOf(element) {
  let node = element;
  for (let i = 0; i < 8 && node; i += 1) {
    if (node.__vue__) return node.__vue__;
    node = node.parentElement;
  }
  return null;
}
// 回评方法：页面组件是 returnMarkingPushToCherkItem，记录面板组件是 toCherkItem。
function jumpFindVue(doc) {
  const root = doc || getMarkingRoot() || mainDoc();
  for (const selector of [".personal_box", "#app", "#remarking_box", "body"]) {
    const element = root.querySelector(selector);
    if (!element) continue;
    const vm = jumpVueOf(element);
    if (!vm) continue;
    if (typeof vm.returnMarkingPushToCherkItem === "function") return { vm, method: "returnMarkingPushToCherkItem" };
    if (typeof vm.toCherkItem === "function") return { vm, method: "toCherkItem" };
  }
  return null;
}
// 切题号：和老师手点题号列表一样，点完等标题真的变过去。
async function jumpSwitchTopic(doc, label, timeout = 1e4) {
  const root = doc || getMarkingRoot() || mainDoc();
  if (!label || jumpCurrentTopicLabel(root) === label) return true;
  const links = Array.from(root.querySelectorAll("#topicList .topiclist-content a"));
  const target = links.find((item) => (item.textContent || "").trim() === label);
  if (!target) return false;
  target.click();
  return jumpWaitFor(() => jumpCurrentTopicLabel(root) === label, timeout);
}
// 阅卷接口域名由平台路由下发。观察器还没抓到任何请求时（脚本刚装、页面早就打开），
// 直接问一次路由配置，别让用户为了点一下「定位」去刷新阅卷页。
async function jumpResolveOrigin(win, markingPaperId) {
  const known = hookMarkingOrigin();
  if (known) return known;
  if (!win || typeof win.fetch !== "function" || !markingPaperId) return "";
  try {
    const url = `/routingconfig/businessRoutingConfig/getHostByBusinessId?businessType=markingPaper&businessId=${encodeURIComponent(markingPaperId)}&t=${Date.now()}`;
    const response = await win.fetch(url, { credentials: "include" });
    const body = await response.json();
    const host = String(body?.data?.host || "").trim();
    if (!host) return "";
    return new URL(/^https?:/i.test(host) ? host : `https://${host}`).origin;
  } catch {
    return "";
  }
}
function jumpPostForm(win, url, params) {
  const body = Object.keys(params)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key] == null ? "" : params[key])}`)
    .join("&");
  const fetchImpl = win && typeof win.fetch === "function" ? win.fetch.bind(win) : fetch;
  return fetchImpl(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  }).then((response) => response.json());
}
async function jumpFetchMarkedPage(win, origin, markingPaperId, topicNumStr, pageIndex) {
  const sort = String(topicNumStr || "").split(",")[0];
  const data = await jumpPostForm(win, `${origin}/marking/marking/personal/searchMarked/`, {
    markingPaperId,
    topicSorts: JSON.stringify([sort]),
    topicNumStr,
    score: "",
    pageIndex: String(pageIndex),
    isArbitration: "false",
    superiority: ""
  });
  return {
    pageInfo: data?.pageInfo || null,
    list: Array.isArray(data?.pageList) ? data.pageList : []
  };
}
// 学号 → 记录 id。记录列表按批改时间倒序，最近批的几乎都在第一页，命中即停。
async function jumpFindRecord(win, origin, markingPaperId, topicNumStr, userCode, onPage) {
  const key = `${markingPaperId}|${topicNumStr}`;
  const now = Date.now();
  const reusable = jumpRecordCache.key === key && jumpRecordCache.map && now - jumpRecordCache.at < JUMP_CACHE_TTL;
  if (reusable) {
    const hit = jumpRecordCache.map[userCode];
    if (hit) return hit;
  }
  const map = reusable ? { ...jumpRecordCache.map } : {};
  let totalPages = 1;
  let pageIndex = 0;
  while (pageIndex < totalPages && pageIndex < JUMP_MAX_PAGES) {
    const batch = [];
    for (let i = 0; i < JUMP_PAGE_CONCURRENCY && pageIndex + i < totalPages; i += 1) batch.push(pageIndex + i);
    const pages = await Promise.all(
      batch.map((index) => jumpFetchMarkedPage(win, origin, markingPaperId, topicNumStr, index).catch(() => null))
    );
    pages.forEach((page) => {
      if (!page) return;
      const total = Number(page.pageInfo?.totalPage);
      if (Number.isFinite(total) && total > totalPages) totalPages = total;
      page.list.forEach((item) => {
        if (!item || !item.userCode || !item.id || map[item.userCode]) return;
        map[item.userCode] = { id: item.id, userCode: item.userCode, totalScore: item.totalScore, score: item.score };
      });
    });
    jumpRecordCache = { key, at: Date.now(), map };
    if (map[userCode]) return map[userCode];
    pageIndex += batch.length;
    if (onPage) onPage(Math.min(pageIndex, totalPages), totalPages);
  }
  return null;
}
// 调页面自己的回评方法，再等作答图真的换成另一份。
async function jumpApplyRecord(doc, record) {
  const found = jumpFindVue(doc);
  if (!found) return { ok: false, error: "未找到阅卷页面的回评入口，请按浏览器 F5 刷新当前页面后重试" };
  const before = answerSnapshot(doc).identity;
  const item = { id: record.id, userCode: record.userCode, totalScore: record.totalScore, score: record.score };
  try {
    if (found.method === "toCherkItem") found.vm.toCherkItem(record.id, void 0, item);
    else found.vm.returnMarkingPushToCherkItem(record.id, void 0, item);
  } catch (error) {
    return { ok: false, error: `回评该卷失败：${error instanceof Error ? error.message : error}` };
  }
  const changed = await jumpWaitFor(() => {
    const after = answerSnapshot(doc).identity;
    return Boolean(after) && after !== before;
  }, 8e3);
  return { ok: true, changed, record };
}
// 入口：按历史记录的定位字段把阅卷页切到那一份卷。
async function jumpToMarkedRecord(entry, options = {}) {
  const question = entry?.question || {};
  const identity = question.identity || {};
  const doc = options.doc || getMarkingRoot() || mainDoc();
  if (!doc) return { ok: false, error: "未检测到阅卷控件，请先打开阅卷页" };
  const win = rootWindow(doc);
  const userCode = String(identity.userCode || "").trim();
  const markingPaperId = String(identity.markingPaperId || hookCurrentField("markingPaperId") || "").trim();
  const origin = await jumpResolveOrigin(win, markingPaperId);
  // 身份里的题号是接口口径，优先用它；历史字段可能是 DOM 口径，统一转成 "43,1" 再查。
  const topicNumStr = jumpApiTopicNum(identity.topicNumStr || question.topicNumStr || "");
  if (!userCode) return { ok: false, error: "该记录没有学号，无法定位（旧版记录不支持定位）" };
  if (!origin) return { ok: false, error: "尚未抓到阅卷接口地址，请按浏览器 F5 刷新当前页面后重试" };
  if (!markingPaperId) return { ok: false, error: "该记录缺少试卷 ID，无法定位" };
  // 批量阅卷开着时，回评会把整批一起拉进来，直接拒绝比悄悄改错卷安全。
  if (typeof hookCurrentBatchSize === "function" && hookCurrentBatchSize() > 0) {
    return { ok: false, error: "当前小题开启了批量阅卷，请先关闭批量再定位" };
  }
  const label = jumpTopicLabel(topicNumStr);
  if (label && jumpCurrentTopicLabel(doc) !== label) {
    const switched = await jumpSwitchTopic(doc, label, 1e4);
    if (!switched) return { ok: false, error: `未能切换到题号 ${label}` };
  }
  let record = question.recordId ? { id: question.recordId, userCode, totalScore: question.recordScore ?? null } : null;
  if (!record) {
    record = await jumpFindRecord(win, origin, markingPaperId, topicNumStr, userCode, options.onPage);
    if (!record) return { ok: false, error: `未在阅卷记录里找到学号 ${userCode} 的卷子` };
  }
  const applied = await jumpApplyRecord(doc, record);
  return { ...applied, topicNumStr, userCode };
}
// 提交成功后顺手把记录 id 解析出来写回历史，下次点「定位」就是零等待。
// 学号缺失时（脚本晚于首份卷加载）退一步：记录列表按批改时间倒序，刚提交的那份就在最前面，
// 用「分数对得上」+「只认前三行」两个约束把它捞回来，否则这条历史永远定位不了。
async function resolveMarkedRecordId(doc, identity, expectedScore) {
  const userCode = String(identity?.userCode || "").trim();
  const topicNumStr = jumpApiTopicNum(identity?.topicNumStr || "");
  if (!doc || !topicNumStr) return null;
  // 观察器漏了首份卷时 identity 是空的：提交后平台会加载下一份卷，接口随即带上试卷 ID，
  // 同一场考试的 ID 是同一个，等它几秒就能补齐。
  let markingPaperId = String(identity?.markingPaperId || "").trim();
  if (!markingPaperId) {
    const deadline = Date.now() + 6e3;
    while (!markingPaperId && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 200));
      markingPaperId = String(hookCurrentField("markingPaperId") || "").trim();
    }
  }
  if (!markingPaperId) return null;
  const win = rootWindow(doc);
  const origin = await jumpResolveOrigin(win, markingPaperId);
  if (!origin) return null;
  try {
    const page = await jumpFetchMarkedPage(win, origin, markingPaperId, topicNumStr, 0);
    let hit = userCode ? page.list.find((item) => item && String(item.userCode) === userCode) : null;
    let inferred = false;
    if (!hit && Number.isFinite(Number(expectedScore))) {
      hit = page.list.slice(0, 3).find((item) => item && item.id && Math.abs(Number(item.totalScore) - Number(expectedScore)) < 0.05) || null;
      inferred = Boolean(hit);
    }
    if (!hit) return null;
    const resolvedUser = String(hit.userCode || userCode || "");
    if (!resolvedUser) return null;
    jumpRecordCache = {
      key: `${markingPaperId}|${topicNumStr}`,
      at: Date.now(),
      map: { ...(jumpRecordCache.key === `${markingPaperId}|${topicNumStr}` ? jumpRecordCache.map || {} : {}), [resolvedUser]: hit }
    };
    return { id: hit.id, userCode: resolvedUser, totalScore: hit.totalScore, inferred };
  } catch {
    return null;
  }
}
  // src/infra/storage.ts
  var STORAGE_KEYS = {
    config: "zygr.config.v1",
    history: "zygr.history.v1",
    cache: "zygr.cache.v1",
    stats: "zygr.stats.v1",
    cacheProbe: "zygr.cache-probe.v1",
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
    historyLimit: 500,
    // 连续批阅份数上限：大型考试常有几千份，保留一个硬上限防止无人看管时无限跑。
    continuousLimit: 20,
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
        keys: isRecord(data.keys) ? data.keys : {},
        models: isRecord(data.models) ? data.models : {},
        thinkingModes: isRecord(data.thinkingModes) ? data.thinkingModes : {},
        rubrics: isRecord(data.rubrics) ? data.rubrics : {}
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
    removeKey(STORAGE_KEYS.cacheProbe);
    removeKey(STORAGE_KEYS.thinkingForced);
    removeKey(PRESET_STORAGE_KEY);
    removeKey(RUBRIC_LIBRARY_KEY);
    removeKey(PLATFORM_KEYS_KEY);
    removeKey(PLATFORM_MODELS_KEY);
    removeKey(PLATFORM_THINKING_KEY);
    removeKey("zygr.submit.skipConfirm.v1");
  }

  // src/core/rubric-library.ts
  // 评分标准库：按「试卷 + 题号」保存题目 / 参考答案 / 评分标准 / 满分 / 学科。
  // 切题时自动把当前这份存回旧槽、把新题号已存的那份载入，省掉每换一题重填一遍。
  var RUBRIC_LIBRARY_KEY = "zygr.rubrics.v1";
  var RUBRIC_LIBRARY_LIMIT = 300;

  // 槽位键：同一场考试的试卷 ID + 题号；没有试卷 ID 时退回只有题号（旧记录也能用）。
  // 题号统一成接口口径（43,1）：否则观察器晚到时会从 43(1) 变成 43,1，同一道题被当成两道。
  function rubricTopicKey(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    return typeof jumpApiTopicNum === "function" ? jumpApiTopicNum(text) : text;
  }
  function currentPaperId() {
    // 观察器拿到试卷 ID 后，即使 question.identity 还没补上，也用真实 ID 当槽位，
    // 否则同一份卷会先存进 "paper|43,1"、再存进 "<真实ID>|43,1"，切题时读不到自己刚存的标准。
    try {
      if (typeof hookCurrentField !== "function") return "";
      return String(hookCurrentField("markingPaperId") || "").trim();
    } catch {
      return "";
    }
  }
  function rubricSlotKey(question) {
    const identity = question?.identity || {};
    const paper = String(identity.markingPaperId || "").trim() || currentPaperId();
    const topic = rubricTopicKey(question?.topicNumStr || question?.questionId || "");
    if (!topic) return "";
    return `${paper || "paper"}|${topic}`;
  }
  // 老版本按 DOM 题号存过 "paper|43(1)"：读取时统一成接口口径，避免同一题两份标准。
  function normalizeRubricSlot(slot) {
    const text = String(slot || "").trim();
    if (!text) return "";
    const split = text.indexOf("|");
    if (split < 0) return rubricTopicKey(text);
    const storedPaper = text.slice(0, split).trim() || "paper";
    // 老记录可能在接口身份到位前按通用 paper 存；现在知道真实试卷 ID 就并过去。
    const paper = storedPaper === "paper" ? (currentPaperId() || storedPaper) : storedPaper;
    const topic = rubricTopicKey(text.slice(split + 1));
    return topic ? `${paper}|${topic}` : "";
  }
  function rubricSlotLabel(question) {
    return String(question?.topicNumStr || question?.questionId || "").trim();
  }
  function rubricContextSnapshot(context) {
    const source = isRecord(context) ? context : {};
    return {
      question: String(source.question || ""),
      answer: String(source.answer || ""),
      rubric: String(source.rubric || ""),
      maxScore: Number(source.maxScore) || 0,
      subject: String(source.subject || ""),
      updatedAt: Date.now()
    };
  }
  // 只取配置里存在的那五个字段，别把 updatedAt 之类的书签字段写回 config。
  function rubricContextFields(context) {
    const source = context || {};
    return {
      question: String(source.question || ""),
      answer: String(source.answer || ""),
      rubric: String(source.rubric || ""),
      maxScore: Number(source.maxScore) || 0,
      subject: String(source.subject || "")
    };
  }
  function rubricHasContent(snapshot) {
    const value = snapshot || {};
    return Boolean(String(value.answer || "").trim() || String(value.rubric || "").trim() || String(value.question || "").trim());
  }
  function sameRubricContext(a, b) {
    const left = a || {};
    const right = b || {};
    return String(left.question || "") === String(right.question || "")
      && String(left.answer || "") === String(right.answer || "")
      && String(left.rubric || "") === String(right.rubric || "")
      && (Number(left.maxScore) || 0) === (Number(right.maxScore) || 0)
      && String(left.subject || "") === String(right.subject || "");
  }
  function loadRubricLibrary() {
    const raw = readJson(RUBRIC_LIBRARY_KEY, {});
    if (!isRecord(raw)) return {};
    // 只在真有旧键/坏记录时回写一次，正常路径不产生额外存储写入。
    let migrated = false;
    const normalized = {};
    Object.keys(raw).forEach((slot) => {
      const key = normalizeRubricSlot(slot);
      const entry = raw[slot];
      if (key !== slot) migrated = true;
      if (!key || !isRecord(entry)) {
        migrated = true;
        return;
      }
      const previous = normalized[key];
      if (!previous || (Number(entry.updatedAt) || 0) > (Number(previous.updatedAt) || 0)) normalized[key] = entry;
    });
    if (migrated) saveRubricLibrary(normalized);
    return normalized;
  }
  function saveRubricLibrary(map) {
    return writeJson(RUBRIC_LIBRARY_KEY, map);
  }
  function getRubricPreset(slot) {
    const key = normalizeRubricSlot(slot);
    if (!key) return null;
    const library = loadRubricLibrary();
    if (isRecord(library[key])) return library[key];
    // 当前还没拿到试卷 ID 时键会退化成 "paper|43,2"；库里若只有一条同题号记录，
    // 说明就是同一场考试，直接复用，避免切回来时看起来「标准没了」。
    const split = key.indexOf("|");
    if (split < 0 || key.slice(0, split) !== "paper") return null;
    const topic = key.slice(split + 1);
    const matches = Object.keys(library).filter((item) => item.endsWith(`|${topic}`));
    return matches.length === 1 ? library[matches[0]] : null;
  }
  function putRubricPreset(slot, context) {
    const key = normalizeRubricSlot(slot);
    if (!key) return false;
    const snapshot = rubricContextSnapshot(context);
    if (!rubricHasContent(snapshot)) return false;
    const library = loadRubricLibrary();
    library[key] = snapshot;
    const keys = Object.keys(library);
    // 超量时按更新时间淘汰最旧的，避免本地存储无限膨胀。
    if (keys.length > RUBRIC_LIBRARY_LIMIT) {
      keys.sort((a, b) => (Number(library[a]?.updatedAt) || 0) - (Number(library[b]?.updatedAt) || 0));
      for (const key of keys.slice(0, keys.length - RUBRIC_LIBRARY_LIMIT)) delete library[key];
    }
    return saveRubricLibrary(library);
  }
  function removeRubricPreset(slot) {
    const key = normalizeRubricSlot(slot);
    if (!key) return false;
    const library = loadRubricLibrary();
    if (!Object.prototype.hasOwnProperty.call(library, key)) return false;
    delete library[key];
    return saveRubricLibrary(library);
  }
  function countRubricPresets() {
    return Object.keys(loadRubricLibrary()).length;
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
// 前缀缓存诊断：同一段固定文本在同一模型上连续 0 命中，多半是该模型不支持缓存、
// 或文本没达到最小缓存长度。这里只累计响应自带的 usage，不产生任何额外请求。
var CACHE_PROBE_LIMIT = 40;
var CACHE_PROBE_TTL = 12 * 36e5;
function loadCacheProbe() {
  const raw = readJson(STORAGE_KEYS.cacheProbe, {});
  return isRecord(raw) ? raw : {};
}
function pruneCacheProbe(map) {
  const now = Date.now();
  const kept = {};
  const entries = Object.keys(map)
    .map((key) => [key, map[key]])
    .filter(([, item]) => isRecord(item) && now - Number(item.at || 0) < CACHE_PROBE_TTL)
    .sort((a, b) => Number(b[1].at || 0) - Number(a[1].at || 0))
    .slice(0, CACHE_PROBE_LIMIT);
  for (const [key, item] of entries) kept[key] = item;
  return kept;
}
// 命中一次就把连续计数清零；everHit 用来区分「模型不支持」和「前缀这次才变」。
// 分组键用「题目」而不是前缀哈希：这样即便前缀每份都在变，也能累计出连续未命中，
// 同时 prefixHash 的变化次数能反过来指出「是这道题的前缀不稳」。
function noteCacheProbe(input) {
  const key = `${input.platform || "custom"}|${input.model || ""}|${input.questionKey || "当前题目"}`;
  const map = pruneCacheProbe(loadCacheProbe());
  const prev = isRecord(map[key]) ? map[key] : {};
  const hit = Number(input.cached) > 0;
  const drifted = Boolean(prev.prefixHash) && prev.prefixHash !== String(input.prefixHash || "");
  const record = {
    at: Date.now(),
    prefixHash: String(input.prefixHash || ""),
    streak: hit ? 0 : Number(prev.streak || 0) + 1,
    everHit: Boolean(prev.everHit) || hit,
    driftCount: hit ? 0 : Number(prev.driftCount || 0) + (drifted ? 1 : 0),
    textTokens: Number(input.textTokens) || Number(prev.textTokens) || 0,
    promptTokens: Number(input.promptTokens) || 0
  };
  map[key] = record;
  writeJson(STORAGE_KEYS.cacheProbe, map);
  return record;
}
// 同一模型在其它题上命中过，说明模型本身支持缓存，本次更可能是文本太短或前缀被改动。
function modelCacheEverHit(platform, model) {
  const prefix = `${platform || "custom"}|${model || ""}|`;
  const map = loadCacheProbe();
  return Object.keys(map).some((key) => key.startsWith(prefix) && Boolean(map[key]?.everHit));
}

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
function judgeSubmit(hookActive2, signal, paperChanged = false) {
  if (!hookActive2) return { ok: true, confirmed: false, reason: "", inferred: false };
  // 观察器活着但没等到 commitTopic 回执：先看卷子有没有真的换，再决定要不要报错。
  if (!signal) {
    // 回执被别的请求挤掉、或平台改成分步上报时很常见；此时卷子已经换了，说明分数确实落库。
    if (paperChanged) return { ok: true, confirmed: false, reason: "", inferred: true };
    return {
      ok: false,
      confirmed: false,
      inferred: false,
      reason: "\u672A\u6536\u5230\u5E73\u53F0\u63D0\u4EA4\u56DE\u6267\uFF0C\u5206\u6570\u53EF\u80FD\u672A\u5199\u5165\uFF0C\u8BF7\u68C0\u67E5\u6253\u5206\u6846\u540E\u91CD\u8BD5"
    };
  }
  if (signal.ok === true) return { ok: true, confirmed: true, reason: "", inferred: false };
  // 平台明确拒绝时不看换卷：换卷可能是老师自己点「回评下一份」造成的，不能拿它掩盖失败。
  return {
    ok: false,
    confirmed: false,
    inferred: false,
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
  // 平台定位字段：旧记录可能没有 identity，这里统一兜底为空串。
  function entryIdentity(entry) {
    const identity = entry?.question?.identity || {};
    return {
      topicNumStr: entry?.question?.topicNumStr || identity.topicNumStr || entry?.question?.questionId || "",
      scanRecordId: identity.scanRecordId || "",
      userCode: identity.userCode || ""
    };
  }
  function toCsv(entries) {
    const header = [
      "\u65F6\u95F4",
      "\u9898\u53F7",
      "\u63A5\u53E3\u9898\u53F7",
      "\u626B\u63CF\u8BB0\u5F55ID",
      "\u5B66\u53F7",
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
      "\u786E\u8BA4\u5206",
      "\u590D\u6838\u72B6\u6001",
      "\u8F93\u5165 Token",
      "\u524D\u7F00\u547D\u4E2D Token",
      "\u8F93\u51FA Token",
      "\u601D\u8003 Token",
      "\u547D\u4E2D",
      "\u8017\u65F6\uFF08\u79D2\uFF09"
    ];
    const rows = entries.map((entry) => {
      const usage = entryUsage(entry);
      const id = entryIdentity(entry);
      return [
        new Date(entry.createdAt).toLocaleString("zh-CN"),
        entry.question.questionId,
        id.topicNumStr,
        id.scanRecordId,
        id.userCode,
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
        entry.confirmedScore === void 0 || entry.confirmedScore === null ? "" : entry.confirmedScore,
        entry.reviewedAt ? "\u5DF2\u590D\u6838" : "\u672A\u590D\u6838",
        usage.prompt,
        usage.cached,
        usage.completion,
        usage.reasoning,
        entryHitText(entry),
        entryElapsed(entry)
      ];
    });
    const summary = summarizeEntries(entries);
    // 末尾追加一行汇总：第 3～17 列是逐条字段，留空避免与逐条数据混读；只填合计列。
    const summaryRow = [
      "\u6C47\u603B",
      `\u5171 ${summary.total} \u6761`,
      // 接口题号到复核状态共 15 列留空（第 3～17 列）
      "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
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
      const identity = entryIdentity(entry);
      return `
     <tr>
       <td>${escapeHtml(new Date(entry.createdAt).toLocaleString("zh-CN"))}</td>
       <td>${escapeHtml(entry.question.questionId)}</td>
       <td>${escapeHtml(identity.topicNumStr)}</td>
       <td>${escapeHtml(identity.scanRecordId)}</td>
       <td>${escapeHtml(identity.userCode)}</td>
       <td>${escapeHtml(entry.result.pipeline)}</td>
       <td>${escapeHtml(entry.result.model)}</td>
       <td>${escapeHtml(entry.result.status)}</td>
       <td>${escapeHtml(entry.result.score)} / ${escapeHtml(entry.result.maxScore)}</td>
       <td>${escapeHtml(subScoreText(entry))}</td>
       <td>${escapeHtml(entry.result.reason)}</td>
       <td>${escapeHtml(entry.confirmedScore ?? "")}</td>
       <td>${entry.reviewedAt ? "\u5DF2\u590D\u6838" : "\u672A\u590D\u6838"}</td>
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
  <table><thead><tr><th>\u65F6\u95F4</th><th>\u9898\u53F7</th><th>\u63A5\u53E3\u9898\u53F7</th><th>\u626B\u63CF\u8BB0\u5F55ID</th><th>\u5B66\u53F7</th><th>\u94FE\u8DEF</th><th>\u6A21\u578B</th><th>\u72B6\u6001</th><th>\u5F97\u5206</th><th>\u5C0F\u9898\u5206</th><th>\u4F9D\u636E</th><th>\u786E\u8BA4\u5206</th><th>\u590D\u6838</th><th>\u8F93\u5165 Token</th><th>\u524D\u7F00\u547D\u4E2D</th><th>\u8F93\u51FA Token</th><th>\u601D\u8003 Token</th><th>\u547D\u4E2D</th><th>\u8017\u65F6\uFF08\u79D2\uFF09</th><th>\u6807\u8BB0</th></tr></thead><tbody>${rows}</tbody></table>
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
  // 历史遗留：自定义预设的 UI 已下线，这个键只留给「清空数据」擦除老版本残留。
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
    {
      id: "qiniu",
      label: "七牛云 AI（Qiniu）",
      endpoint: "https://api.qnaigc.com/v1/chat/completions",
      models: ["deepseek/deepseek-v4.1-flash-1017", "deepseek/deepseek-v3.2-251201"],
      authHeader: "bearer",
      // 七牛文档：DeepSeek / Claude 用 thinking.type 开关，Qwen 系用 enable_thinking。
      // Conatus 是融合模型，底层路由不固定；DeepSeek/Conatus 同时带上 reasoning_effort=none
      // 做双保险，能覆盖更多底层模型的关闭口径（仍不保证强制思考的路由）。
      thinkingFields: { off: { thinking: { type: "disabled" }, reasoning_effort: "none" } },
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

  function listPlatformPresets() {
    return BUILTIN_PLATFORM_PRESETS.slice();
  }

  function getPlatformPreset(id) {
    return listPlatformPresets().find((preset) => preset.id === id) || null;
  }

  // 各平台最小缓存长度的参考文案：只用于「未命中」解释弹窗，不参与请求构造。
  // 数值来自各家文档（2026-11），平台调门槛不影响批改链路。
  var CACHE_MIN_NOTES = {
    deepseek: "DeepSeek 官方最小缓存单元约 64 token",
    sensenova: "商汤未公开缓存门槛，只能按返回字段判断",
    siliconflow: "硅基流动仅部分模型支持缓存，门槛未公开",
    moonshot: "Kimi 按块缓存，最小块长未公开；kimi-k3 命中价约为输入价 1/10",
    dashscope: "通义千问最小 1024 token（隐式约 0.2x，显式约 0.1x）",
    zhipu: "智谱建议 500 token 以上，实测约 128 token 起就有命中",
    "volcengine-chat": "火山默认 1024 token（部分模型 2048；deepseek-v4.1-flash 约 128–256）",
    "opencode-ai": "取决于它背后的模型，门槛以底层平台为准",
    custom: "多数平台 1024 起；DeepSeek 64、智谱约 128 是最低的两个"
  };
  function getPlatformCacheNote(id) {
    return CACHE_MIN_NOTES[String(id || "custom")] || CACHE_MIN_NOTES.custom;
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

  // 已下线的内置平台：预设条目已删除，这里只保留鉴权方式，避免历史配置静默退回 bearer 而失效。
  var LEGACY_PLATFORM_AUTH = { "azure-openai": "api-key" };

  // 七牛云网关（国内 api.qnaigc.com / 海外 api.modelink.ai）下不同模型关闭思考的字段不同：
  // DeepSeek / Claude 用 thinking.type，Qwen 系用 enable_thinking。用户常把七牛地址填在
  // 「自定义」里，所以按域名兜底，不要求先切换平台预设。
  function qiniuThinkingCompat(endpoint, model) {
    if (!/\/\/(?:api\.qnaigc\.com|api\.modelink\.ai)\//i.test(String(endpoint || ""))) return null;
    const name = String(model || "");
    if (/qwen/i.test(name)) {
      return { disableThinkingKey: "enable_thinking", thinkingValues: {}, thinkingFields: { off: { enable_thinking: false } } };
    }
    // DeepSeek / Conatus：thinking.type 为主，reasoning_effort=none 兜底；
    // Claude 等其他模型只发 thinking.type，避免把不认识的字段塞给上游。
    const off = /deepseek|conatus/i.test(name)
      ? { thinking: { type: "disabled" }, reasoning_effort: "none" }
      : { thinking: { type: "disabled" } };
    return { disableThinkingKey: "thinking", thinkingValues: {}, thinkingFields: { off } };
  }

  // 把平台预设与服务上的手动覆盖合并成统一的请求档案。
  // 显式字段（service.endpoint / service.model）优先，预设只在其为空时提供建议值。
  function resolveProfile(service) {
    const src = isRecord(service) ? service : {};
    const preset = getPlatformPreset(src.platform) || getPlatformPreset("custom") || {};
    const compat = isRecord(src.compat) ? src.compat : {};
    const legacyAuth = LEGACY_PLATFORM_AUTH[String(src.platform || "")];
    const authHeader = ["bearer", "api-key", "none"].includes(compat.authHeader) ? compat.authHeader : (legacyAuth || preset.authHeader || "bearer");
    const endpoint = normalizeEndpoint(String(src.endpoint || preset.endpoint || ""));
    // 用户也可能用「自定义」手填火山 / 七牛地址；按域名兜底，套用对应平台的思考字段。
    const volcEndpoint = /\/\/ark\.[^/]*\.volces\.com\//i.test(endpoint);
    const behaviorPreset = volcEndpoint ? (getPlatformPreset("volcengine-chat") || preset) : preset;
    const qiniuCompat = qiniuThinkingCompat(endpoint, src.model);
    const thinkingPreset = qiniuCompat ? { ...behaviorPreset, ...qiniuCompat } : behaviorPreset;
    return {
      id: preset.id || "custom",
      label: preset.label || "自定义",
      endpoint,
      model: String(src.model || ""),
      models: Array.isArray(behaviorPreset.models) ? behaviorPreset.models : [],
      // 个别平台的模型列表接口与推理接口不同域，预设可单独指定。
      modelsUrl: String(behaviorPreset.modelsEndpoint || "").trim(),
      thinkingLevels: getPlatformThinkingLevels(behaviorPreset.id),
      apiKey: String(src.apiKey || ""),
      authHeader,
      authHeaderName: authHeader === "api-key" ? "api-key" : "Authorization",
      disableThinkingKey: Object.prototype.hasOwnProperty.call(compat, "disableThinkingKey") ? compat.disableThinkingKey : (thinkingPreset.disableThinkingKey ?? null),
      thinkingValues: Object.prototype.hasOwnProperty.call(compat, "thinkingValues") ? normalizeThinkingValues(compat.thinkingValues) : normalizeThinkingValues(thinkingPreset.thinkingValues),
      thinkingFields: Object.prototype.hasOwnProperty.call(compat, "thinkingFields") ? normalizeThinkingValues(compat.thinkingFields) : normalizeThinkingValues(thinkingPreset.thinkingFields),
      jsonModeKey: Object.prototype.hasOwnProperty.call(compat, "jsonModeKey")
        ? compat.jsonModeKey
        : (Object.prototype.hasOwnProperty.call(behaviorPreset, "jsonModeKey") ? behaviorPreset.jsonModeKey : "response_format"),
      stream: typeof compat.stream === "boolean" ? compat.stream : Boolean(behaviorPreset.stream)
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

  // 纯文本 token 估算：中日韩汉字、全角标点按 1 token，其余按 4 字符 1 token。
  // 只给「缓存门槛」提示用，不参与限流预算，避免改变既有发送节奏。
  function estimateTextTokens(text) {
    const value = String(text || "");
    let wide = 0;
    let narrow = 0;
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      const isWide = (code >= 0x3000 && code <= 0x303f) || (code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef);
      if (isWide) wide += 1;
      else narrow += 1;
    }
    return Math.ceil(wide + narrow / 4);
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
        // 有些网关用 HTTP 200 返回错误体，必须显式识别，否则会被误报成「缺少文本内容」。
        if (body?.error && !extractContent(body)) {
          const detail = parseProviderError(response.responseText) || body.error?.message || "\u672A\u77E5\u9519\u8BEF";
          const error = new Error(`\u63A5\u53E3\u8FD4\u56DE HTTP 200 \u4F46\u5E26\u9519\u8BEF\uFF1A${detail}`);
          error.status = 200;
          error.providerMessage = String(detail);
          throw error;
        }
        const content = extractContent(body);
        // usage 是响应自带字段，读取它不会产生任何额外 token。
        if (typeof options.onUsage === "function") {
          try {
            options.onUsage(extractUsage(body));
          } catch { /* 回调异常不影响批改 */ }
        }
        // 思考占满输出预算时正文会被截断：有正文就交给上层「按已产出内容捞分 + 强制人工复核」，
        // 只有连正文都没有（思考独占了全部预算）才在这里作废，绝不把空正文当零分。
        if (body?.choices?.[0]?.finish_reason === "length" && !(typeof content === "string" && content.trim())) {
          const truncated = new Error("\u6A21\u578B\u8F93\u51FA\u88AB\u957F\u5EA6\u4E0A\u9650\u622A\u65AD\uFF08finish_reason=length\uFF09\u4E14\u6CA1\u6709\u53EF\u89E3\u6790\u7684\u6B63\u6587\uFF0C\u672C\u6B21\u7ED3\u679C\u4F5C\u5E9F\uFF1A\u8BF7\u5173\u95ED\u601D\u8003\u6216\u7F29\u77ED\u8BC4\u5206\u6807\u51C6");
          truncated.code = "truncated";
          throw truncated;
        }
        if (typeof content === "string" && content) {
          if (body?.choices?.[0]?.finish_reason === "length" && typeof options.onTruncated === "function") {
            try { options.onTruncated(); } catch { /* 回调异常不影响批改 */ }
          }
          return content;
        }
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

  // 视觉校验图：白底黑字的大号 4 位随机数字。文本模型看不到数字，只能拒答或瞎猜。
  // 用 canvas 现场生成 PNG，避免依赖外链，也不会被平台的图片域名校验挡住。
  function visionProbeImage() {
    if (typeof document === "undefined" || !document.createElement) return null;
    try {
      const code = Array.from({ length: 4 }, () => Math.floor(Math.random() * 10)).join("");
      const canvas = document.createElement("canvas");
      canvas.width = 480;
      canvas.height = 160;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#111111";
      context.font = '700 96px "PingFang SC", "Microsoft YaHei", Arial, sans-serif';
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(code, canvas.width / 2, canvas.height / 2 + 4);
      const dataUrl = canvas.toDataURL("image/png");
      if (!dataUrl.startsWith("data:image/png")) return null;
      return { code, dataUrl };
    } catch {
      return null;
    }
  }

  // 真·多模态测试：必须能把图里的随机数字读回来，纯文本模型在这一步就会被挡住。
  async function probeVision(service, rateLimiter) {
    const probe = visionProbeImage();
    if (!probe) {
      return { ok: true, skipped: true, verdict: "\u5F53\u524D\u73AF\u5883\u65E0\u6CD5\u751F\u6210\u6D4B\u8BD5\u56FE\u7247\uFF0C\u5DF2\u8DF3\u8FC7\u89C6\u89C9\u6821\u9A8C" };
    }
    const text = await chatCompletion(
      service,
      [{
        role: "user",
        content: [
          { type: "text", text: "\u53EA\u56DE\u590D\u56FE\u7247\u4E2D\u7684 4 \u4F4D\u6570\u5B57\uFF0C\u4E0D\u8981\u89E3\u91CA\u3002" },
          { type: "image_url", image_url: { url: probe.dataUrl, detail: "high" } }
        ]
      }],
      { rateLimiter, timeoutMs: 3e4, retries: 1, maxTokens: 800, estimatedTokens: 300 }
    );
    const digits = String(text || "").replace(/[^0-9]/g, "");
    if (digits.includes(probe.code)) {
      return { ok: true, verdict: "\u56FE\u7247\u8BFB\u53D6\u6B63\u5E38" };
    }
    return {
      ok: false,
      verdict: `\u6A21\u578B\u300C${service.model}\u300D\u672A\u80FD\u8BFB\u53D6\u6D4B\u8BD5\u56FE\u7247\uFF08\u56DE\u590D\uFF1A${sampleText(text) || "\u7A7A"}\uFF09\uFF0C\u53EF\u80FD\u4E0D\u662F\u591A\u6A21\u6001\u6A21\u578B`
    };
  }

  async function testConnection(service, rateLimiter) {
    const result = await probeVision(service, rateLimiter);
    if (!result.ok) throw new Error(result.verdict);
    return true;
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
    // 只做等比缩小，绝不放大：放大不会带来新信息，只会被服务商的短边归一化规则再插值一次。
    const scale = Math.min(1, config.maxEdge / Math.max(sourceWidth, sourceHeight));
    const output = document.createElement("canvas");
    output.width = Math.max(1, Math.round(sourceWidth * scale));
    output.height = Math.max(1, Math.round(sourceHeight * scale));
    const outputCtx = output.getContext("2d", { willReadFrequently: true });
    if (!outputCtx) throw new Error("\u65E0\u6CD5\u521B\u5EFA\u753B\u5E03\u4E0A\u4E0B\u6587");
    outputCtx.drawImage(image, 0, 0, output.width, output.height);
    // 空白率在缩放后的画布上采样：整幅扫描图直接 getImageData 一次就是几十 MB，且结果没有区别。
    const ratio = blankRatio(outputCtx, output.width, output.height);
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
  // 学科 → 题型。按中学实际卷面结构列，且每个题型都要在 RUBRIC_TYPE_HINTS 里有专门提示，
  // 否则「切换题型」只有名字进提示词，判分口径一模一样，等于没选。
  var RUBRIC_SUBJECTS = {
    "\u8BED\u6587": ["\u73B0\u4EE3\u6587\u9605\u8BFB", "\u53E4\u8BD7\u6587\u9605\u8BFB", "\u6587\u8A00\u6587\u7FFB\u8BD1", "\u8BED\u8A00\u6587\u5B57\u8FD0\u7528", "\u540D\u53E5\u9ED8\u5199", "\u4F5C\u6587"],
    "\u6570\u5B66": ["\u9009\u62E9\u9898", "\u586B\u7A7A\u9898", "\u89E3\u7B54\u9898", "\u8BC1\u660E\u9898", "\u5E94\u7528\u9898"],
    "\u82F1\u8BED": ["\u9605\u8BFB\u7406\u89E3", "\u5B8C\u5F62\u586B\u7A7A", "\u8BED\u6CD5\u586B\u7A7A", "\u77ED\u6587\u6539\u9519", "\u7FFB\u8BD1", "\u4F5C\u6587"],
    "\u7269\u7406": ["\u9009\u62E9\u9898", "\u586B\u7A7A\u9898", "\u5B9E\u9A8C\u9898", "\u8BA1\u7B97\u9898", "\u7B80\u7B54\u9898"],
    "\u5316\u5B66": ["\u9009\u62E9\u9898", "\u586B\u7A7A\u9898", "\u5B9E\u9A8C\u9898", "\u8BA1\u7B97\u9898", "\u65B9\u7A0B\u5F0F\u4E66\u5199", "\u7B80\u7B54\u9898"],
    "\u751F\u7269": ["\u9009\u62E9\u9898", "\u586B\u7A7A\u9898", "\u5B9E\u9A8C\u9898", "\u8BC6\u56FE\u9898", "\u9057\u4F20\u63A8\u65AD\u9898", "\u7B80\u7B54\u9898"],
    "\u5386\u53F2": ["\u9009\u62E9\u9898", "\u586B\u7A7A\u9898", "\u6750\u6599\u5206\u6790\u9898", "\u7B80\u7B54\u9898", "\u8BBA\u8FF0\u9898"],
    "\u653F\u6CBB": ["\u9009\u62E9\u9898", "\u586B\u7A7A\u9898", "\u6750\u6599\u5206\u6790\u9898", "\u8FA8\u6790\u9898", "\u7B80\u7B54\u9898", "\u8BBA\u8FF0\u9898"],
    "\u5730\u7406": ["\u9009\u62E9\u9898", "\u586B\u7A7A\u9898", "\u8BFB\u56FE\u9898", "\u7EFC\u5408\u9898", "\u6750\u6599\u5206\u6790\u9898", "\u7B80\u7B54\u9898"]
  };

  var RUBRIC_TYPE_HINTS = {
    "\u4F5C\u6587": "\u6309\u5185\u5BB9\u3001\u7ED3\u6784\u3001\u8BED\u8A00\u3001\u4E66\u5199\u7B49\u7EF4\u5EA6\u5212\u5206\u6863\u6B21\uFF0C\u6BCF\u6863\u7ED9\u51FA\u5206\u6570\u533A\u95F4\u4E0E\u53EF\u89C2\u5BDF\u7684\u7279\u5F81\u3002",
    "\u9009\u62E9\u9898": "\u7B54\u6848\u552F\u4E00\uFF0C\u53EA\u9700\u7ED9\u51FA\u6B63\u786E\u9009\u9879\u4E0E\u5F97\u5206\u6761\u4EF6\u3002",
    "\u586B\u7A7A\u9898": "\u9010\u7A7A\u5217\u51FA\u6B63\u786E\u7B54\u6848\u4E0E\u5BB9\u8BB8\u7B49\u4EF7\u5199\u6CD5\uFF0C\u6BCF\u7A7A\u5355\u72EC\u8BA1\u5206\u3002",
    "\u89E3\u7B54\u9898": "\u6309\u6B65\u9AA4\u7ED9\u5206\uFF1A\u516C\u5F0F\u6B63\u786E\u3001\u4EE3\u5165\u8FC7\u7A0B\u3001\u8BA1\u7B97\u7ED3\u679C、\u5355\u4F4D\u4E0E\u7B54\u8BED\u5206\u522B\u8BBE\u5206\u70B9\u3002",
    "\u8BC1\u660E\u9898": "\u6309\u5173\u952E\u8BBA\u636E\u3001\u63A8\u7406\u94FE\u3001\u7ED3\u8BBA\u9010\u6B65\u7ED9\u5206\uFF0C\u6BCF\u4E00\u5FC5\u8981\u7B49\u5F0F\u6216\u5B9A\u7406\u4F5C\u4E3A\u72EC\u7ACB\u5F97\u5206\u70B9\u3002",
    "\u5E94\u7528\u9898": "\u5EFA\u6A21\u3001\u5217\u5F0F\u3001\u6C42\u89E3\u3001\u4F5C\u7B54\u56DB\u6BB5\u5206\u522B\u8BBE\u70B9\uFF0C\u53EA\u7ED9\u7ED3\u679C\u65E0\u8FC7\u7A0B\u4E0D\u7ED9\u6EE1\u5206\u3002",
    "\u5B9E\u9A8C\u9898": "\u5206\u522B\u5BF9\u5B9E\u9A8C\u539F\u7406\u3001\u64CD\u4F5C\u6B65\u9AA4\u3001\u73B0\u8C61\u8BB0\u5F55\u3001\u7ED3\u8BBA\u3001\u8BEF\u5DEE\u5206\u6790\u8BBE\u5F97\u5206\u70B9\u3002",
    "\u8BA1\u7B97\u9898": "\u516C\u5F0F\u3001\u4EE3\u5165\u8FC7\u7A0B\u3001\u7ED3\u679C\u6570\u503C\u4E0E\u5355\u4F4D\u5206\u522B\u8BBE\u70B9\uFF0C\u53EA\u5199\u7ED3\u679C\u6700\u591A\u7ED9\u8BE5\u70B9\u4E00\u534A\u3002",
    "\u7B80\u7B54\u9898": "\u6309\u8981\u70B9\u5206\u70B9\u7ED9\u5206\uFF0C\u6BCF\u70B9\u72EC\u7ACB\u5224\u5B9A\uFF0C\u7B54\u5230\u5373\u5F97\u5206\uFF0C\u7B54\u4E0D\u5230\u4E0D\u5012\u6263\u3002",
    "\u65B9\u7A0B\u5F0F\u4E66\u5199": "\u5316\u5B66\u5F0F\u3001\u914D\u5E73\u3001\u53CD\u5E94\u6761\u4EF6\u3001\u2191\u2193\u7B26\u53F7\u5206\u522B\u8BBE\u70B9\uFF0C\u7F3A\u4E00\u9879\u6263\u5BF9\u5E94\u70B9\u3002",
    "\u8BC6\u56FE\u9898": "\u5148\u8003\u67E5\u56FE\u4E2D\u7ED3\u6784\u8BC6\u522B\u662F\u5426\u51C6\u786E\uFF0C\u518D\u8003\u67E5\u529F\u80FD\u63CF\u8FF0\uFF1B\u8BC6\u522B\u9519\u8BEF\u5219\u8BE5\u70B9\u4E0D\u5F97\u5206\u3002",
    "\u9057\u4F20\u63A8\u65AD\u9898": "\u57FA\u56E0\u578B\u3001\u8868\u73B0\u578B\u3001\u6BD4\u4F8B\u5206\u522B\u8BBE\u70B9\uFF0C\u63A8\u5BFC\u8FC7\u7A0B\u4E0E\u7ED3\u8BBA\u5206\u5F00\u5224\u5206\u3002",
    "\u6750\u6599\u5206\u6790\u9898": "\u6309\u70B9\u7ED9\u5206\uFF1A\u4ECE\u6807\u51C6\u7B54\u6848\u4E2D\u62BD\u51FA\u6BCF\u4E00\u4E2A\u53EF\u72EC\u7ACB\u5224\u5B9A\u7684\u5F97\u5206\u70B9\uFF0C\u7B54\u5230\u5373\u7ED9\u8BE5\u70B9\u5206\u503C\uFF0C\u672A\u7B54\u5230\u4E0D\u7ED9\u5206\u3002",
    "\u8FA8\u6790\u9898": "\u5148\u5224\u65AD\u89C2\u70B9\u5BF9\u9519\u518D\u5206\u5C42\u5206\u6790\uFF0C\u5224\u65AD\u4E0E\u5206\u6790\u5206\u522B\u8BBE\u70B9\uFF0C\u53EA\u6709\u5224\u65AD\u6CA1\u5206\u6790\u53EA\u5F97\u5224\u65AD\u5206\u3002",
    "\u8BBA\u8FF0\u9898": "\u6309\u89C2\u70B9\u3001\u8BBA\u636E\u3001\u8BBA\u8BC1\u8FC7\u7A0B\u3001\u7ED3\u8BBA\u5212\u5206\u6863\u6B21\uFF0C\u7ED9\u51FA\u5404\u6863\u5206\u6570\u533A\u95F4\u4E0E\u7279\u5F81\u3002",
    "\u7EFC\u5408\u9898": "\u6309\u70B9\u7ED9\u5206\uFF1A\u6BCF\u4E00\u4E2A\u53EF\u5224\u5B9A\u7684\u7B54\u6848\u8981\u70B9\u4F5C\u4E3A\u72EC\u7ACB\u5F97\u5206\u70B9\uFF0C\u7B54\u5230\u5373\u7ED9\u5206\uFF0C\u7B54\u4E0D\u5230\u70B9\u4E0D\u7ED9\u8BE5\u70B9\u5206\u503C\u4E14\u4E0D\u5012\u6263\u3002",
    "\u8BFB\u56FE\u9898": "\u5148\u8003\u5BDF\u56FE\u4E2D\u4FE1\u606F\u63D0\u53D6\u662F\u5426\u5B8C\u6574\uFF0C\u518D\u8003\u5BDF\u63CF\u8FF0\u662F\u5426\u51C6\u786E\uFF0C\u6BCF\u9879\u4FE1\u606F\u5355\u72EC\u8BA1\u5206\u3002",
    "\u73B0\u4EE3\u6587\u9605\u8BFB": "\u6309\u8BBE\u95EE\u5206\u70B9\u4F5C\u7B54\uFF0C\u6BCF\u4E2A\u8981\u70B9\u9700\u5BF9\u5E94\u539F\u6587\u4F9D\u636E\uFF1B\u53EA\u6709\u6982\u681C\u6CA1\u6709\u4F9D\u636E\u7684\u6309\u534A\u5206\u3002",
    "\u53E4\u8BD7\u6587\u9605\u8BFB": "\u5206\u70B9\u4F5C\u7B54\u5E76\u5F15\u7528\u539F\u53E5\u4F50\u8BC1\uFF0C\u7406\u89E3\u6027\u9ED8\u5199\u9519\u5B57\u4E0D\u5F97\u5206\u3002",
    "\u6587\u8A00\u6587\u7FFB\u8BD1": "\u6309\u91CD\u70B9\u5B9E\u8BCD\u3001\u865A\u8BCD\u3001\u53E5\u5F0F\u3001\u53E5\u610F\u56DB\u9879\u5206\u522B\u8BBE\u70B9\uFF0C\u76F4\u8BD1\u4E3A\u4E3B\uFF0C\u610F\u8BD1\u6309\u70B9\u7ED9\u5206\u3002",
    "\u8BED\u8A00\u6587\u5B57\u8FD0\u7528": "\u6309\u6BCF\u9898\u7684\u8BBE\u95EE\u6307\u4EE4\u9010\u6761\u5224\u5206\uFF0C\u7B26\u5408\u9898\u5E72\u8981\u6C42\u624D\u5F97\u5206\u3002",
    "\u540D\u53E5\u9ED8\u5199": "\u4E0A\u4E0B\u53E5\u5B8C\u6574\u3001\u65E0\u9519\u522B\u5B57\u624D\u5F97\u5206\uFF0C\u4E00\u53E5\u9519\u5219\u8BE5\u53E5\u4E0D\u5F97\u5206\u3002",
    "\u9605\u8BFB\u7406\u89E3": "\u6309\u4FE1\u606F\u5B9A\u4F4D\u3001\u63A8\u65AD\u3001\u4E3B\u65E8\u6982\u681C\u5206\u522B\u8BBE\u70B9\uFF0C\u7B54\u6848\u9700\u80FD\u5728\u539F\u6587\u627E\u5230\u4F9D\u636E\u3002",
    "\u5B8C\u5F62\u586B\u7A7A": "\u6BCF\u7A7A\u552F\u4E00\u7B54\u6848\uFF0C\u7ED3\u5408\u4E0A\u4E0B\u6587\u8BED\u7BC7\u5224\u65AD\uFF0C\u4E0D\u6309\u8BED\u6CD5\u5B64\u7ACB\u5224\u5206\u3002",
    "\u8BED\u6CD5\u586B\u7A7A": "\u6BCF\u7A7A\u4E00\u8BCD\uFF0C\u8BCD\u5F62\u53D8\u5316\u4E0E\u5927\u5C0F\u5199\u89C4\u8303\uFF0C\u9519\u8BEF\u4E0D\u5F97\u5206\u3002",
    "\u77ED\u6587\u6539\u9519": "\u6BCF\u5904\u9519\u8BEF\u5355\u72EC\u8BA1\u5206\uFF0C\u6539\u5BF9\u4F4D\u7F6E\u4F46\u6539\u9519\u5185\u5BB9\u4E0D\u5F97\u5206\u3002",
    "\u7FFB\u8BD1": "\u6309\u5173\u952E\u8BCD\u3001\u53E5\u5F0F\u7ED3\u6784\u3001\u8BED\u6C14\u8BF4\u5F97\u5206\u70B9\uFF0C\u5141\u8BB8\u540C\u4E49\u8868\u8FBE\u3002"
  };

  // 同一题型在不同学科里判分重点不同，这条补充要求挂在基础提示后面。
  var RUBRIC_SUBJECT_TYPE_HINTS = {
    "\u5730\u7406|\u8BFB\u56FE\u9898": "\u5FC5\u987B\u70B9\u660E\u56FE\u4E2D\u51FA\u73B0\u7684\u65B9\u4F4D\u3001\u56FE\u4F8B\u3001\u7B49\u503C\u7EBF\u6216\u7EDF\u8BA1\u91CF\uFF1B\u53EA\u5199\u7ED3\u8BBA\u4E0D\u5F15\u56FE\u4E0D\u5F97\u5206\uFF1B\u63CF\u8FF0\u6309\u65B9\u4F4D/\u5206\u5E03/\u53D8\u5316/\u6570\u503C\u5206\u5C42\u3002",
    "\u5730\u7406|\u7EFC\u5408\u9898": "\u5148\u505A\u533A\u57DF\u5B9A\u4F4D\u5E76\u63D0\u53D6\u6750\u6599\u4FE1\u606F\uFF0C\u518D\u6309\u81EA\u7136\u8981\u7D20\uFF08\u6C14\u5019\u3001\u5730\u5F62\u3001\u6C34\u6587\u3001\u571F\u58E4\uFF09\u4E0E\u4EBA\u6587\u8981\u7D20\uFF08\u5E02\u573A\u3001\u4EA4\u901A\u3001\u52B3\u52A8\u529B\uFF09\u5206\u5F00\u5217\u70B9\uFF1B\u6BCF\u70B9\u5199\u6210\u201C\u4F9D\u636E\u2192\u7ED3\u8BBA\u201D\uFF0C\u53EA\u5199\u7ED3\u8BBA\u6700\u591A\u7ED9\u4E00\u534A\uFF0C\u540C\u4E00\u8981\u7D20\u4E0D\u91CD\u590D\u7ED9\u5206\u3002",
    "\u5730\u7406|\u586B\u7A7A\u9898": "\u5730\u540D\u3001\u65B9\u4F4D\u3001\u6570\u503C\u6309\u552F\u4E00\u7B54\u6848\u5224\u5206\uFF0C\u5141\u8BB8\u540C\u4E49\u5199\u6CD5\uFF0C\u9519\u522B\u5B57\u6309\u9519\u7B54\u5904\u7406\u3002",
    "\u5730\u7406|\u6750\u6599\u5206\u6790\u9898": "\u5148\u63D0\u53D6\u6750\u6599\u4E2D\u7684\u6587\u5B57\u4E0E\u56FE\u8868\u4FE1\u606F\uFF0C\u518D\u5BF9\u5E94\u5730\u7406\u539F\u7406\uFF1B\u6BCF\u4E2A\u91C7\u5206\u70B9\u6CE8\u660E\u6750\u6599\u4F9D\u636E\uFF0C\u7F3A\u4F9D\u636E\u6309\u534A\u989D\u3002",
    "\u5730\u7406|\u7B80\u7B54\u9898": "\u6309\u70B9\u7ED9\u5206\uFF0C\u6BCF\u70B9\u843D\u5230\u672C\u9898\u533A\u57DF\uFF1B\u672F\u8BED\u4E0E\u7B49\u4EF7\u8868\u8FF0\u660E\u786E\uFF0C\u53EA\u5199\u7ED3\u8BBA\u4E0D\u7ED9\u6EE1\u5206\u3002",
    "\u5316\u5B66|\u586B\u7A7A\u9898": "\u5316\u5B66\u5F0F\u3001\u79BB\u5B50\u7B26\u53F7\u3001\u53CD\u5E94\u6761\u4EF6\u6309\u89C4\u8303\u4E66\u5199\u5224\u5206\uFF0C\u914D\u5E73\u9519\u8BEF\u8BE5\u7A7A\u4E0D\u5F97\u5206\u3002",
    "\u5316\u5B66|\u65B9\u7A0B\u5F0F\u4E66\u5199": "\u5316\u5B66\u5F0F\u6B63\u786E\u3001\u914D\u5E73\u3001\u6761\u4EF6\u4E0E\u2191\u2193\u7B26\u53F7\u9F50\u5168\u624D\u7ED9\u6EE1\u5206\uFF0C\u7F3A\u4E00\u9879\u6309\u70B9\u6263\u3002",
    "\u751F\u7269|\u9057\u4F20\u63A8\u65AD\u9898": "\u57FA\u56E0\u578B\u3001\u8868\u73B0\u578B\u3001\u6BD4\u4F8B\u5206\u522B\u8BBE\u5206\uFF0C\u63A8\u5BFC\u8FC7\u7A0B\u7F3A\u5931\u4F46\u7ED3\u8BBA\u6B63\u786E\u7684\u6309\u534A\u7ED9\u3002",
    "\u7269\u7406|\u8BA1\u7B97\u9898": "\u516C\u5F0F\u3001\u4EE3\u5165\u8FC7\u7A0B\u3001\u7ED3\u679C\u4E0E\u5355\u4F4D\u5206\u522B\u8BBE\u70B9\uFF0C\u53EA\u5199\u7ED3\u679C\u6700\u591A\u7ED9\u8BE5\u70B9\u4E00\u534A\u3002",
    "\u6570\u5B66|\u8BC1\u660E\u9898": "\u6BCF\u4E00\u6B65\u63A8\u7406\u5FC5\u987B\u6709\u4F9D\u636E\uFF08\u5B9A\u7406\u6216\u9898\u8BBE\u6761\u4EF6\uFF09\uFF0C\u8DF3\u6B65\u6309\u7F3A\u5931\u7684\u63A8\u7406\u70B9\u6263\u5206\u3002",
    "\u8BED\u6587|\u540D\u53E5\u9ED8\u5199": "\u9519\u5B57\u3001\u6F0F\u5B57\u3001\u591A\u5B57\u8BE5\u53E5\u4E0D\u5F97\u5206\uFF0C\u4E0D\u6309\u6BD4\u4F8B\u7ED9\u5206\u3002",
    "\u82F1\u8BED|\u77ED\u6587\u6539\u9519": "\u6BCF\u5904\u9519\u8BEF\u5355\u72EC\u8BA1\u5206\uFF0C\u6539\u5BF9\u4F4D\u7F6E\u4F46\u6539\u9519\u5185\u5BB9\u4E0D\u5F97\u5206\u3002",
    "\u82F1\u8BED|\u8BED\u6CD5\u586B\u7A7A": "\u6BCF\u7A7A\u4E00\u8BCD\uFF0C\u8BCD\u5F62\u53D8\u5316\u9519\u8BEF\u4E0D\u5F97\u5206\uFF0C\u5927\u5C0F\u5199\u9519\u8BEF\u6309\u9519\u7B54\u5904\u7406\u3002",
    "\u653F\u6CBB|\u8FA8\u6790\u9898": "\u5148\u5224\u65AD\u89C2\u70B9\u5BF9\u9519\u518D\u5206\u6790\u7406\u7531\uFF0C\u53EA\u6709\u5224\u65AD\u6CA1\u6709\u5206\u6790\u53EA\u5F97\u5224\u65AD\u5206\u3002"
  };

  function rubricScoringMode(type) {
    const value = String(type || "");
    return (value.indexOf("\u4F5C\u6587") >= 0 || value.indexOf("\u8BBA\u8FF0") >= 0) ? "tier" : "point";
  }

  function rubricTypeHint(subject, type) {
    const value = String(type || "");
    let hint = RUBRIC_TYPE_HINTS[value] || "";
    if (!hint) {
      // 题型名不完全命中时按关键词归并，保证每类都能落到一条具体口径上。
      if (value.indexOf("\u4F5C\u6587") >= 0 || value.indexOf("\u8BBA\u8FF0") >= 0) hint = RUBRIC_TYPE_HINTS["\u4F5C\u6587"];
      else if (value.indexOf("\u5B9E\u9A8C") >= 0) hint = RUBRIC_TYPE_HINTS["\u5B9E\u9A8C\u9898"];
      else if (value.indexOf("\u8BA1\u7B97") >= 0) hint = RUBRIC_TYPE_HINTS["\u8BA1\u7B97\u9898"];
      else if (value.indexOf("\u586B\u7A7A") >= 0) hint = RUBRIC_TYPE_HINTS["\u586B\u7A7A\u9898"];
      else if (value.indexOf("\u9605\u8BFB") >= 0) hint = RUBRIC_TYPE_HINTS["\u9605\u8BFB\u7406\u89E3"];
      else hint = "\u6309\u70B9\u7ED9\u5206\uFF1A\u9010\u6761\u5217\u51FA\u53EF\u5224\u5B9A\u7684\u5F97\u5206\u70B9\uFF0C\u6BCF\u70B9\u6CE8\u660E\u5206\u503C\uFF0C\u672A\u7B54\u5230\u7684\u70B9\u4E0D\u7ED9\u5206\u4E14\u4E0D\u5012\u6263\u3002";
    }
    const extra = RUBRIC_SUBJECT_TYPE_HINTS[`${String(subject || "")}|${value}`];
    return extra ? `${hint}${extra}` : hint;
  }

  // 题型到底影响了什么：给界面一句人话摘要，避免「选了题型却不知道有啥用」。
  // 地理阅卷的共性口径：区域定位、因果链、等价表述、“任答几点”上限。
  // 这些直接决定同一份答案不同老师给分是否一致，所以写死在生成提示里。
  function buildGeographyGuide(type, question, maxScore) {
    const value = String(type || "");
    const text = String(question || "");
    const lines = [
      "地理学科硬性要求（必须落实到得分点）：",
      "1. 先写一行【区域与材料】：位置（经纬度/海陆/相对位置）、图名与图例、关键统计量或等值线特征；得分点必须落到本题区域，不得写通用模板。",
      "2. 每个得分点写成「依据/原理 → 结论」，只写结论不写依据的该点最多给一半；形成过程题按时间或因果顺序拆分，缺一环按点扣。",
      "3. 明确列出可接受的等价表述与必须出现的地理术语（如“降水丰富/降水多”“市场广阔/需求量大”），意思正确但口语化的按等价给分。",
      "4. 自然要素与人文要素分开列；有利/不利、内因/外因成对出现的分别设点；同一维度不重复给分。",
      "5. 以学校标准答案的采分点为准，不合并、不新增；写“任答两点/答出其中三点”的严格按上限计分；写“言之有理即可”的按论据质量给分，不要求逐字一致。",
      "6. 6 分及以上至少拆 3 个独立得分点，每点 1–2 分；未答到的点不给分，不倒扣。",
      "7. 常见失分写进扣分/不给分：因果倒置、区域错位、只答现象不答成因、漏限制条件（季节/方位/尺度）、只答单方面、术语错误。",
      "8. 多小问按小问分节，每小问分值之和等于该小问满分；题目没给各小问分值时按总分平均分配并注明。"
    ];
    if (/综合|材料/.test(value)) {
      lines.push("9. 综合/材料题先提取材料中的文字与图表信息，再对应地理原理；每个采分点注明「材料依据 + 原理 + 结论」，缺材料依据的按半额。");
    }
    if (/读图/.test(value)) {
      lines.push("9. 读图题按「方位/分布/变化/数值」分层描述；判读错位、漏图例或漏单位的该点不得分。");
    }
    if (/是否|赞同|反对|建议|措施|理由|谈谈|看法/.test(text)) {
      lines.push("9. 开放性设问先明确观点（1 分），再给至少两条结合本题区域的论据（每条 1–2 分）；只表态不给论据不得分；合理即可。");
    }
    return lines.join("\n");
  }

  function rubricRuleSummary(subject, type) {
    const mode = rubricScoringMode(type) === "tier" ? "\u6863\u6B21\u7ED9\u5206" : "\u6309\u70B9\u7ED9\u5206";
    const hint = rubricTypeHint(subject, type).split("\u3002")[0];
    return `${mode} \xB7 ${hint}\u3002`;
  }

  function buildRubricPrompt(payload) {
    const question = String(payload?.question || "").trim();
    const answerText = String(payload?.answerText || "").trim();
    const hasImages = Boolean(payload?.hasImages);
    const maxScore = Number(payload?.maxScore) || 0;
    const mode = rubricScoringMode(payload?.questionType);
    const subject = String(payload?.subject || "").trim();
    const questionType = String(payload?.questionType || "");
    const isGeography = subject === "地理";
    const geoGuide = isGeography ? buildGeographyGuide(questionType, question, maxScore) : "";
    // 地理综合/材料题要多写区域、因果链和常见失分，800 字会挤掉关键信息。
    const charLimit = isGeography && /综合|材料/.test(questionType) ? 1000 : isGeography ? 900 : 800;
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
      geoGuide || null,
      "",
      "\u8BF7\u4E25\u683C\u6309\u4EE5\u4E0B\u7ED3\u6784\u8F93\u51FA\u7EAF\u6587\u672C\uFF08\u4E0D\u8981 Markdown \u4EE3\u7801\u5757\uFF0C\u4E0D\u8981\u5BD2\u6696\uFF09\uFF1A",
      "\u4E00\u3001\u9898\u578B\u4E0E\u5206\u503C\u5EFA\u8BAE",
      "\u4E8C\u3001\u5F97\u5206\u70B9",
      isGeography ? "\uFF08\u5148\u5199\u4E00\u884C\u3010\u533A\u57DF\u4E0E\u6750\u6599\u3011\uFF1A\u4F4D\u7F6E/\u56FE\u4F8B/\u5173\u952E\u6570\u636E\uFF1B\u518D\u9010\u6761\u5217\u5F97\u5206\u70B9\uFF09" : null,
      "1. \u6BCF\u9879\u5F97\u5206\u70B9\u5355\u72EC\u4E00\u884C\uFF0C\u6CE8\u660E\u5177\u4F53\u5206\u503C\u3002",
      "\u4E09\u3001\u6263\u5206\u89C4\u5219",
      `- ${deductionRule}`,
      "\u56DB\u3001\u6863\u6B21\u5212\u5206",
      tierRule,
      "\u4E94\u3001\u7279\u6B8A\u60C5\u51B5",
      "- \u672A\u4F5C\u7B54\u3001\u7A7A\u767D\u3001\u7B54\u975E\u6240\u95EE\u3001\u5408\u7406\u4F46\u4E0E\u6807\u51C6\u7B54\u6848\u8868\u8FBE\u4E0D\u540C\u7684\u60C5\u5F62\u5982\u4F55\u5904\u7406\u3002",
      "",
      "\u8981\u6C42\uFF1A",
      "- \u5982\u679C\u3010\u5B66\u6821\u6807\u51C6\u7B54\u6848\u3011\u91CC\u5DF2\u7ECF\u5199\u6210\u8BC4\u5206\u7EC6\u5219/\u91C7\u5206\u70B9\uFF0C\u6309\u539F\u6587\u62C6\u5206\uFF0C\u4FDD\u7559\u539F\u6709\u5206\u503C\u4E0E\u201C\u4EFB\u7B54\u201D\u201C\u8A00\u4E4B\u6709\u7406\u201D\u7B49\u9650\u5B9A\u8BCD\uFF0C\u4E0D\u5F97\u65B0\u589E\u6216\u5408\u5E76\u91C7\u5206\u70B9\u3002",
      "- \u5F97\u5206\u70B9\u5FC5\u987B\u5177\u4F53\u3001\u53EF\u5224\u5B9A\uFF0C\u907F\u514D\u201C\u914D\u60C5\u7ED9\u5206\u201D\u7B49\u6A21\u7CCA\u8868\u8FF0\u3002",
      maxScore > 0 ? `- \u5404\u5F97\u5206\u70B9\u5206\u503C\u4E4B\u548C\u5FC5\u987B\u7B49\u4E8E\u6EE1\u5206 ${maxScore} \u5206\uFF1B\u672A\u7B54\u5230\u7684\u5F97\u5206\u70B9\u53EA\u662F\u4E0D\u7ED9\u5206\uFF0C\u4E0D\u5F97\u5199\u6210\u5012\u6263\u6216\u8D1F\u5206\u3002` : "- \u5404\u5F97\u5206\u70B9\u5206\u503C\u4E4B\u548C\u5E94\u7B49\u4E8E\u672C\u9898\u6EE1\u5206\uFF1B\u672A\u7B54\u5230\u7684\u5F97\u5206\u70B9\u53EA\u662F\u4E0D\u7ED9\u5206\uFF0C\u4E0D\u5F97\u5199\u6210\u5012\u6263\u6216\u8D1F\u5206\u3002",
      "- \u4FDD\u7559\u9898\u76EE\u4E0E\u7B54\u6848\u4E2D\u7684\u5316\u5B66\u5F0F\u3001\u6570\u5B66\u516C\u5F0F\u3001\u7B26\u53F7\u3001\u4E13\u6709\u540D\u8BCD\u539F\u6837\uFF0C\u4E0D\u8981\u6539\u5199\u6216\u7FFB\u8BD1\u3002",
      `- \u603B\u5B57\u6570\u63A7\u5236\u5728 ${charLimit} \u5B57\u4EE5\u5185\u3002`
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
    // 地理标准答案常含地图/统计图，生成阶段一次性保到 1600px，避免图例、经纬度和小字被缩糊。
    const genImageConfig = subject === "\u5730\u7406"
      ? { ...(imageConfig || {}), maxEdge: Math.max(1600, Number(imageConfig?.maxEdge) || 0), detail: "high" }
      : (imageConfig || {});
    const prepared = [];
    for (const src of rawImages) {
      try {
        const image = await prepareImage(src, genImageConfig);
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
      // 没写 sc 的条目（截断修复可能补全出残缺条目）直接丢弃：当成 0 分会拉低小题合计。
      const rawScore = record.sc ?? record.score;
      if (rawScore === void 0 || rawScore === null || rawScore === "") return [];
      const itemMax = clamp(Number(record.maxScore ?? base?.maxScore ?? 0), maxScore);
      return [{
        label,
        score: clamp(Number(rawScore), itemMax > 0 ? itemMax : maxScore),
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
  // 截断修复：思考 token 挤占输出预算时 JSON 可能只写了一半。
  // 思路：从最后一个「完整元素」处截断、去掉悬挂逗号、按栈补齐括号，从后往前试有限的候选点，
  // 能解析出对象就交给 fromJson 走正常口径（含小题合计校验）；修复不出来返回 null，由上层作废。
  function repairTruncatedJson(raw) {
    const text = String(raw || "");
    const start = text.indexOf("{");
    if (start < 0) return null;
    const body = text.slice(start);
    const stack = [];
    const marks = [];
    let inString = false;
    let escape = false;
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') {
          inString = false;
          marks.push(i);
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{" || ch === "[") {
        stack.push(ch === "{" ? "}" : "]");
        continue;
      }
      if (ch === "}" || ch === "]") {
        stack.pop();
        marks.push(i);
        continue;
      }
      if (ch === ",") {
        marks.push(i);
        continue;
      }
      if (/[0-9]/.test(ch) && !/[0-9]/.test(body[i + 1] || "")) marks.push(i);
    }
    // 只修复"确实没写完"的输入（括号未闭合或字符串未闭合）；
    // 完整但非法的 JSON 交给原有的 fromText 兜底，不在这里硬修。
    if (stack.length === 0 && !inString) return null;
    // 从最近的完成点往前试，最多回退 8 个候选点，避免 O(n²)
    for (let t = marks.length - 1, tried = 0; t >= 0 && tried < 8; t -= 1, tried += 1) {
      const cut = body.slice(0, marks[t] + 1).replace(/,\s*$/, "");
      if (!cut.trim()) continue;
      const candidate = `${cut}${stack.slice().reverse().join("")}`;
      try {
        if (asRecord(JSON.parse(candidate))) return candidate;
      } catch { /* 换上一个候选点继续试 */ }
    }
    return null;
  }
  function fromRepairedJson(raw, maxScore, subQuestions = []) {
    const repaired = repairTruncatedJson(raw);
    if (!repaired) return null;
    return fromJson(repaired, maxScore, subQuestions);
  }
  function parseGrade(raw, maxScore, subQuestions = []) {
    return fromJson(raw, maxScore, subQuestions) ?? fromRepairedJson(raw, maxScore, subQuestions) ?? fromText(raw, maxScore, subQuestions);
  }
  // 文本模型收到 image_url 时常会回「无法查看图片」这类拒答。它不是 0 分，
  // 而是根本没看到作答图；必须作废本次结果，不能写历史，也不能继续连续批阅。
  // 只匹配「能力不足」的措辞，不匹配「字迹模糊/无法辨认」这类正常的不可辨判定。
  function looksLikeVisionFailure(text) {
    const value = String(text || "");
    if (!value) return false;
    return /无法(?:查看|看到|读取|访问|打开)(?:到)?(?:这张|该|提供的)?(?:图片|图像|照片)/i.test(value)
      || /(?:没有|未)(?:收到|提供|附带)(?:任何)?(?:图片|图像|照片)/i.test(value)
      || /不支持(?:图片|图像|视觉|多模态)/i.test(value)
      || /(?:我|本模型|该模型|当前模型).{0,10}(?:是|属于|作为).{0,6}(?:纯文本|文本|语言)模型/i.test(value)
      || /(?:text[- ]only|language)\s+model/i.test(value)
      || /(?:cannot|can't|unable\s+to)\s+(?:see|view|read|access|process)\s+(?:the\s+)?(?:image|picture|photo)/i.test(value)
      || /no\s+(?:image|picture|photo)\s+(?:was\s+)?(?:provided|attached|included)/i.test(value);
  }
  // 文本模型常把「看不到图」包装成一个合法的 legible + 0 分。分数 0、状态却是「可辨认」、
  // 理由又说图片无法辨认时，不能当成学生答错；按能力问题作废，避免整批写下 0 分。
  function isVisionBlockedResult(grade, raw) {
    if (looksLikeVisionFailure(`${grade?.reason || ""}\n${raw || ""}`)) return true;
    const reason = `${grade?.reason || ""}\n${raw || ""}`;
    return Number(grade?.score) === 0
      && grade?.status === "legible"
      && /(?:图片|图像)(?:无法|不能)辨认|无法判断作答内容/.test(reason);
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
  // 输出档位决定基础预算；思考与正文共享输出预算，强制思考的模型按 3 倍放宽。
  // 上限只是天花板：模型不用就不计费，所以放宽本身不产生额外费用。
  const mode = normalizeOutputMode(config.pipeline?.outputMode);
  const thinking = normalizeThinkingMode(service.thinkingMode);
  const baseTokens = OUTPUT_MODES[mode]?.maxTokens || 800;
  const maxTokens = thinking === "off" ? baseTokens : Math.round(baseTokens * 3);
  let usage = null;
  let forcedDetected = false;
  let truncated = false;
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
    },
    // 正文被截断：先尝试按已产出内容捞分，捞不出确定分数才作废。
    onTruncated: () => {
      truncated = true;
    }
  });
  if (!raw.trim()) throw new Error("\u6A21\u578B\u8FD4\u56DE\u4E3A\u7A7A");
  const grade = parseGrade(raw, maxScore, question.subQuestions);
  // 模型拒答「看不到图片」：这是模型能力问题，不是这份卷子的 0 分。
  // 直接抛错让连续批阅停下，并避免把整批卷子写成一串 0 分历史。
  if (isVisionBlockedResult(grade, raw)) {
    throw new Error("\u6A21\u578B\u8868\u793A\u65E0\u6CD5\u8BFB\u53D6\u4F5C\u7B54\u56FE\u7247\uFF0C\u5F53\u524D\u6A21\u578B\u53EF\u80FD\u4E0D\u662F\u591A\u6A21\u6001\u6A21\u578B\u3002\u672C\u6B21\u7ED3\u679C\u5DF2\u4F5C\u5E9F\uFF0C\u8FDE\u7EED\u6279\u9605\u5DF2\u505C\u6B62\uFF1B\u8BF7\u5230\u8BBE\u7F6E \u2192 \u63A5\u53E3\u4E0E\u94FE\u8DEF\u66F4\u6362\u652F\u6301\u56FE\u7247\u8F93\u5165\u7684\u6A21\u578B");
  }
  if (truncated && grade.scoreUncertain) {
    throw new Error("\u6A21\u578B\u8F93\u51FA\u88AB\u957F\u5EA6\u4E0A\u9650\u622A\u65AD\uFF08finish_reason=length\uFF09\uFF0C\u4E14\u6CA1\u80FD\u4ECE\u5DF2\u4EA7\u51FA\u5185\u5BB9\u4E2D\u89E3\u6790\u51FA\u786E\u5B9A\u5206\u6570\uFF0C\u672C\u6B21\u7ED3\u679C\u4F5C\u5E9F\uFF1A\u8BF7\u5173\u95ED\u601D\u8003\u6216\u7F29\u77ED\u8BC4\u5206\u6807\u51C6");
  }
  if (truncated) grade.truncated = true;
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
    throw new Error("\u672A\u83B7\u53D6\u5230\u53EF\u7528\u4F5C\u7B54\u56FE\u7247\uFF1A\u56FE\u7247\u94FE\u63A5\u53EF\u80FD\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u6309\u6D4F\u89C8\u5668 F5 \u5237\u65B0\u5F53\u524D\u9605\u5377\u9875\uFF0C\u6216\u9000\u51FA\u540E\u91CD\u65B0\u8FDB\u5165\u9605\u5377\u4EFB\u52A1\u518D\u8BD5");
  }
  const payloadImages = usable;
  const prompt = buildGradingPrompt(question, config.context, {
    outputMode,
    removedImages: removed.length
  });
  stage("\u6A21\u578B\u8BC4\u5206", gradeService.model);
  const grade = await runGrade(gradeService, question, maxScore, prompt, payloadImages, config, rateLimiter, imageOptions, forcedByModel);
  // 同一道题连续多份都拿不到前缀命中时，在结果里留一个可点击的排查入口。
  // 只读响应里的 usage，不改变请求参数，也不额外发请求。
  const probeUsage = grade.usage;
  if (probeUsage && Number(probeUsage.prompt) > 0) {
    const probe = noteCacheProbe({
      platform: gradeService.platform,
      model: gradeService.model,
      questionKey: question.questionId || question.topicNumStr || "当前题目",
      prefixHash: hashString(prompt),
      cached: probeUsage.cached,
      promptTokens: probeUsage.prompt,
      textTokens: estimateTextTokens(prompt)
    });
    if (probe.streak >= 3) {
      grade.cacheMiss = {
        streak: probe.streak,
        driftCount: probe.driftCount,
        textTokens: probe.textTokens,
        promptTokens: probe.promptTokens,
        imageCount: payloadImages.length,
        platform: gradeService.platform || "custom",
        model: gradeService.model,
        modelEverHit: modelCacheEverHit(gradeService.platform, gradeService.model)
      };
    }
  }
  if (grade.status === "blank" && grade.score > 0) {
    reviewReasons.push("\u8BC6\u522B\u4E3A\u672A\u4F5C\u7B54\u4F46\u7ED9\u51FA\u4E86\u6B63\u5206\uFF0C\u8BF7\u4EBA\u5DE5\u6838\u67E5");
  }
  // 无法辨认却给了分：多半是模型凭印象打分，必须人工确认。
  if (grade.status === "illegible" && grade.score > 0) {
    reviewReasons.push("\u8BC6\u522B\u4E3A\u65E0\u6CD5\u8FA8\u8BA4\u5374\u7ED9\u4E86\u6B63\u5206\uFF0C\u8BF7\u4EBA\u5DE5\u6838\u5B9E");
  }
  if (grade.scoreUncertain) reviewReasons.push("\u672A\u80FD\u4ECE\u6A21\u578B\u8F93\u51FA\u4E2D\u786E\u5B9A\u5206\u6570\uFF0C\u8BF7\u4EBA\u5DE5\u6838\u5B9A");
  // 截断捞回的结果：总分可用但明细/评语可能不全，必须人工复核，不允许直接提交。
  if (grade.truncated) reviewReasons.push("\u6A21\u578B\u8F93\u51FA\u88AB\u622A\u65AD\uFF0C\u5DF2\u6309\u5DF2\u4EA7\u51FA\u5185\u5BB9\u89E3\u6790\uFF0C\u8BF7\u4EBA\u5DE5\u590D\u6838");
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
  // 全部样式都活在 shadow root 里：页面原有样式进不来，这里的类名也不会污染页面。
  var STYLES = `
:host {
  --z-accent: #0071e3;
  --z-accent-soft: rgba(0, 113, 227, .10);
  --z-ring: rgba(0, 113, 227, .30);
  --z-green: #34c759;
  --z-green-ink: #1c7c3c;
  --z-green-soft: rgba(52, 199, 89, .14);
  --z-orange: #ff9500;
  --z-orange-ink: #a25800;
  --z-orange-soft: rgba(255, 149, 0, .16);
  --z-red: #ff3b30;
  --z-red-ink: #c0362c;
  --z-red-soft: rgba(255, 59, 48, .12);
  --z-ink: #1d1d1f;
  --z-ink2: #6e6e73;
  --z-ink3: #8e8e93;
  --z-hairline: rgba(60, 60, 67, .10);
  --z-fill: rgba(120, 120, 128, .10);
  --z-fill-2: rgba(120, 120, 128, .18);
  --z-panel: rgba(250, 250, 252, .84);
  --z-bg-solid: #f5f5f7;
  --z-card: #ffffff;
  --z-card-t: rgba(255, 255, 255, .72);
  --z-foot: rgba(255, 255, 255, .34);
  --z-shadow-lg: 0 24px 64px -18px rgba(15, 23, 42, .32), 0 2px 10px rgba(15, 23, 42, .06);
  --z-shadow-sm: 0 1px 2px rgba(0, 0, 0, .10);
  --z-ease: cubic-bezier(.32, .72, 0, 1);
  color-scheme: light;
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483647;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  color: var(--z-ink);
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
}
@media (prefers-color-scheme: dark) {
  :host {
    --z-accent: #0a84ff;
    --z-accent-soft: rgba(10, 132, 255, .20);
    --z-ring: rgba(10, 132, 255, .38);
    --z-green: #30d158;
    --z-green-ink: #5ee07a;
    --z-green-soft: rgba(48, 209, 88, .18);
    --z-orange: #ff9f0a;
    --z-orange-ink: #ffb84d;
    --z-orange-soft: rgba(255, 159, 10, .18);
    --z-red: #ff453a;
    --z-red-ink: #ff7b72;
    --z-red-soft: rgba(255, 69, 58, .18);
    --z-ink: #f5f5f7;
    --z-ink2: #a1a1a6;
    --z-ink3: #8e8e93;
    --z-hairline: rgba(255, 255, 255, .10);
    --z-fill: rgba(120, 120, 128, .24);
    --z-fill-2: rgba(120, 120, 128, .36);
    --z-panel: rgba(28, 28, 30, .84);
    --z-bg-solid: #1c1c1e;
    --z-card: #2c2c2e;
    --z-card-t: rgba(44, 44, 46, .68);
    --z-foot: rgba(255, 255, 255, .03);
    --z-shadow-lg: 0 30px 80px -20px rgba(0, 0, 0, .75), 0 2px 12px rgba(0, 0, 0, .35);
    --z-shadow-sm: 0 1px 2px rgba(0, 0, 0, .4);
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button, input, select, textarea { font: inherit; color: inherit; }
button { background: none; border: 0; padding: 0; cursor: pointer; appearance: none; -webkit-appearance: none; }
button:disabled { cursor: not-allowed; }
button:focus-visible { outline: 2px solid var(--z-accent); outline-offset: 2px; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: var(--z-fill-2); border: 2px solid transparent; border-radius: 8px; background-clip: padding-box; }
::-webkit-scrollbar-track { background: transparent; }

/* ---------- 主面板 ---------- */
.zp-panel {
  position: fixed; right: 20px; bottom: 20px; width: 388px; max-height: calc(100vh - 40px);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--z-panel); border: 1px solid var(--z-hairline); border-radius: 20px;
  box-shadow: var(--z-shadow-lg);
  -webkit-backdrop-filter: blur(32px) saturate(180%); backdrop-filter: blur(32px) saturate(180%);
  animation: zp-in .38s var(--z-ease);
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .zp-panel { background: var(--z-card); }
}
@keyframes zp-in { from { opacity: 0; transform: translateY(14px) scale(.985); } to { opacity: 1; transform: none; } }

.zp-head { display: flex; align-items: center; gap: 10px; padding: 12px 10px 10px 14px; }
.zp-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.zp-logo {
  width: 30px; height: 30px; flex: none; display: grid; place-items: center;
  border-radius: 9px; color: #fff; font-size: 14px; font-weight: 700;
  background: linear-gradient(160deg, #3d9bff, #0067d6);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .35), 0 2px 6px rgba(0, 113, 227, .22);
}
.zp-titles { min-width: 0; }
.zp-titleline { display: flex; align-items: center; gap: 6px; }
.zp-titleline strong { font-size: 13.5px; font-weight: 600; letter-spacing: .1px; }
.zp-ver { padding: 1px 6px; border-radius: 999px; background: var(--z-fill); color: var(--z-ink3); font-size: 9.5px; font-weight: 500; }
.zp-sub { display: block; max-width: 236px; margin-top: 1px; font-size: 11px; color: var(--z-ink2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.zp-header-actions { display: flex; flex: none; gap: 2px; margin-left: auto; }
.zp-iconbtn { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; color: var(--z-ink2); transition: background .18s, color .18s; }
.zp-iconbtn:hover { background: var(--z-fill); color: var(--z-ink); }
.zp-iconbtn svg { width: 15px; height: 15px; }
.zp-chev { transition: transform .28s var(--z-ease); }
.zp-panel.is-collapsed .zp-body,
.zp-panel.is-collapsed .zp-foot { display: none; }
.zp-panel.is-collapsed .zp-chev { transform: rotate(180deg); }

.zp-body { flex: 1; min-height: 0; display: grid; align-content: start; gap: 10px; padding: 0 14px 12px; overflow: auto; overscroll-behavior: contain; }
.zp-status { display: flex; align-items: center; gap: 8px; padding: 0 2px; font-size: 11px; }
.zp-stage { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font-weight: 500; color: var(--z-ink); }
.zp-stage > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.zp-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--z-accent); box-shadow: 0 0 0 3px var(--z-accent-soft); }
.zp-dot.ok { background: var(--z-green); box-shadow: 0 0 0 3px var(--z-green-soft); }
.zp-dot.warn { background: var(--z-orange); box-shadow: 0 0 0 3px var(--z-orange-soft); }
.zp-count { margin-left: auto; color: var(--z-ink3); font-size: 10.5px; white-space: nowrap; }
.zp-chip { padding: 4px 7px; border-radius: 999px; background: var(--z-fill); color: var(--z-ink2); font-size: 10px; line-height: 1; white-space: nowrap; }
.zp-chip.ok { background: var(--z-green-soft); color: var(--z-green-ink); }
.zp-chip.warn { background: var(--z-orange-soft); color: var(--z-orange-ink); }
.zp-chip.new { background: var(--z-accent-soft); color: var(--z-accent); font-weight: 600; }
.zp-track { height: 3px; border-radius: 999px; background: var(--z-fill); overflow: hidden; }
.zp-track i { display: block; width: 0; height: 100%; border-radius: inherit; background: var(--z-accent); transition: width .45s var(--z-ease); }

.zp-card { padding: 12px; border: 1px solid var(--z-hairline); border-radius: 14px; background: var(--z-card-t); }
.zp-result:empty { display: none; }
.zp-kicker { display: block; margin-bottom: 2px; font-size: 9.5px; font-weight: 600; letter-spacing: .3px; color: var(--z-ink3); }
.zp-qhead { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.zp-qmain { min-width: 0; }
.zp-qtitle { font-size: 15px; font-weight: 600; letter-spacing: -.2px; }
.zp-qmeta { margin-top: 2px; font-size: 10.5px; line-height: 1.55; color: var(--z-ink3); }
.zp-thumbs { display: flex; gap: 6px; margin-top: 9px; overflow-x: auto; padding-bottom: 1px; }
.zp-thumbs:empty { display: none; }
.zp-thumbs img {
  width: 52px; height: 52px; flex: none; object-fit: cover; border-radius: 9px;
  border: 1px solid var(--z-hairline); background: var(--z-card); cursor: zoom-in;
  transition: transform .2s var(--z-ease), box-shadow .2s;
}
.zp-thumbs img:hover { transform: translateY(-2px); box-shadow: 0 6px 14px rgba(15, 23, 42, .16); }

.zp-scorehead { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.zp-score { display: flex; align-items: baseline; gap: 4px; margin-top: 1px; }
.zp-score input {
  width: 108px; height: 46px; padding: 0 2px; border: 0; border-radius: 8px; background: transparent;
  color: var(--z-ink); font-size: 38px; font-weight: 600; letter-spacing: -1.6px; text-align: left;
  -moz-appearance: textfield; transition: background .18s, box-shadow .18s;
}
.zp-score input::-webkit-outer-spin-button,
.zp-score input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.zp-score input:hover { background: var(--z-fill); }
.zp-score input:focus { outline: none; background: var(--z-card); box-shadow: 0 0 0 3px var(--z-ring); }
.zp-score > span { font-size: 12px; color: var(--z-ink3); white-space: nowrap; }
.zp-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; padding-top: 16px; }
.zp-pill { padding: 3px 8px; border-radius: 999px; background: var(--z-fill); color: var(--z-ink2); font-size: 10.5px; font-weight: 500; white-space: nowrap; }
.zp-pill.ok { background: var(--z-green-soft); color: var(--z-green-ink); }
.zp-pill.warn { background: var(--z-orange-soft); color: var(--z-orange-ink); }
.zp-pill.bad { background: var(--z-red-soft); color: var(--z-red-ink); }
.zp-reason { margin: 9px 0 0; font-size: 12px; line-height: 1.68; color: var(--z-ink2); text-wrap: pretty; }
.zp-sublist { margin-top: 10px; border-top: 1px solid var(--z-hairline); }
.zp-subrow { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--z-hairline); }
.zp-subrow:last-child { border-bottom: 0; padding-bottom: 2px; }
.zp-submain { flex: 1; min-width: 0; }
.zp-sublabel { display: block; font-size: 11.5px; font-weight: 600; }
.zp-subreason { display: block; margin-top: 1px; font-size: 10.5px; line-height: 1.5; color: var(--z-ink3); text-wrap: pretty; }
.zp-subscore { display: flex; align-items: baseline; gap: 2px; flex: none; }
.zp-subscore input {
  width: 44px; height: 25px; padding: 0; border: 0; border-radius: 7px; background: var(--z-fill);
  color: var(--z-ink); font-size: 11.5px; font-weight: 600; text-align: center;
  -moz-appearance: textfield; transition: background .18s, box-shadow .18s;
}
.zp-subscore input::-webkit-outer-spin-button,
.zp-subscore input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.zp-subscore input:focus { outline: none; background: var(--z-card); box-shadow: 0 0 0 3px var(--z-ring); }
.zp-subscore em { font-style: normal; font-size: 9.5px; color: var(--z-ink3); }
.zp-meta { margin-top: 8px; font-size: 11.5px; line-height: 1.6; color: var(--z-ink2); }
.zp-metaline + .zp-metaline { margin-top: 1px; }
.zp-reviews { margin-top: 8px; font-size: 10.5px; line-height: 1.6; color: var(--z-orange-ink); }
.zp-notice {
  display: flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%;
  margin-top: 8px; padding: 7px 9px; border: 1px solid rgba(255, 149, 0, .28); border-radius: 9px;
  background: var(--z-orange-soft); color: var(--z-orange-ink); font-size: 10.5px; line-height: 1.5; text-align: left;
}
.zp-notice:hover { filter: brightness(1.03); }
.zp-notice svg { width: 12px; height: 12px; flex: none; }
.zp-empty { padding: 22px 12px; text-align: center; }
.zp-empty-icon { width: 36px; height: 36px; margin: 0 auto; display: grid; place-items: center; border-radius: 11px; background: var(--z-accent-soft); color: var(--z-accent); }
.zp-empty-icon svg { width: 18px; height: 18px; }
.zp-empty strong { display: block; margin-top: 10px; font-size: 12.5px; font-weight: 600; }
.zp-empty p { margin: 4px 0 0; font-size: 11px; line-height: 1.6; color: var(--z-ink3); }
.zp-error { padding: 9px 11px; border-radius: 10px; background: var(--z-red-soft); color: var(--z-red-ink); font-size: 11px; line-height: 1.6; }

.zp-foot { flex: none; padding: 10px 12px 12px; border-top: 1px solid var(--z-hairline); background: var(--z-foot); }
.zp-actions { display: flex; gap: 8px; }
.zp-btn {
  height: 34px; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 0 14px; border-radius: 10px; background: var(--z-fill); color: var(--z-ink);
  font-size: 12.5px; font-weight: 500; transition: background .18s, filter .18s, transform .12s;
}
.zp-btn:hover { background: var(--z-fill-2); }
.zp-btn:active { transform: scale(.985); }
.zp-btn.primary { flex: 1; background: var(--z-accent); color: #fff; font-weight: 600; box-shadow: 0 4px 12px -4px rgba(0, 113, 227, .5); }
.zp-btn.primary:hover { filter: brightness(1.06); }
.zp-btn.running { background: var(--z-red); color: #fff; font-weight: 600; }
.zp-btn:disabled { opacity: .45; cursor: not-allowed; transform: none; }
.zp-submit { width: 96px; flex: none; }
.zp-options { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.zp-mini {
  height: 26px; display: inline-flex; align-items: center; gap: 4px; padding: 0 9px;
  border-radius: 8px; background: var(--z-fill); font-size: 11px; color: var(--z-ink); white-space: nowrap;
  transition: background .18s, color .18s;
}
.zp-mini:hover { background: var(--z-fill-2); }
.zp-mini svg { width: 11px; height: 11px; }
.zp-mini.running { background: var(--z-red-soft); color: var(--z-red-ink); }
.zp-optlabel { font-size: 10px; color: var(--z-ink3); white-space: nowrap; }
.zp-stepper { display: inline-flex; align-items: center; height: 26px; padding: 0 2px; border-radius: 8px; background: var(--z-fill); gap: 1px; }
.zp-stepper button { width: 19px; height: 22px; display: grid; place-items: center; border-radius: 6px; color: var(--z-ink2); font-size: 13px; line-height: 1; }
.zp-stepper button:hover { background: var(--z-fill-2); }
.zp-stepper button:disabled { opacity: .4; }
.zp-stepper input {
  width: 30px; height: 22px; padding: 0; border: 0; background: transparent; text-align: center;
  font-size: 11px; font-weight: 600; -moz-appearance: textfield;
}
.zp-stepper input::-webkit-outer-spin-button,
.zp-stepper input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.zp-stepper input:focus { outline: none; }
.zp-stepper input:disabled { opacity: .5; }
.zp-seg { display: inline-flex; gap: 1px; margin-left: auto; padding: 2px; border-radius: 8px; background: var(--z-fill); }
.zp-seg button { height: 22px; padding: 0 7px; border-radius: 6px; font-size: 10.5px; color: var(--z-ink2); white-space: nowrap; }
.zp-seg button[aria-pressed="true"] { background: var(--z-card); color: var(--z-ink); font-weight: 600; box-shadow: var(--z-shadow-sm); }
.zp-seg button:disabled { opacity: .5; }
.zp-footbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--z-hairline); }
.zp-skip { position: relative; display: inline-flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--z-ink2); cursor: pointer; user-select: none; }
.zp-skip input { position: absolute; width: 1px; height: 1px; margin: 0; opacity: 0; pointer-events: none; }
.zp-switch { position: relative; width: 32px; height: 19px; flex: none; border-radius: 999px; background: var(--z-fill-2); transition: background .22s var(--z-ease); }
.zp-switch::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .28); transition: transform .22s var(--z-ease);
}
.zp-skip input:checked + .zp-switch { background: var(--z-green); }
.zp-skip input:checked + .zp-switch::after { transform: translateX(13px); }
.zp-skip input:focus-visible + .zp-switch { outline: 2px solid var(--z-accent); outline-offset: 2px; }
.zp-tools { display: flex; align-items: center; gap: 2px; }
.zp-quiet { display: inline-flex; align-items: center; gap: 4px; padding: 4px 7px; border-radius: 7px; font-size: 11px; color: var(--z-ink2); }
.zp-quiet:hover { background: var(--z-fill); color: var(--z-ink); }
.zp-quiet svg { width: 12px; height: 12px; }

/* ---------- 弹层骨架 ---------- */
.zygr-overlay {
  position: fixed; inset: 0; z-index: 2147483646; display: grid; place-items: center; padding: 24px;
  background: rgba(0, 0, 0, .24);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  animation: zo-in .24s ease;
}
@keyframes zo-in { from { opacity: 0; } to { opacity: 1; } }
.zygr-dialog {
  position: relative; width: min(880px, 100%); height: min(760px, calc(100vh - 48px));
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--z-bg-solid); border: 1px solid var(--z-hairline); border-radius: 22px;
  box-shadow: var(--z-shadow-lg); animation: zd-in .32s var(--z-ease);
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .zygr-overlay { background: rgba(0, 0, 0, .38); }
}
@keyframes zd-in { from { opacity: 0; transform: translateY(12px) scale(.985); } to { opacity: 1; transform: none; } }
.zygr-dialog.zygr-help { width: min(560px, 100%); height: auto; max-height: min(82vh, 700px); }
.zg-head { flex: none; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 18px 20px 14px 22px; }
.zg-head h2 { margin: 0; font-size: 19px; font-weight: 600; letter-spacing: -.3px; }
.zg-head p { margin: 3px 0 0; font-size: 11.5px; color: var(--z-ink3); }
.zg-head .zp-iconbtn { margin-top: 2px; }

/* ---------- 设置 ---------- */
.zg-shell { flex: 1; min-height: 0; display: grid; grid-template-columns: 192px minmax(0, 1fr); }
.zg-nav { display: flex; flex-direction: column; gap: 2px; padding: 4px 10px 12px; border-right: 1px solid var(--z-hairline); background: rgba(120, 120, 128, .045); overflow: auto; }
.zg-navitem { display: flex; align-items: center; gap: 9px; height: 34px; padding: 0 9px; border-radius: 9px; font-size: 12.5px; color: var(--z-ink2); text-align: left; transition: background .18s, color .18s; }
.zg-navitem:hover { background: var(--z-fill); }
.zg-navitem.is-active { background: var(--z-card); color: var(--z-ink); font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, .07); }
.zg-tile { width: 22px; height: 22px; flex: none; display: grid; place-items: center; border-radius: 6px; color: #fff; box-shadow: inset 0 1px 0 rgba(255, 255, 255, .25); }
.zg-tile svg { width: 13px; height: 13px; }
.zg-tile.blue { background: #0a84ff; }
.zg-tile.purple { background: #5e5ce6; }
.zg-tile.pink { background: #ff375f; }
.zg-tile.gray { background: #8e8e93; }
.zg-navfoot { margin-top: auto; padding: 14px 9px 0; font-size: 10px; line-height: 1.6; color: var(--z-ink3); }
.zg-pane { overflow: auto; padding: 8px 22px 28px; }

.zg-page { display: none; align-content: start; gap: 18px; }
.zg-page.is-active { display: grid; }
.zg-pagehead h2 { margin: 6px 0 0; font-size: 17px; font-weight: 600; letter-spacing: -.2px; }
.zg-pagehead p { margin: 4px 0 0; font-size: 11.5px; line-height: 1.6; color: var(--z-ink3); }
.zg-section { display: grid; gap: 0; }
.zg-grouptitle { margin: 0 0 7px 2px; font-size: 11.5px; font-weight: 600; color: var(--z-ink2); }
.zg-note { margin: 7px 2px 0; font-size: 10.5px; line-height: 1.6; color: var(--z-ink3); text-wrap: pretty; }
.zg-group { overflow: hidden; background: var(--z-card); border-radius: 12px; box-shadow: 0 0 0 1px var(--z-hairline); }
.zg-row { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 9px 14px; }
.zg-row + .zg-row { border-top: 1px solid var(--z-hairline); }
.zg-rowmain { flex: 1; min-width: 0; }
.zg-rowlabel { display: block; font-size: 12.5px; }
.zg-rowdesc { display: block; margin-top: 1px; font-size: 10.5px; line-height: 1.5; color: var(--z-ink3); text-wrap: pretty; }
.zg-rowactions { display: flex; flex: none; gap: 6px; }
.zg-rowvalue { flex: none; font-size: 12px; color: var(--z-ink2); }
.zg-statsline { margin: 0; padding: 10px 14px; font-size: 11px; line-height: 1.65; color: var(--z-ink2); }

.zg-field { display: block; padding: 12px 14px; }
.zg-field + .zg-field { border-top: 1px solid var(--z-hairline); }
.zg-field > label:not(.zg-drop) { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; font-size: 12px; font-weight: 600; }
.zg-opt, .zg-req { padding: 1px 6px; border-radius: 999px; font-size: 9.5px; font-weight: 400; }
.zg-opt { background: var(--z-fill); color: var(--z-ink3); }
.zg-req { background: var(--z-orange-soft); color: var(--z-orange-ink); }

.zg-input, .zg-field textarea, .zg-select select {
  width: 100%; border: 1px solid transparent; border-radius: 9px; background: var(--z-fill);
  font-size: 12.5px; transition: background .18s, box-shadow .18s, border-color .18s;
}
.zg-input { height: 30px; padding: 0 10px; }
.zg-field textarea { display: block; min-height: 62px; padding: 9px 11px; line-height: 1.65; resize: vertical; }
.zg-input:hover, .zg-field textarea:hover, .zg-select select:hover { background: var(--z-fill-2); }
.zg-input:focus, .zg-field textarea:focus, .zg-select select:focus {
  outline: none; background: var(--z-card); border-color: var(--z-accent); box-shadow: 0 0 0 3px var(--z-ring);
}
.zg-input::placeholder, .zg-field textarea::placeholder { color: var(--z-ink3); }
.zg-num { width: 88px; flex: none; text-align: right; }
.zg-inputwrap { position: relative; flex: 1; min-width: 0; max-width: 340px; }
.zg-inputwrap .zg-input { padding-right: 50px; }
.zg-inputwrap button { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); height: 24px; padding: 0 8px; border-radius: 6px; font-size: 10.5px; color: var(--z-ink2); }
.zg-inputwrap button:hover { background: var(--z-fill); }
.zg-select { position: relative; flex: none; width: 168px; }
.zg-select::after {
  content: ""; position: absolute; right: 11px; top: 50%; width: 6px; height: 6px; pointer-events: none;
  border-right: 1.5px solid var(--z-ink3); border-bottom: 1.5px solid var(--z-ink3);
  transform: translateY(-70%) rotate(45deg);
}
.zg-select select { height: 30px; padding: 0 26px 0 10px; appearance: none; -webkit-appearance: none; }
.zg-select.wide { width: 210px; }

.zg-switch { position: relative; display: inline-flex; flex: none; cursor: pointer; }
.zg-switch input { position: absolute; width: 1px; height: 1px; margin: 0; opacity: 0; pointer-events: none; }
.zg-switch-track { position: relative; width: 42px; height: 25px; border-radius: 999px; background: var(--z-fill-2); transition: background .22s var(--z-ease); }
.zg-switch-track::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 21px; height: 21px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .28); transition: transform .22s var(--z-ease);
}
.zg-switch input:checked + .zg-switch-track { background: var(--z-green); }
.zg-switch input:checked + .zg-switch-track::after { transform: translateX(17px); }
.zg-switch input:focus-visible + .zg-switch-track { outline: 2px solid var(--z-accent); outline-offset: 2px; }

.zg-seg { display: inline-flex; gap: 1px; padding: 2px; border-radius: 8px; background: var(--z-fill); }
.zg-seg button { height: 26px; padding: 0 11px; border-radius: 6px; font-size: 11.5px; color: var(--z-ink2); white-space: nowrap; }
.zg-seg button[aria-pressed="true"] { background: var(--z-card); color: var(--z-ink); font-weight: 600; box-shadow: var(--z-shadow-sm); }

.zg-btn {
  height: 32px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 14px;
  border-radius: 9px; background: var(--z-fill); color: var(--z-ink); font-size: 12.5px; font-weight: 500;
  transition: background .18s, filter .18s, transform .12s;
}
.zg-btn:hover { background: var(--z-fill-2); }
.zg-btn:active { transform: scale(.985); }
.zg-btn.primary { background: var(--z-accent); color: #fff; font-weight: 600; }
.zg-btn.primary:hover { filter: brightness(1.06); }
.zg-btn.ghost { background: transparent; color: var(--z-ink2); }
.zg-btn.ghost:hover { background: var(--z-fill); color: var(--z-ink); }
.zg-btn.danger { background: transparent; color: var(--z-red-ink); }
.zg-btn.danger:hover { background: var(--z-red-soft); }
.zg-btn.small { height: 28px; padding: 0 10px; font-size: 11.5px; }
.zg-btn:disabled { opacity: .45; cursor: not-allowed; transform: none; }

.zg-status { font-size: 11px; line-height: 1.5; color: var(--z-ink3); }
.zg-status.ok { color: var(--z-green-ink); }
.zg-status.bad { color: var(--z-red-ink); }
.zg-inline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.zg-inline .zg-status { margin-left: 2px; }

.zg-drop {
  position: relative;
  display: grid; place-items: center; gap: 5px; padding: 16px; text-align: center;
  border: 1px dashed var(--z-hairline); border-radius: 10px; background: var(--z-fill);
  font-size: 11.5px; color: var(--z-ink2); cursor: pointer; transition: background .18s, border-color .18s;
}
.zg-drop:hover { background: var(--z-fill-2); border-color: var(--z-ink3); }
.zg-drop:focus-within { outline: 2px solid var(--z-accent); outline-offset: 2px; }
.zg-drop svg { width: 18px; height: 18px; color: var(--z-ink3); }
.zg-drop small { font-size: 10px; color: var(--z-ink3); }
.zg-drop input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }

.zg-lead { margin: 0; font-size: 12px; line-height: 1.7; color: var(--z-ink2); }
.zg-bullets { padding: 4px 14px; }
.zg-bullets ul { margin: 7px 0 8px; padding-left: 17px; display: grid; gap: 5px; }
.zg-bullets li { font-size: 11.5px; line-height: 1.65; color: var(--z-ink2); }
.zg-stats { display: grid; grid-template-columns: 1fr 1fr; }
.zg-stat { padding: 11px 14px; }
.zg-stat:nth-child(odd) { border-right: 1px solid var(--z-hairline); }
.zg-stat:nth-child(n+3) { border-top: 1px solid var(--z-hairline); }
.zg-stat b { display: block; font-size: 17px; font-weight: 600; letter-spacing: -.3px; }
.zg-stat span { display: block; margin-top: 2px; font-size: 10.5px; color: var(--z-ink3); }

.zg-foot { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--z-hairline); background: var(--z-card-t); }
.zg-foot-left, .zg-foot-right { display: flex; align-items: center; gap: 6px; }
.zg-foot-left { flex: 1; }

/* ---------- 历史 ---------- */
.zh-toolbar { flex: none; display: flex; align-items: center; gap: 10px; padding: 0 20px 10px; }
.zh-search { position: relative; width: 236px; margin-left: auto; }
.zh-search input {
  width: 100%; height: 30px; padding: 0 10px 0 28px; border: 1px solid transparent; border-radius: 8px;
  background: var(--z-fill); font-size: 12px; transition: background .18s, box-shadow .18s, border-color .18s;
}
.zh-search input:focus { outline: none; background: var(--z-card); border-color: var(--z-accent); box-shadow: 0 0 0 3px var(--z-ring); }
.zh-search svg { position: absolute; left: 9px; top: 50%; width: 13px; height: 13px; color: var(--z-ink3); transform: translateY(-50%); pointer-events: none; }
.zh-summary { flex: none; padding: 0 22px 9px; font-size: 10.5px; color: var(--z-ink3); }
.zh-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 318px minmax(0, 1fr); gap: 14px; padding: 0 20px 16px; }
.zh-list { display: grid; align-content: start; gap: 6px; overflow-y: auto; overflow-x: hidden; padding-right: 2px; }
.zh-row {
  display: flex; align-items: center; min-width: 0; padding: 0; border-radius: 11px;
  background: var(--z-card); box-shadow: 0 0 0 1px var(--z-hairline);
  transition: box-shadow .18s, transform .18s;
}
.zh-row:hover { transform: translateY(-1px); box-shadow: 0 0 0 1px var(--z-hairline), 0 6px 16px -8px rgba(15, 23, 42, .35); }
.zh-row.is-selected { box-shadow: 0 0 0 1.5px var(--z-accent); }
.zh-row:focus-within { outline: 2px solid var(--z-accent); outline-offset: 2px; }
.zh-select { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 9px 4px 9px 11px; border-radius: 11px 0 0 11px; text-align: left; }
.zh-score { width: 38px; height: 38px; flex: none; display: grid; place-items: center; border-radius: 10px; background: var(--z-fill); font-size: 13px; font-weight: 600; }
.zh-row.needs .zh-score { background: var(--z-orange-soft); color: var(--z-orange-ink); }
.zh-main { flex: 1; min-width: 0; }
.zh-l1 { display: block; font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.zh-l2 { display: block; margin-top: 2px; font-size: 10.5px; color: var(--z-ink3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.zh-arrow { width: 13px; height: 13px; flex: none; color: var(--z-ink3); }
.zh-jump { flex: none; margin-right: 9px; padding: 3px 7px; border-radius: 6px; background: var(--z-accent-soft); color: var(--z-accent); font-size: 10px; }
.zh-jump:hover { filter: brightness(.97); }
.zh-detail { overflow: auto; padding: 16px; background: var(--z-card); border-radius: 14px; box-shadow: 0 0 0 1px var(--z-hairline); }
.zh-detailhead { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.zh-bigscore { margin-top: 1px; font-size: 32px; font-weight: 600; letter-spacing: -1.2px; line-height: 1.1; }
.zh-bigscore span { margin-left: 3px; font-size: 12px; font-weight: 400; letter-spacing: 0; color: var(--z-ink3); }
.zh-stats { margin: 12px 0 0; border-top: 1px solid var(--z-hairline); }
.zh-statrow { display: flex; align-items: baseline; gap: 10px; padding: 6px 0; font-size: 11.5px; }
.zh-statrow + .zh-statrow { border-top: 1px solid var(--z-hairline); }
.zh-statrow dt { flex: none; width: 74px; color: var(--z-ink3); font-size: 10.5px; }
.zh-statrow dd { margin: 0; flex: 1; min-width: 0; color: var(--z-ink2); line-height: 1.6; text-wrap: pretty; }
.zh-h4 { margin: 14px 0 2px; font-size: 11px; font-weight: 600; color: var(--z-ink3); }
.zh-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
.zh-empty { padding: 40px 12px; text-align: center; font-size: 11.5px; color: var(--z-ink3); }

/* ---------- 提示条 ---------- */
.zygr-toast {
  position: absolute; left: 50%; bottom: 86px; z-index: 6; transform: translateX(-50%);
  max-width: calc(100% - 28px); padding: 8px 14px; border-radius: 999px;
  background: rgba(29, 29, 31, .9); color: #fff; font-size: 11.5px; line-height: 1.4;
  text-align: center; pointer-events: none; box-shadow: 0 10px 28px rgba(0, 0, 0, .22);
  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
  animation: zt-in .22s var(--z-ease);
}
.zp-panel > .zygr-toast { bottom: 122px; }
.zygr-dialog > .zygr-toast { bottom: 70px; }
@keyframes zt-in { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translate(-50%, 0); } }

/* ---------- 缓存说明（showCacheHelp 生成的内容） ---------- */
.zygr-cache-help-body { display: grid; gap: 12px; overflow: auto; padding: 4px 20px 20px; }
.zygr-cache-help-summary { margin: 0; font-size: 12px; line-height: 1.7; color: var(--z-ink); }
.zygr-cache-help-impact {
  margin: 0; padding: 9px 11px; border-radius: 9px; font-size: 11.5px; line-height: 1.6;
  background: var(--z-green-soft); color: var(--z-green-ink);
}
.zygr-cache-help-section { display: grid; gap: 5px; }
.zygr-cache-help-section h3 { margin: 0; font-size: 12px; font-weight: 600; color: var(--z-ink2); }
.zygr-cache-help-section ul { margin: 0; padding-left: 17px; display: grid; gap: 4px; }
.zygr-cache-help-section li { font-size: 11.5px; line-height: 1.65; color: var(--z-ink2); }
.zygr-hint { margin: 0; font-size: 10.5px; line-height: 1.6; color: var(--z-ink3); }

@media (max-width: 860px) {
  .zygr-dialog { height: min(820px, calc(100vh - 32px)); }
  .zg-shell { grid-template-columns: 1fr; }
  .zg-nav { flex-direction: row; overflow-x: auto; padding: 0 12px 8px; border-right: 0; border-bottom: 1px solid var(--z-hairline); }
  .zg-navitem { height: 32px; white-space: nowrap; }
  .zg-navfoot { display: none; }
  .zg-pane { padding: 14px 16px 22px; }
  .zh-body { grid-template-columns: 1fr; }
  .zh-list { max-height: 34vh; }
  .zh-detail { min-height: 240px; }
}
@media (max-width: 640px) {
  .zygr-overlay { padding: 0; place-items: end center; }
  .zygr-dialog { width: 100%; height: calc(100vh - 24px); border-radius: 20px 20px 0 0; }
  .zh-toolbar { flex-wrap: wrap; }
  .zh-search { width: 100%; margin-left: 0; }
  .zg-row { flex-wrap: wrap; }
  .zg-select, .zg-select.wide { width: 100%; }
  .zg-inputwrap { max-width: none; }
  .zg-foot { flex-wrap: wrap; }
  .zg-seg { flex-wrap: wrap; }
}
@media (max-width: 520px) {
  .zp-panel { left: 10px; right: 10px; bottom: 10px; width: auto; max-height: 78vh; border-radius: 18px; }
  .zp-options { flex-wrap: wrap; }
  .zp-seg { margin-left: 0; }
}
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
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
  var CONTINUOUS_LIMIT_MAX = 5000;
  var CONTINUOUS_LIMIT_HINT = `\u8FDE\u7EED\u6279\u9605\u6700\u591A\u81EA\u52A8\u6279\u6539\u5E76\u63D0\u4EA4\u7684\u4EFD\u6570\uFF0C\u8FBE\u5230\u540E\u4F1A\u81EA\u52A8\u505C\u6B62\uFF1B\u4E0D\u662F\u5FC5\u987B\u6279\u6EE1\u7684\u4EFD\u6570\u30021\uFF5E${CONTINUOUS_LIMIT_MAX} \u4EFD\uFF0C\u9ED8\u8BA4 20 \u4EFD`;
  var OUTPUT_MODE_HINT = "\u8F93\u51FA\u6863\u4F4D\u51B3\u5B9A\u6A21\u578B\u5199\u591A\u5C11\u5B57\uFF1A\u7B80\u7565\u6700\u7701 token\uFF0C\u6807\u51C6\u9002\u4E2D\uFF0C\u8BE6\u7EC6\u6700\u8D39\u3002\u6539\u52A8\u540E\u7ACB\u5373\u4FDD\u5B58\uFF0C\u4ECE\u4E0B\u4E00\u4EFD\u5F00\u59CB\u751F\u6548\u3002";
  var OUTPUT_MODE_SHORT = { brief: "\u7B80\u7565", standard: "\u6807\u51C6", detailed: "\u8BE6\u7EC6" };
  function normalizeContinuousLimit(value) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) return 20;
    return Math.max(1, Math.min(CONTINUOUS_LIMIT_MAX, number));
  }
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
      this.cacheMiss = null;
      this.host = document.createElement("div");
      this.host.className = "zygr-host";
      this.shadow = this.host.attachShadow({ mode: "open" });
      this.shadow.innerHTML = `<style>${STYLES}</style>${this.markup()}`;
      guardEnter(this.shadow);
      this.panel = this.q(".zp-panel");
      const version = this.shadow.querySelector("#zygr-version");
      if (version) version.textContent = `v${typeof ZYGR_VERSION === "string" ? ZYGR_VERSION : "dev"}`;
      const skipConfirm = this.shadow.querySelector("[data-opt='skip-submit-confirm']");
      if (skipConfirm) skipConfirm.checked = readJson(SKIP_CONFIRM_KEY, false) === true;
      this.setContinuousLimit(20);
      this.setOutputMode("standard");
      this.bind();
    }
    markup() {
      const outputButtons = Object.keys(OUTPUT_MODES).map((key) => `
          <button data-output-mode="${key}" aria-pressed="${key === "standard" ? "true" : "false"}" title="${OUTPUT_MODES[key].label}">${OUTPUT_MODE_SHORT[key] || key}</button>`).join("");
      return `<div class="zp-panel">
      <header class="zp-head">
        <div class="zp-brand">
          <span class="zp-logo" aria-hidden="true">\u667A</span>
          <div class="zp-titles">
            <div class="zp-titleline">
              <strong>\u667A\u9605\u6279\u6539\u52A9\u624B</strong>
              <span class="zp-ver" id="zygr-version" title="\u5F53\u524D\u811A\u672C\u7248\u672C">v--</span>
            </div>
            <span class="zp-sub" id="zygr-subtitle">\u7B49\u5F85\u8BFB\u53D6\u9898\u76EE</span>
          </div>
        </div>
        <div class="zp-header-actions">
          <button class="zp-iconbtn" data-act="collapse" title="\u6298\u53E0" aria-label="\u6298\u53E0">
            <svg class="zp-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <button class="zp-iconbtn" data-act="close" title="\u5173\u95ED" aria-label="\u5173\u95ED">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
      </header>
      <div class="zp-body">
        <div class="zp-status">
          <span class="zp-stage"><i class="zp-dot" id="zygr-dot"></i><span id="zygr-stage">\u5C31\u7EEA</span></span>
          <span class="zp-count" id="zygr-progress" hidden></span>
          <span class="zp-chip" id="zygr-cache">\u5F85\u914D\u7F6E</span>
        </div>
        <div class="zp-track"><i id="zygr-bar"></i></div>
        <section class="zp-card" aria-label="\u5F53\u524D\u9898\u76EE">
          <div class="zp-qhead">
            <div class="zp-qmain">
              <span class="zp-kicker">\u5F53\u524D\u9898\u76EE</span>
              <div class="zp-qtitle" id="zygr-qtitle">\u672A\u8BFB\u53D6</div>
              <div class="zp-qmeta" id="zygr-meta">\u5C1A\u672A\u68C0\u6D4B\u5230\u9605\u5377\u9875\u9762</div>
            </div>
          </div>
          <div class="zp-thumbs" id="zygr-thumbs"></div>
        </section>
        <section class="zp-card zp-result" id="zygr-result" aria-live="polite"></section>
        <div class="zp-error" id="zygr-error" hidden></div>
      </div>
      <footer class="zp-foot">
        <div class="zp-actions">
          <button class="zp-btn primary" data-act="grade">\u5F00\u59CB\u6279\u6539</button>
          <button class="zp-btn zp-submit" data-act="submit">\u63D0\u4EA4\u7ED3\u679C</button>
        </div>
        <div class="zp-options">
          <button class="zp-mini" data-act="continuous">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5l11 7-11 7z"/></svg>
            <span>\u8FDE\u7EED\u6279\u9605</span>
          </button>
          <span class="zp-optlabel">\u6700\u591A</span>
          <div class="zp-stepper" title="${CONTINUOUS_LIMIT_HINT}">
            <button data-step="-1" aria-label="\u51CF\u5C11\u4EFD\u6570">\u2212</button>
            <input type="number" data-opt="continuous-limit" min="1" max="${CONTINUOUS_LIMIT_MAX}" step="1" value="20" aria-label="\u8FDE\u7EED\u6279\u9605\u6700\u591A\u6279\u6539\u4EFD\u6570" title="${CONTINUOUS_LIMIT_HINT}">
            <button data-step="1" aria-label="\u589E\u52A0\u4EFD\u6570">+</button>
          </div>
          <span class="zp-optlabel">\u4EFD</span>
          <div class="zp-seg" role="group" aria-label="\u8F93\u51FA\u6863\u4F4D" title="${OUTPUT_MODE_HINT}">${outputButtons}
          </div>
        </div>
        <div class="zp-footbar">
          <label class="zp-skip" title="\u52FE\u9009\u540E\u63D0\u4EA4\u4E0D\u518D\u5F39\u786E\u8BA4\u6846">
            <input type="checkbox" data-opt="skip-submit-confirm">
            <span class="zp-switch" aria-hidden="true"></span>
            <span>\u63D0\u4EA4\u514D\u786E\u8BA4</span>
          </label>
          <span class="zp-tools">
            <button class="zp-quiet" data-act="history">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
              \u5386\u53F2
            </button>
            <button class="zp-quiet" data-act="settings">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="7" cy="17" r="2"/></svg>
              \u8BBE\u7F6E
            </button>
          </span>
        </div>
      </footer>
      <div class="zygr-toast" id="zygr-toast" hidden></div>
    </div>
    <div class="zygr-overlay" id="zygr-cache-help" hidden>
      <div class="zygr-dialog zygr-help" role="dialog" aria-modal="true" aria-labelledby="zygr-cache-help-title">
        <header class="zg-head">
          <div>
            <h2 id="zygr-cache-help-title">\u524D\u7F00\u7F13\u5B58\u672A\u547D\u4E2D</h2>
            <p>\u4E0D\u5F71\u54CD\u9605\u5377\u7ED3\u679C\uFF0C\u53EA\u5F71\u54CD\u8D39\u7528\u4E0E\u9996\u5B57\u901F\u5EA6</p>
          </div>
          <button class="zp-iconbtn" data-act="cache-help-close" aria-label="\u5173\u95ED">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </header>
        <div class="zygr-cache-help-body" id="zygr-cache-help-body"></div>
        <footer class="zg-foot">
          <div class="zg-foot-left"></div>
          <div class="zg-foot-right"><button class="zg-btn primary" data-act="cache-help-close">\u77E5\u9053\u4E86</button></div>
        </footer>
      </div>
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
        } else if (target?.matches?.("[data-opt='continuous-limit']")) {
          this.setContinuousLimit(target.value);
          this.callbacks.onContinuousLimitChange?.(normalizeContinuousLimit(target.value));
        }
      });
      this.shadow.addEventListener("click", (event) => {
        const step = event.target.closest("[data-step]");
        if (step) {
          if (step.disabled) return;
          const limitInput = this.shadow.querySelector("[data-opt='continuous-limit']");
          const next = normalizeContinuousLimit(Number(limitInput?.value || 20) + Number(step.dataset.step));
          this.setContinuousLimit(next);
          this.callbacks.onContinuousLimitChange?.(next);
          return;
        }
        const output = event.target.closest("[data-output-mode]");
        if (output) {
          const value = normalizeOutputMode(output.dataset.outputMode);
          this.setOutputMode(value);
          this.callbacks.onOutputModeChange?.(value);
          return;
        }
        const button = event.target.closest("[data-act]");
        if (!button) return;
        const action = button.dataset.act;
        if (action === "collapse") {
          const collapsed = this.panel.classList.toggle("is-collapsed");
          button.setAttribute("aria-expanded", String(!collapsed));
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
        } else if (action === "cache-help") {
          this.showCacheHelp();
        } else if (action === "cache-help-close") {
          this.hideCacheHelp();
        }
      });
      const help = this.shadow.querySelector("#zygr-cache-help");
      if (help) {
        help.addEventListener("click", (event) => {
          if (event.target === help) this.hideCacheHelp();
        });
      }
      this.shadow.addEventListener("keydown", (event) => {
        if (event.key === "Escape") this.hideCacheHelp();
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
      this.hideCacheHelp();
    }
    setSubtitle(value) {
      this.setText("zygr-subtitle", value);
    }
    setQuestion(question) {
      this.renderThumbs(question?.images ?? []);
      if (!question) {
        this.setText("zygr-qtitle", "\u672A\u8BFB\u53D6");
        this.setText("zygr-meta", "\u5C1A\u672A\u68C0\u6D4B\u5230\u9605\u5377\u9875\u9762");
        return;
      }
      const subs = question.subQuestions.length > 0 ? `${question.subQuestions.length} \u4E2A\u5C0F\u9898 \xB7 ` : "";
      this.setText("zygr-qtitle", `\u9898\u53F7 ${question.questionId}`);
      this.setText("zygr-meta", `${subs}\u6EE1\u5206 ${question.maxScore || "\u672A\u6307\u5B9A"} \xB7 \u4F5C\u7B54\u56FE\u7247 ${question.images.length} \u5F20`);
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
      const dot = this.q("#zygr-dot");
      dot.className = stage === "\u5B8C\u6210" ? "zp-dot ok" : stage.includes("\u505C\u6B62") ? "zp-dot warn" : "zp-dot";
    }
    setProgress(text) {
      const element = this.q("#zygr-progress");
      element.textContent = text || "";
      element.hidden = !text;
    }
    setCache(label, kind = "idle") {
      const chip = this.q("#zygr-cache");
      chip.textContent = label;
      chip.className = `zp-chip${kind === "ok" ? " ok" : kind === "warn" ? " warn" : kind === "new" ? " new" : ""}`;
    }
    setBusy(busy, label = "\u5904\u7406\u4E2D") {
      this.shadow.querySelectorAll('.zp-foot .zp-btn:not([data-act="continuous"]), .zp-quiet, [data-output-mode]').forEach((button) => {
        button.disabled = busy;
      });
      if (busy) this.setStage(label);
    }
    setAutoMode(active) {
      const button = this.q('[data-act="continuous"]');
      const label = button.querySelector("span");
      if (label) label.textContent = active ? "\u505C\u6B62\u8FDE\u7EED\u6279\u9605" : "\u8FDE\u7EED\u6279\u9605";
      button.classList.toggle("running", active);
      // 运行中改上限会让人误以为当前这一轮会跟着变；锁定后提示下一次启动才生效。
      const limit = this.shadow.querySelector("[data-opt='continuous-limit']");
      if (limit) limit.disabled = active;
      this.shadow.querySelectorAll("[data-step]").forEach((step) => {
        step.disabled = active;
      });
    }
    setContinuousLimit(value) {
      const limit = this.shadow.querySelector("[data-opt='continuous-limit']");
      if (limit) limit.value = String(normalizeContinuousLimit(value));
    }
    setOutputMode(value) {
      const mode = normalizeOutputMode(value);
      this.shadow.querySelectorAll("[data-output-mode]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.outputMode === mode));
      });
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
      this.cacheMiss = result.cacheMiss || null;

      const head = document.createElement("div");
      head.className = "zp-scorehead";
      const left = document.createElement("div");
      const kicker = document.createElement("span");
      kicker.className = "zp-kicker";
      kicker.textContent = "\u5F97\u5206";
      const score = document.createElement("div");
      score.className = "zp-score";
      const scoreInput = document.createElement("input");
      scoreInput.type = "number";
      scoreInput.className = "zp-total";
      scoreInput.min = "0";
      scoreInput.max = String(result.maxScore || 999);
      scoreInput.step = "0.5";
      scoreInput.value = String(Math.round(result.score * 10) / 10);
      scoreInput.title = "\u53EF\u76F4\u63A5\u4FEE\u6539\u603B\u5206";
      scoreInput.setAttribute("aria-label", "\u603B\u5206");
      const unit = document.createElement("span");
      unit.textContent = `/ ${result.maxScore || "\u2014"}`;
      score.append(scoreInput, unit);
      left.append(kicker, score);

      const badges = document.createElement("div");
      badges.className = "zp-badges";
      const statusPill = document.createElement("span");
      const statusKind = result.status === "legible" ? "ok" : result.status === "partial" ? "warn" : "bad";
      statusPill.className = `zp-pill ${statusKind}`;
      statusPill.textContent = STATUS_LABEL[result.status] || "\u5DF2\u8BC4\u5206";
      badges.appendChild(statusPill);
      if (result.needsReview) {
        const reviewPill = document.createElement("span");
        reviewPill.className = "zp-pill warn";
        reviewPill.textContent = "\u9700\u590D\u6838";
        badges.appendChild(reviewPill);
      }
      head.append(left, badges);
      container.appendChild(head);

      const reason = document.createElement("p");
      reason.className = "zp-reason";
      reason.textContent = result.reason || "\u672A\u8FD4\u56DE\u8BC4\u5206\u4F9D\u636E";
      container.appendChild(reason);

      if (result.subScores.length > 0) {
        const list = document.createElement("div");
        list.className = "zp-sublist";
        result.subScores.forEach((item, index) => {
          const row = document.createElement("div");
          row.className = "zp-subrow";
          const main = document.createElement("div");
          main.className = "zp-submain";
          const label = document.createElement("span");
          label.className = "zp-sublabel";
          label.textContent = item.label;
          const why = document.createElement("span");
          why.className = "zp-subreason";
          why.textContent = item.reason || "\u2014";
          main.append(label, why);
          const wrap = document.createElement("span");
          wrap.className = "zp-subscore";
          const subInput = document.createElement("input");
          subInput.type = "number";
          subInput.className = "zp-subinput";
          subInput.min = "0";
          subInput.max = String(item.maxScore || 999);
          subInput.step = "0.5";
          subInput.value = String(Math.round(Number(item.score) * 10) / 10);
          subInput.dataset.scoreIndex = String(index);
          subInput.title = "\u53EF\u76F4\u63A5\u4FEE\u6539\u8BE5\u5C0F\u9898\u5F97\u5206";
          subInput.setAttribute("aria-label", `\u5C0F\u9898 ${item.label} \u5F97\u5206`);
          const max = document.createElement("em");
          max.textContent = `/ ${item.maxScore || "\u2014"}`;
          wrap.append(subInput, max);
          row.append(main, wrap);
          list.appendChild(row);
        });
        container.appendChild(list);
      }

      const reviews = [...result.reviewReasons];
      if (reviews.length > 0) {
        const note = document.createElement("div");
        note.className = "zp-reviews";
        note.textContent = reviews.join("\uFF1B");
        container.appendChild(note);
      }

      const meta = document.createElement("div");
      meta.className = "zp-meta";
      // 多模态直评现在只有一条链路，不再显示「链路 vlm」；模型与耗时一行，token 消耗另起一行。
      const modelLine = document.createElement("div");
      modelLine.className = "zp-metaline";
      modelLine.textContent = `\u6A21\u578B ${result.model} \xB7 \u8017\u65F6 ${(result.elapsedMs / 1e3).toFixed(1)}s`;
      meta.appendChild(modelLine);
      // 用量直接取自响应里的 usage，读取它不消耗 token。
      const usage = result.usage;
      // 命中 0 也要显示，否则用户无法区分「接口没返回」和「这次没命中」。
      if (usage && (usage.prompt || usage.completion)) {
        const usageLine = document.createElement("div");
        usageLine.className = "zp-metaline";
        usageLine.textContent = `\u8F93\u5165 ${usage.prompt}\uFF08\u524D\u7F00\u547D\u4E2D ${Number(usage.cached) || 0}\uFF09 \xB7 \u8F93\u51FA ${usage.completion}${usage.reasoning ? `\uFF08\u542B\u601D\u8003 ${usage.reasoning}\uFF09` : ""}`;
        meta.appendChild(usageLine);
      }
      container.appendChild(meta);

      if (this.cacheMiss) {
        const hint = document.createElement("button");
        hint.type = "button";
        hint.className = "zp-notice";
        hint.dataset.act = "cache-help";
        hint.innerHTML = `<span></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`;
        const hintText = hint.querySelector("span");
        if (hintText) hintText.textContent = `\u524D\u7F00\u7F13\u5B58\u5DF2\u8FDE\u7EED ${this.cacheMiss.streak} \u6B21\u672A\u547D\u4E2D\uFF0C\u70B9\u51FB\u67E5\u770B\u539F\u56E0`;
        container.appendChild(hint);
      }
      this.setCache(result.cacheHit ? "\u7F13\u5B58\u547D\u4E2D" : "\u65B0\u7ED3\u679C", result.cacheHit ? "ok" : "new");
      this.setStage("\u5B8C\u6210");
    }
    // 未命中解释：只用本地累计的计数与估算值，不重新发请求。
    showCacheHelp() {
      const info = this.cacheMiss;
      const overlay = this.shadow.querySelector("#zygr-cache-help");
      const body = this.shadow.querySelector("#zygr-cache-help-body");
      if (!info || !overlay || !body) return;
      const section = (title, items) => {
        const wrap = document.createElement("div");
        wrap.className = "zygr-cache-help-section";
        const heading = document.createElement("h3");
        heading.textContent = title;
        const list = document.createElement("ul");
        for (const item of items) {
          const li = document.createElement("li");
          li.textContent = item;
          list.appendChild(li);
        }
        wrap.append(heading, list);
        return wrap;
      };
      const summary = document.createElement("p");
      summary.className = "zygr-cache-help-summary";
      summary.textContent = `${info.model} 已连续 ${info.streak} 次没有命中前缀缓存。本次固定文本约 ${info.textTokens} token，输入合计 ${info.promptTokens} token（含 ${info.imageCount} 张作答图）。`;
      const impact = document.createElement("p");
      impact.className = "zygr-cache-help-impact";
      impact.textContent = "不影响阅卷结果：缓存只复用输入的预计算，模型输出与不缓存时完全一致；它只影响 token 费用和首字速度。";
      const reasons = [];
      if (Number(info.driftCount) >= 2) {
        reasons.push(`这道题的固定文本在批改过程中变了 ${info.driftCount} 次（提示词哈希不一致），缓存每次都会重建。重点查题目、小题、分值是否在不同学生页面上解析得不一致。`);
      }
      reasons.push(...(info.modelEverHit
        ? [
          "这个模型命中过前缀缓存，说明它支持；这次连续未命中，更可能是固定文本没达到门槛、前缀被改动，或缓存已过期。",
          "固定文本里混进了每份都会变的内容：时间、学生姓名/学号，或页面解析出的小题数量与文案不一致。",
          "并发太高时请求被路由到了别的实例，或者距上一份超过 TTL（多数平台 5–15 分钟）。",
          "平台没有返回 cached_tokens 字段（部分中转/兼容网关会省略），无法据此判断。"
        ]
        : [
          "该平台可能按「整条消息」缓存：同一条消息里的作答图一变，前面的文字也一起失效（火山方舟的隐式缓存实测如此）。",
          "该模型可能不支持前缀缓存，或这个视觉模型不在缓存支持列表里——同平台的文本模型支持，不等于 VL 模型支持。",
          `固定文本约 ${info.textTokens} token，没达到该模型的最小缓存长度（参考：${getPlatformCacheNote(info.platform)}）。`,
          "平台没有返回 cached_tokens 字段（部分中转/兼容网关会省略），无法据此判断。"
        ]));
      const advice = [
        info.textTokens < 1024
          ? "固定文本不足 1024 token：换 DeepSeek（约 64）或智谱（约 128）最容易命中；文本超过 4096 时 Gemini 写入免费更划算。"
          : "文本长度已经够：优先换一个明确支持该视觉模型的平台，或检查前缀是否被动态内容打断。",
        "如果换了平台仍是 0 命中，说明它按整条消息缓存，图片一变文字就失效——别再为它调提示词，直接换平台。",
        "同一道题连续批完再换题，别在题与题之间来回跳。",
        "设置 → 限速与超时，把 RPM 降到 15 左右；并发越高，越容易被路由到没有缓存的实例。",
        "批量批改期间固定输出档位：切档会改写提示词，这道题的缓存要重新建立。"
      ];
      body.replaceChildren(impact, summary, section("可能的原因", reasons), section("可以怎么处理", advice));
      const note = document.createElement("p");
      note.className = "zygr-hint";
      note.textContent = `参考门槛：${getPlatformCacheNote(info.platform)}。以上是经验判断，最终以平台返回的 cached_tokens 为准。`;
      body.appendChild(note);
      overlay.hidden = false;
    }
    hideCacheHelp() {
      const overlay = this.shadow.querySelector("#zygr-cache-help");
      if (overlay) overlay.hidden = true;
    }
    // 换卷/定位后把结果区清空：旧分数留在面板上会诱导老师提交到另一份卷。
    clearResult() {
      const container = this.q("#zygr-result");
      container.replaceChildren();
      this.cacheMiss = null;
      this.hideCacheHelp();
      const empty = document.createElement("div");
      empty.className = "zp-empty";
      empty.innerHTML = `<span class="zp-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.7 4.4L18 9l-4.3 1.6L12 15l-1.7-4.4L6 9l4.3-1.6z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/></svg></span><strong>\u6279\u6539\u7ED3\u679C\u5C06\u663E\u793A\u5728\u8FD9\u91CC</strong><p>\u8BFB\u53D6\u4F5C\u7B54\u56FE\u540E\uFF0C\u6309\u5F53\u524D\u9898\u76EE\u7684\u53C2\u8003\u7B54\u6848\u4E0E\u8BC4\u5206\u6807\u51C6\u76F4\u63A5\u8BC4\u5206\u3002</p>`;
      container.appendChild(empty);
      this.setStage("\u5C31\u7EEA");
    }
    getScoreEdits() {
      const total = this.shadow.querySelector(".zp-total");
      const subInputs = [...this.shadow.querySelectorAll(".zp-subinput")];
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
  // 能否在阅卷页定位：必须有学号（旧记录没存学号就没法在记录列表里对上号）。
  function canJumpRecord(entry) {
    const identity = entry?.question?.identity;
    return Boolean(identity && String(identity.userCode || "").trim());
  }
  // 复核状态文案：供详情展示，导出用同一套口径。
  function reviewText(entry) {
    const confirmed = entry.confirmedScore === void 0 || entry.confirmedScore === null ? "" : `\uFF08\u786E\u8BA4 ${entry.confirmedScore} \u5206\uFF09`;
    const note = entry.reviewNote ? ` \xB7 ${entry.reviewNote}` : "";
    return entry.reviewedAt ? `\u5DF2\u590D\u6838${confirmed}${note}` : "\u672A\u590D\u6838";
  }
  // 列表列宽有限，日期压到「月-日 时:分」；详情里仍保留完整语义。
  function compactTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "\u2014";
    const pad = (number) => String(number).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  // 历史里可能有坏记录（早期版本写进过 result: null）：补齐成一个可渲染的占位，
  // 否则 render 里读 entry.result.score 会直接抛错，整个面板打不开。
  function normalizeHistoryEntries(entries) {
    return (Array.isArray(entries) ? entries : []).map((entry) => {
      if (!entry || !entry.question) return null;
      if (entry.result && typeof entry.result === "object") return entry;
      return {
        ...entry,
        result: {
          status: "unknown",
          score: 0,
          maxScore: Number(entry.question.maxScore) || 0,
          subScores: [],
          reason: "\u8FD9\u6761\u8BB0\u5F55\u7684\u5206\u6570\u4E22\u5931\u4E86\uFF0C\u5EFA\u8BAE\u91CD\u65B0\u6279\u6539",
          needsReview: true,
          reviewReasons: ["\u5206\u6570\u4E22\u5931"],
          cacheHit: false,
          elapsedMs: 0,
          usage: null,
          pipeline: "-",
          model: "-"
        }
      };
    }).filter(Boolean);
  }
  var HistoryPanel = class {
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.entries = [];
      this.selectedId = "";
      this.reviewFilter = "all";
      this.host = document.createElement("div");
      this.host.className = "zygr-host";
      this.shadow = this.host.attachShadow({ mode: "open" });
      this.shadow.innerHTML = `<style>${STYLES}</style>${this.markup()}`;
      guardEnter(this.shadow);
      this.bind();
    }
    markup() {
      return `<div class="zygr-overlay" hidden>
      <div class="zygr-dialog" role="dialog" aria-modal="true" aria-labelledby="zygr-history-title">
        <header class="zg-head">
          <div>
            <h2 id="zygr-history-title">\u5386\u53F2\u8BB0\u5F55</h2>
            <p id="zygr-history-sub">\u5171 0 \u6761</p>
          </div>
          <button class="zp-iconbtn" data-act="close" aria-label="\u5173\u95ED">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </header>
        <div class="zh-toolbar">
          <div class="zg-seg" data-seg="history" role="group" aria-label="\u590D\u6838\u7B5B\u9009">
            <button data-review="all" aria-pressed="true">\u5168\u90E8</button>
            <button data-review="review" aria-pressed="false">\u9700\u590D\u6838</button>
            <button data-review="normal" aria-pressed="false">\u6B63\u5E38</button>
          </div>
          <div class="zh-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
            <input data-filter="keyword" type="search" placeholder="\u641C\u7D22\u9898\u53F7\u6216\u8BC4\u5206\u4F9D\u636E" aria-label="\u641C\u7D22\u5386\u53F2">
          </div>
        </div>
        <div class="zh-summary" data-summary></div>
        <div class="zh-body">
          <div class="zh-list" data-list></div>
          <div class="zh-detail" data-detail><div class="zh-empty">\u9009\u62E9\u4E00\u6761\u8BB0\u5F55\u67E5\u770B\u8BE6\u60C5</div></div>
        </div>
        <footer class="zg-foot">
          <div class="zg-foot-left">
            <button class="zg-btn small danger" data-act="clear">\u6E05\u7A7A\u5386\u53F2</button>
          </div>
          <div class="zg-foot-right">
            <button class="zg-btn small" data-act="csv">\u5BFC\u51FA CSV</button>
            <button class="zg-btn small" data-act="html">\u5BFC\u51FA HTML</button>
            <button class="zg-btn small primary" data-act="next-review">\u4E0B\u4E00\u6761\u9700\u590D\u6838</button>
            <button class="zg-btn small ghost" data-act="close">\u5173\u95ED</button>
          </div>
        </footer>
      </div>
    </div>`;
    }
    q(selector) {
      const element = this.shadow.querySelector(selector);
      if (!element) throw new Error(`\u5386\u53F2\u754C\u9762\u5143\u7D20\u7F3A\u5931\uFF1A${selector}`);
      return element;
    }
    bind() {
      this.shadow.addEventListener("click", (event) => {
        const target = event.target;
        const reviewButton = target.closest("[data-review]");
        if (reviewButton) {
          this.reviewFilter = reviewButton.dataset.review || "all";
          this.shadow.querySelectorAll("[data-review]").forEach((item) => {
            item.setAttribute("aria-pressed", String(item === reviewButton));
          });
          this.render();
          return;
        }
        const action = target.closest("[data-act]")?.dataset.act;
        if (action === "close") this.hide();
        else if (action === "clear") this.callbacks.onClear();
        else if (action === "csv") this.callbacks.onExport("csv");
        else if (action === "html") this.callbacks.onExport("html");
        if (action === "next-review") {
          this.jumpNextReview();
          return;
        }
        if (action === "jump") {
          const row = target.closest("[data-id]");
          const entry = this.entries.find((item2) => item2.id === row?.dataset.id);
          if (entry) this.callbacks.onJump?.(entry);
          return;
        }
        const item = target.closest("[data-id]");
        if (item?.dataset.id) {
          this.selectedId = item.dataset.id;
          this.render();
        }
      });
      this.shadow.addEventListener("input", () => this.render());
      this.shadow.addEventListener("change", () => this.render());
    }
    filtered() {
      const keyword = this.q("[data-filter='keyword']").value.trim().toLowerCase();
      return this.entries.filter((entry) => {
        if (this.reviewFilter === "review" && !entry.result.needsReview) return false;
        if (this.reviewFilter === "normal" && entry.result.needsReview) return false;
        if (keyword && !`${entry.question.questionId} ${entry.result.reason}`.toLowerCase().includes(keyword)) return false;
        return true;
      });
    }
    render() {
      const list = this.q("[data-list]");
      list.replaceChildren();
      const entries = this.filtered();
      const reviewCount = this.entries.filter((entry) => entry.result.needsReview).length;
      this.q("#zygr-history-sub").textContent = `\u5171 ${this.entries.length} \u6761 \xB7 ${reviewCount} \u6761\u9700\u590D\u6838`;
      // 汇总只统计当前筛选结果，方便核对某个范围内的输入/输出与命中情况。
      this.q("[data-summary]").textContent = summaryText(entries);
      if (!entries.some((entry) => entry.id === this.selectedId)) {
        this.selectedId = entries.length ? entries[0].id : "";
      }
      if (entries.length === 0) {
        const empty = document.createElement("div");
        empty.className = "zh-empty";
        empty.textContent = "\u6682\u65E0\u7B26\u5408\u6761\u4EF6\u7684\u8BB0\u5F55";
        list.appendChild(empty);
      }
      for (const entry of entries) {
        const item = document.createElement("div");
        item.className = "zh-row";
        if (entry.result.needsReview) item.classList.add("needs");
        if (entry.id === this.selectedId) item.classList.add("is-selected");
        item.dataset.id = entry.id;

        const select = document.createElement("button");
        select.type = "button";
        select.className = "zh-select";
        select.setAttribute("aria-pressed", String(entry.id === this.selectedId));
        select.setAttribute("aria-label", `\u9898\u53F7 ${entry.question.questionId}\uFF0C${entry.result.score} \u5206\uFF0C${entry.result.needsReview ? "\u9700\u590D\u6838" : "\u5DF2\u6B63\u5E38"}`);

        const score = document.createElement("span");
        score.className = "zh-score";
        score.textContent = String(entry.result.score);

        const main = document.createElement("span");
        main.className = "zh-main";
        const line1 = document.createElement("span");
        line1.className = "zh-l1";
        line1.textContent = `\u9898\u53F7 ${entry.question.questionId}`;
        const line2 = document.createElement("span");
        line2.className = "zh-l2";
        const reviewed = entry.reviewedAt ? " \xB7 \u5DF2\u590D\u6838" : "";
        line2.textContent = `${compactTime(entry.createdAt)} \xB7 ${entry.result.score}/${entry.result.maxScore}${entry.result.needsReview ? " \xB7 \u9700\u590D\u6838" : ""}${reviewed}`;
        main.append(line1, line2);
        select.append(score, main);
        item.appendChild(select);

        // 单条记录上就能直接跳回阅卷页，不必先展开详情。
        if (canJumpRecord(entry)) {
          const jump = document.createElement("button");
          jump.type = "button";
          jump.className = "zh-jump";
          jump.dataset.act = "jump";
          jump.textContent = "\u5B9A\u4F4D";
          jump.title = "\u5728\u9605\u5377\u9875\u56DE\u8BC4\u8FD9\u4E00\u4EFD\u5377\u5B50";
          item.appendChild(jump);
        }
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
        empty.className = "zh-empty";
        empty.textContent = "\u9009\u62E9\u4E00\u6761\u8BB0\u5F55\u67E5\u770B\u8BE6\u60C5";
        container.appendChild(empty);
        return;
      }
      const usage = entryUsage(entry);
      const identity = entry.question.identity || {};
      const hitText = `${entryHitText(entry)} / ${entryElapsed(entry)}s`;
      const usageText = `\u8F93\u5165 ${usage.prompt}\uFF08\u524D\u7F00\u547D\u4E2D ${usage.cached}\uFF09 \xB7 \u8F93\u51FA ${usage.completion}${usage.reasoning ? `\uFF08\u542B\u601D\u8003 ${usage.reasoning}\uFF09` : ""}`;
      const locationText = identity.userCode
        ? `\u5B66\u53F7 ${escapeHtml(identity.userCode)} \xB7 \u8BD5\u5377 ${identity.markingPaperId ? "\u5DF2\u8BB0\u5F55" : "\u672A\u8BB0\u5F55"}`
        : "\u4E0D\u652F\u6301\uFF08\u65E7\u8BB0\u5F55\u6CA1\u5B58\u5B66\u53F7\uFF09";
      const subRows = (entry.result.subScores || []).map((item) => `
        <div class="zp-subrow">
          <div class="zp-submain"><span class="zp-sublabel">${escapeHtml(item.label)}</span><span class="zp-subreason">${escapeHtml(item.reason || "\u2014")}</span></div>
          <span class="zp-subscore"><span class="zp-pill">${escapeHtml(item.score)} / ${escapeHtml(item.maxScore)}</span></span>
        </div>`).join("");
      container.innerHTML = `
        <div class="zh-detailhead">
          <div>
            <span class="zp-kicker">\u9898\u53F7 ${escapeHtml(entry.question.questionId)}</span>
            <div class="zh-bigscore">${escapeHtml(entry.result.score)}<span>/ ${escapeHtml(entry.result.maxScore)} \u5206</span></div>
          </div>
          ${entry.result.needsReview ? '<span class="zp-pill warn">\u9700\u590D\u6838</span>' : '<span class="zp-pill ok">\u6B63\u5E38</span>'}
        </div>
        <p class="zp-reason">${escapeHtml(entry.result.reason || "\u65E0")}</p>
        <dl class="zh-stats">
          <div class="zh-statrow"><dt>\u6A21\u578B</dt><dd>${escapeHtml(entry.result.model)}</dd></div>
          <div class="zh-statrow"><dt>\u7F13\u5B58 / \u8017\u65F6</dt><dd>${escapeHtml(hitText)}</dd></div>
          <div class="zh-statrow"><dt>\u7528\u91CF</dt><dd>${usageText}</dd></div>
          <div class="zh-statrow"><dt>\u5B9A\u4F4D</dt><dd>${locationText}</dd></div>
          <div class="zh-statrow"><dt>\u590D\u6838</dt><dd>${escapeHtml(reviewText(entry))}</dd></div>
        </dl>
        <h4 class="zh-h4">\u5C0F\u9898</h4>
        <div class="zp-sublist" style="margin-top:2px">${subRows || '<div class="zp-reason">\u65E0</div>'}</div>
        <div class="zh-actions">
          <button class="zg-btn small primary" data-act="detail-jump" ${canJumpRecord(entry) ? "" : "disabled"} title="${canJumpRecord(entry) ? "\u5728\u9605\u5377\u9875\u56DE\u8BC4\u8FD9\u4E00\u4EFD\u5377\u5B50" : "\u8BE5\u8BB0\u5F55\u6CA1\u6709\u5B66\u53F7\uFF0C\u65E0\u6CD5\u5B9A\u4F4D"}">\u5B9A\u4F4D\u5230\u8BE5\u5377</button>
          <button class="zg-btn small" data-act="detail-review">${entry.reviewedAt ? "\u4FEE\u6539\u590D\u6838\u5907\u6CE8" : "\u6807\u8BB0\u5DF2\u590D\u6838"}</button>
          <button class="zg-btn small ghost" data-act="detail-score">\u8BB0\u5F55\u786E\u8BA4\u5206</button>
        </div>`;

      const jumpButton = container.querySelector('[data-act="detail-jump"]');
      if (jumpButton) jumpButton.addEventListener("click", () => this.callbacks.onJump?.(entry));
      // 复核留痕：备注与确认分都写回历史，导出时一并带出。
      const reviewButton = container.querySelector('[data-act="detail-review"]');
      if (reviewButton) {
        reviewButton.addEventListener("click", () => {
          const note = window.prompt("\u590D\u6838\u5907\u6CE8\uFF08\u53EF\u7559\u7A7A\uFF09", entry.reviewNote || "");
          if (note === null) return;
          this.callbacks.onReview?.(entry.id, { reviewedAt: Date.now(), reviewNote: note.trim() });
        });
      }
      const scoreButton = container.querySelector('[data-act="detail-score"]');
      if (scoreButton) {
        scoreButton.addEventListener("click", () => {
          const raw = window.prompt("\u786E\u8BA4\u5206\u6570", String(entry.confirmedScore ?? entry.result.score));
          if (raw === null) return;
          const value = Number(raw);
          if (!Number.isFinite(value)) return;
          const max = Number(entry.result.maxScore) || 999;
          this.callbacks.onReview?.(entry.id, { confirmedScore: Math.min(Math.max(value, 0), max) });
        });
      }
    }
    // 复核队列：把「需复核且还没标记」的记录按当前筛选排成一条队，一条条定位过去。
    nextReviewEntry() {
      const pending = this.filtered().filter((entry) => entry.result.needsReview && !entry.reviewedAt && canJumpRecord(entry));
      if (pending.length === 0) return null;
      const index = pending.findIndex((entry) => entry.id === this.selectedId);
      return pending[index + 1] || pending[0];
    }
    jumpNextReview() {
      const next = this.nextReviewEntry();
      if (!next) {
        this.callbacks.onEmptyQueue?.();
        return;
      }
      this.selectedId = next.id;
      this.render();
      // 第二个参数标记「来自复核队列」：主流程据此在提交后自动跳下一条。
      this.callbacks.onJump?.(next, true);
    }
    mount() {
      if (!this.host.isConnected) document.body.appendChild(this.host);
    }
    show(entries) {
      this.entries = normalizeHistoryEntries(entries);
      this.mount();
      this.q(".zygr-overlay").hidden = false;
      this.render();
    }
    hide() {
      this.q(".zygr-overlay").hidden = true;
    }
    refresh(entries) {
      this.entries = normalizeHistoryEntries(entries);
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
      // 三个面板统一挂同一个标记类：便于排查与外部工具定位（本身不带样式）。
      this.host.className = "zygr-host";
      this.shadow = this.host.attachShadow({ mode: "open" });
      this.shadow.innerHTML = `<style>${STYLES}</style>${this.markup()}`;
      guardEnter(this.shadow);
      this.bind();
    }
    markup() {
      const fieldRow = (label, path, type = "text", extra = "") => `
        <div class="zg-row">
          <div class="zg-rowmain"><span class="zg-rowlabel">${label}</span></div>
          <input class="zg-input zg-num" data-field="${path}" type="${type}" aria-label="${label}" ${extra}>
        </div>`;
      const area = (label, path, rows, placeholder, badge = "") => `
        <div class="zg-field">
          <label>${label}${badge}</label>
          <textarea data-field="${path}" rows="${rows}" placeholder="${placeholder}"></textarea>
        </div>`;
      return `<div class="zygr-overlay" hidden>
      <div class="zygr-dialog" role="dialog" aria-modal="true" aria-labelledby="zygr-settings-title">
        <header class="zg-head">
          <div>
            <h2 id="zygr-settings-title">\u8BBE\u7F6E</h2>
            <p>\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u914D\u7F6E\u53EA\u4FDD\u5B58\u5728\u672C\u673A</p>
          </div>
          <button class="zp-iconbtn" data-act="close" aria-label="\u5173\u95ED">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </header>

        <div class="zg-shell">
          <nav class="zg-nav" aria-label="\u8BBE\u7F6E\u5206\u533A" role="tablist">
            <button class="zg-navitem is-active" data-tab="context" role="tab" aria-selected="true">
              <span class="zg-tile blue" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h9a3 3 0 013 3v13H8a3 3 0 01-3-3z"/><path d="M8 4v13a3 3 0 00-3 3"/></svg></span>
              \u6279\u6539\u4E0A\u4E0B\u6587
            </button>
            <button class="zg-navitem" data-tab="api" role="tab" aria-selected="false">
              <span class="zg-tile purple" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v4M15 3v4M7 7h10v3a5 5 0 01-10 0zM12 15v6"/></svg></span>
              \u63A5\u53E3\u4E0E\u94FE\u8DEF
            </button>
            <button class="zg-navitem" data-tab="generator" role="tab" aria-selected="false">
              <span class="zg-tile pink" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.7 4.4L18 9l-4.3 1.6L12 15l-1.7-4.4L6 9l4.3-1.6z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/></svg></span>
              \u8BC4\u5206\u6807\u51C6\u751F\u6210
            </button>
            <button class="zg-navitem" data-tab="advanced" role="tab" aria-selected="false">
              <span class="zg-tile gray" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6h14M5 12h14M5 18h14"/><circle cx="9" cy="6" r="2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="8" cy="18" r="2" fill="currentColor" stroke="none"/></svg></span>
              \u9AD8\u7EA7
            </button>
            <div class="zg-navfoot">\u6240\u6709\u914D\u7F6E\u4E0E\u8BB0\u5F55\u53EA\u5B58\u5728\u6D4F\u89C8\u5668\u672C\u5730\uFF0C\u4E0D\u4E0A\u4F20\u670D\u52A1\u5668\u3002\u6E05\u7A7A\u6570\u636E\u540E\u9700\u91CD\u65B0\u586B\u5199\u3002</div>
          </nav>

          <div class="zg-pane">
            <div class="zg-page is-active" data-page="context">
              <div class="zg-pagehead">
                <h2>\u6279\u6539\u4E0A\u4E0B\u6587</h2>
                <p>\u9898\u53F7\u3001\u6EE1\u5206\u4E0E\u5C0F\u9898\u7531\u9605\u5377\u9875\u8BFB\u53D6\uFF1B\u8FD9\u91CC\u7684\u53C2\u8003\u7B54\u6848\u4E0E\u8BC4\u5206\u6807\u51C6\u4F1A\u968F\u6BCF\u6B21\u6279\u6539\u53D1\u9001\u7ED9\u6A21\u578B\u3002</p>
              </div>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u9898\u76EE\u4E0E\u9605\u5377\u4F9D\u636E</h3>
                <div class="zg-group">
                  ${area("\u9898\u76EE\u5185\u5BB9", "context.question", 3, "\u7559\u7A7A\u65F6\u4F7F\u7528\u9875\u9762\u9898\u53F7\uFF0C\u586B\u5199\u540E\u80FD\u63D0\u9AD8\u5224\u65AD\u7CBE\u5EA6", '<span class="zg-opt">\u53EF\u9009</span>')}
                  ${area("\u53C2\u8003\u7B54\u6848", "context.answer", 5, "", '<span class="zg-req">\u5FC5\u586B</span>')}
                  ${area("\u8BC4\u5206\u6807\u51C6", "context.rubric", 6, "", '<span class="zg-req">\u5FC5\u586B</span>')}
                </div>
                <p class="zg-note">\u6EE1\u5206\u4E0D\u5FC5\u624B\u5DE5\u7EF4\u62A4\uFF1A\u6279\u6539\u524D\u4F1A\u8BFB\u9875\u9762\uFF0C\u4E0D\u4E00\u81F4\u65F6\u81EA\u52A8\u5199\u56DE\u5E76\u63D0\u793A\u4E00\u884C\uFF0C\u4E0D\u518D\u963B\u65AD\u6279\u6539\u3002</p>
              </section>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u57FA\u672C\u53C2\u6570</h3>
                <div class="zg-group">
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u672C\u65B9\u6848\u6EE1\u5206</span><span class="zg-rowdesc">\u4E0E\u9875\u9762\u4E0D\u4E00\u81F4\u65F6\u81EA\u52A8\u540C\u6B65</span></div>
                    <input class="zg-input zg-num" data-field="context.maxScore" type="number" aria-label="\u672C\u65B9\u6848\u6EE1\u5206">
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u5B66\u79D1</span><span class="zg-rowdesc">\u7528\u4E8E\u81EA\u52A8\u5957\u7528\u56FE\u7247\u7B56\u7565\u4E0E\u5224\u5206\u53E3\u5F84</span></div>
                    <span class="zg-select">
                      <select data-field="context.subject" aria-label="\u5B66\u79D1">
                        <option value="">\u4E0D\u6307\u5B9A\uFF08\u6309\u624B\u52A8\u53C2\u6570\uFF09</option>
                        ${Object.keys(RUBRIC_SUBJECTS).map((name) => `<option value="${name}">${name}</option>`).join("")}
                      </select>
                    </span>
                  </div>
                </div>
              </section>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u6807\u51C6\u5E93</h3>
                <div class="zg-group">
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u672C\u9898\u6807\u51C6</span><span class="zg-rowdesc">\u6309\u300C\u8BD5\u5377 + \u9898\u53F7\u300D\u5206\u69FD\u4FDD\u5B58</span></div>
                    <div class="zg-rowactions">
                      <button class="zg-btn small" data-act="rubric-save">\u4FDD\u5B58</button>
                      <button class="zg-btn small ghost" data-act="rubric-load">\u8F7D\u5165</button>
                      <button class="zg-btn small ghost" data-act="rubric-clear">\u6E05\u7A7A</button>
                    </div>
                  </div>
                </div>
                <p class="zg-note">\u5207\u5230\u5176\u5B83\u9898\u53F7\u65F6\u4F1A\u81EA\u52A8\u5B58\u4E0B\u5F53\u524D\u8FD9\u4EFD\u3001\u5E76\u8F7D\u5165\u90A3\u9053\u9898\u5DF2\u5B58\u7684\u6807\u51C6\uFF1B\u6CA1\u5B58\u8FC7\u5219\u6E05\u7A7A\u7B54\u6848\u4E0E\u6807\u51C6\uFF0C\u907F\u514D\u62FF\u9519\u7B54\u6848\u3002</p>
              </section>
            </div>

            <div class="zg-page" data-page="api" hidden>
              <div class="zg-pagehead">
                <h2>\u63A5\u53E3\u4E0E\u94FE\u8DEF</h2>
                <p>\u8BC4\u5206\u53EA\u8D70\u591A\u6A21\u6001\u76F4\u8BC4\uFF1A\u628A\u4F5C\u7B54\u56FE\u76F4\u63A5\u4EA4\u7ED9\u89C6\u89C9\u6A21\u578B\uFF0C\u4E0D\u505A OCR \u4E2D\u8F6C\u3002</p>
              </div>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u5E73\u53F0\u9884\u8BBE</h3>
                <div class="zg-group">
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u5E73\u53F0</span><span class="zg-rowdesc">\u5207\u6362\u4F1A\u6062\u590D\u8BE5\u5E73\u53F0\u8BB0\u4F4F\u7684 Key\u3001\u6A21\u578B\u4E0E\u601D\u8003\u6A21\u5F0F</span></div>
                    <span class="zg-select wide"><select data-field="pipeline.vlm.platform" data-platform-select aria-label="\u5E73\u53F0\u9884\u8BBE"></select></span>
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u63A5\u53E3\u5730\u5740</span></div>
                    <input class="zg-input" data-field="pipeline.vlm.endpoint" style="max-width:340px" aria-label="\u63A5\u53E3\u5730\u5740">
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">API Key</span></div>
                    <span class="zg-inputwrap">
                      <input class="zg-input" data-field="pipeline.vlm.apiKey" type="password" aria-label="API Key">
                      <button data-act="toggle-key" aria-label="\u663E\u793A\u6216\u9690\u85CF API Key">\u663E\u793A</button>
                    </span>
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u6A21\u578B</span><span class="zg-rowdesc">\u5FC5\u987B\u652F\u6301\u56FE\u7247\u8F93\u5165</span></div>
                    <input class="zg-input" data-field="pipeline.vlm.model" style="max-width:200px" aria-label="\u6A21\u578B\u540D\u79F0">
                  </div>
                  <div class="zg-row" data-model-options hidden>
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u6A21\u578B\u5217\u8868</span><span class="zg-rowdesc">\u9009\u62E9\u4E00\u4E2A\u586B\u5165\u4E0A\u65B9\u6A21\u578B</span></div>
                    <span class="zg-select"><select data-field-model-picker aria-label="\u9009\u62E9\u6A21\u578B"></select></span>
                    <button class="zg-btn small" data-act="apply-model">\u4F7F\u7528</button>
                  </div>
                </div>
                <div class="zg-inline" style="margin-top:8px">
                  <button class="zg-btn small" data-act="fetch-models">\u83B7\u53D6\u6A21\u578B\u5217\u8868</button>
                  <span class="zg-status" data-status="models"></span>
                  <button class="zg-btn small" data-test="vlm">\u6D4B\u8BD5\u591A\u6A21\u6001</button>
                  <span class="zg-status" data-status="vlm"></span>
                </div>
                <p class="zg-note">\u5E73\u53F0\u4E0D\u652F\u6301\u5728\u7EBF\u5217\u8868\u65F6\u53EA\u63D0\u793A\u624B\u52A8\u586B\u5199\uFF0C\u4E0D\u4F1A\u62A5\u9519\u4E2D\u65AD\u3002</p>
              </section>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u601D\u8003\u6A21\u5F0F</h3>
                <div class="zg-group">
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u601D\u8003\u7A0B\u5EA6</span><span class="zg-rowdesc">\u9ED8\u8BA4\u5173\u95ED\uFF0C\u957F\u94FE\u63A8\u7406\u6A21\u578B\u53EF\u80FD\u9700\u6570\u5341\u79D2</span></div>
                    <div class="zg-seg" data-seg="thinking" role="group" aria-label="\u601D\u8003\u6A21\u5F0F">
                      <button data-value="off" aria-pressed="true" title="${thinkingLevelLabel("off")}">${thinkingLevelLabel("off")}</button>
                      <button data-value="auto" aria-pressed="false" title="${thinkingLevelLabel("auto")}">${thinkingLevelLabel("auto").replace(/\uFF08.*$/, "")}</button>
                    </div>
                    <select data-field="pipeline.thinkingMode" hidden aria-hidden="true" tabindex="-1">
                      <option value="off">${thinkingLevelLabel("off")}</option>
                      <option value="auto">${thinkingLevelLabel("auto")}</option>
                    </select>
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u751F\u6548\u68C0\u6D4B</span><span class="zg-rowdesc">GLM-5.3 \u7B49\u6A21\u578B\u4F1A\u5F3A\u5236\u601D\u8003\uFF0C\u9009\u5173\u95ED\u4E5F\u6309\u6A21\u578B\u9ED8\u8BA4\u8FD0\u884C</span></div>
                    <button class="zg-btn small" data-act="test-thinking">\u6D4B\u8BD5</button>
                    <span class="zg-status" data-status="thinking"></span>
                  </div>
                </div>
                <p class="zg-note">\u80FD\u4E0D\u80FD\u5173\u95ED\u53D6\u51B3\u4E8E\u6A21\u578B\u800C\u4E0D\u662F\u5E73\u53F0\uFF1B\u5982\u679C\u8FD4\u56DE\u201C\u4E0D\u652F\u6301\u5173\u95ED\u601D\u8003\u201D\uFF0C\u7A0B\u5E8F\u4F1A\u81EA\u52A8\u8BC6\u522B\u5E76\u8BB0\u4F4F\uFF0C\u4E0B\u6B21\u4E0D\u518D\u91CD\u590D\u8BD5\u9519\u3002</p>
              </section>
            </div>

            <div class="zg-page" data-page="generator" hidden>
              <div class="zg-pagehead">
                <h2>\u8BC4\u5206\u6807\u51C6\u751F\u6210</h2>
                <p>\u9009\u5B66\u79D1\u4E0E\u9898\u578B\uFF0C\u586B\u5199\u9898\u76EE\u4E0E\u5B66\u6821\u6807\u51C6\u7B54\u6848\uFF0C\u8BA9\u6A21\u578B\u751F\u6210\u7ED3\u6784\u5316\u8BC4\u5206\u6807\u51C6\u3002\u4F1A\u6D88\u8D39\u4E00\u6B21\u771F\u5B9E\u8BF7\u6C42\u3002</p>
              </div>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u751F\u6210\u6761\u4EF6</h3>
                <div class="zg-group">
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u5B66\u79D1</span></div>
                    <span class="zg-select"><select data-gen="subject" aria-label="\u5B66\u79D1">${Object.keys(RUBRIC_SUBJECTS).map((name) => `<option value="${name}">${name}</option>`).join("")}</select></span>
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u9898\u578B</span></div>
                    <span class="zg-select"><select data-gen="type" aria-label="\u9898\u578B"></select></span>
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u6EE1\u5206</span><span class="zg-rowdesc">\u7559\u7A7A\u5219\u7531 AI \u5EFA\u8BAE</span></div>
                    <input class="zg-input zg-num" type="number" data-gen="maxScore" min="0" step="0.5" aria-label="\u6EE1\u5206">
                  </div>
                </div>
                <p class="zg-note" data-gen="rule-hint"></p>
              </section>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u9898\u76EE\u4E0E\u6807\u51C6\u7B54\u6848</h3>
                <div class="zg-group">
                  <div class="zg-field">
                    <label>\u9898\u76EE <span class="zg-opt">\u4F5C\u6587\u7C7B\u5FC5\u586B</span></label>
                    <textarea data-gen="question" rows="3" placeholder="\u53EF\u7C98\u8D34\u9898\u76EE\u6587\u5B57\uFF0C\u6216\u7559\u7A7A\u4EC5\u7528\u56FE\u7247"></textarea>
                  </div>
                  <div class="zg-field">
                    <label>\u5B66\u6821\u6807\u51C6\u7B54\u6848</label>
                    <textarea data-gen="answer" rows="4" placeholder="\u5316\u5B66\u5F0F\u3001\u516C\u5F0F\u7B26\u53F7\u53EF\u76F4\u63A5\u7C98\u8D34"></textarea>
                  </div>
                  <div class="zg-field">
                    <label>\u6807\u51C6\u7B54\u6848\u56FE\u7247 <span class="zg-opt">\u53EF\u591A\u9009</span></label>
                    <label class="zg-drop">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M8 8l4-4 4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>
                      <span>\u70B9\u51FB\u9009\u62E9\u56FE\u7247</span>
                      <small>\u652F\u6301\u591A\u5F20\uFF0C\u6309\u987A\u5E8F\u53D1\u9001\u7ED9\u6A21\u578B</small>
                      <input type="file" data-gen="images" accept="image/*" multiple>
                    </label>
                    <p class="zg-note" data-gen-thumbs></p>
                  </div>
                </div>
                <div class="zg-inline" style="margin-top:8px">
                  <button class="zg-btn primary" data-act="gen-run">\u751F\u6210\u8BC4\u5206\u6807\u51C6</button>
                  <span class="zg-status" data-status="gen"></span>
                </div>
              </section>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u751F\u6210\u7ED3\u679C</h3>
                <div class="zg-group">
                  <div class="zg-field">
                    <label>\u53EF\u76F4\u63A5\u7F16\u8F91\uFF0C\u786E\u8BA4\u65E0\u8BEF\u540E\u4E00\u952E\u586B\u5165</label>
                    <textarea data-gen="result" rows="10" placeholder="\u751F\u6210\u7684\u6807\u51C6\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC"></textarea>
                  </div>
                </div>
                <div class="zg-inline" style="margin-top:8px">
                  <button class="zg-btn" data-act="gen-apply">\u4E00\u952E\u586B\u5165\u6279\u6539\u4E0A\u4E0B\u6587</button>
                  <button class="zg-btn ghost" data-act="gen-copy">\u590D\u5236</button>
                  <button class="zg-btn ghost" data-act="gen-clear">\u6E05\u7A7A</button>
                </div>
              </section>
            </div>

            <div class="zg-page" data-page="advanced" hidden>
              <div class="zg-pagehead">
                <h2>\u9AD8\u7EA7</h2>
                <p>\u56FE\u7247\u3001\u7F13\u5B58\u3001\u9650\u6D41\u4E0E\u7528\u91CF\u3002\u6539\u9519\u8FD9\u91CC\u4E0D\u4F1A\u5F04\u574F\u6570\u636E\uFF0C\u4F46\u53EF\u80FD\u8BA9\u6279\u6539\u53D8\u6162\u6216\u53D8\u8D35\u3002</p>
              </div>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u56FE\u7247\u4E0E\u63D0\u793A\u8BCD</h3>
                <div class="zg-group">
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u56FE\u7247\u7CBE\u5EA6</span><span class="zg-rowdesc">\u624B\u5199\u5185\u5BB9\u5EFA\u8BAE\u9AD8\u7CBE\u5EA6</span></div>
                    <div class="zg-seg" data-seg="detail" role="group" aria-label="\u56FE\u7247\u7CBE\u5EA6">
                      <button data-value="high" aria-pressed="true">\u9AD8</button>
                      <button data-value="auto" aria-pressed="false">\u81EA\u52A8</button>
                      <button data-value="low" aria-pressed="false">\u4F4E</button>
                    </div>
                    <select data-field="image.detail" hidden aria-hidden="true" tabindex="-1">
                      <option value="high">\u9AD8\u7CBE\u5EA6</option>
                      <option value="auto">\u81EA\u52A8</option>
                      <option value="low">\u4F4E\u7CBE\u5EA6</option>
                    </select>
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u56FE\u7247\u957F\u8FB9\u4E0A\u9650</span><span class="zg-rowdesc">\u53EA\u7B49\u6BD4\u7F29\u5C0F\uFF0C\u7EDD\u4E0D\u653E\u5927</span></div>
                    <input class="zg-input zg-num" data-field="image.maxEdge" type="number" aria-label="\u56FE\u7247\u957F\u8FB9\u4E0A\u9650">
                    <span class="zg-rowvalue">px</span>
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">JPEG \u8D28\u91CF</span><span class="zg-rowdesc">\u4E0D\u5F71\u54CD\u8BA1\u8D39\uFF0C\u53EA\u5F71\u54CD\u4F53\u79EF</span></div>
                    <input class="zg-input zg-num" data-field="image.quality" type="number" step="0.01" aria-label="JPEG \u8D28\u91CF">
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u5386\u53F2\u4FDD\u7559\u6761\u6570</span></div>
                    <input class="zg-input zg-num" data-field="historyLimit" type="number" aria-label="\u5386\u53F2\u4FDD\u7559\u6761\u6570">
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u7F13\u5B58\u6709\u6548\u671F</span><span class="zg-rowdesc">\u8D85\u671F\u540E\u540C\u9898\u540C\u56FE\u9700\u91CD\u65B0\u8BF7\u6C42</span></div>
                    <input class="zg-input zg-num" data-field="cacheTtlDays" type="number" aria-label="\u7F13\u5B58\u6709\u6548\u671F">
                    <span class="zg-rowvalue">\u5929</span>
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u7F13\u5B58\u6761\u6570\u4E0A\u9650</span><span class="zg-rowdesc">\u53CC\u8BC4\u5927\u5377\u53EF\u63D0\u5230 3000</span></div>
                    <input class="zg-input zg-num" data-field="cacheMaxEntries" type="number" aria-label="\u7F13\u5B58\u6761\u6570\u4E0A\u9650">
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u6309\u5B66\u79D1\u81EA\u52A8\u5957\u7528\u56FE\u7247\u7B56\u7565</span><span class="zg-rowdesc">\u6570\u5B66/\u7269\u7406/\u5316\u5B66 1600px\uFF0C\u8BED\u6587/\u82F1\u8BED/\u751F\u7269 1440px\uFF0C\u5386\u53F2/\u653F\u6CBB/\u5730\u7406 1280px</span></div>
                    <label class="zg-switch">
                      <input type="checkbox" data-field="image.autoBySubject" aria-label="\u6309\u5B66\u79D1\u81EA\u52A8\u5957\u7528\u56FE\u7247\u7B56\u7565">
                      <span class="zg-switch-track" aria-hidden="true"></span>
                    </label>
                  </div>
                </div>
                <p class="zg-note">\u56FE\u7247 token \u53EA\u53D7\u5C3A\u5BF8\u4E0E\u7CBE\u5EA6\u5F71\u54CD\uFF1B\u4F4E\u7CBE\u5EA6\u4E0E\u4F4E\u5206\u8FA8\u7387\u4F1A\u81EA\u52A8\u6807\u8BB0\u4EBA\u5DE5\u590D\u6838\u3002\u8F93\u51FA\u6863\u4F4D\u5DF2\u79FB\u5230\u4E3B\u9762\u677F\u5E95\u90E8\u3002</p>
              </section>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u7D2F\u8BA1\u7528\u91CF</h3>
                <div class="zg-group"><p class="zg-statsline" data-stats>\u7D2F\u8BA1\u7528\u91CF\uFF1A\u6682\u65E0</p></div>
              </section>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u9650\u901F\u4E0E\u8D85\u65F6</h3>
                <div class="zg-group">
                  ${fieldRow("\u5E76\u53D1\u4E0A\u9650", "pipeline.maxConcurrent", "number")}
                  ${fieldRow("RPM \u9884\u7B97", "pipeline.maxRpm", "number")}
                  ${fieldRow("TPM \u9884\u7B97", "pipeline.maxTpm", "number")}
                  ${fieldRow("\u8BF7\u6C42\u8D85\u65F6", "pipeline.timeoutMs", "number")}
                </div>
                <p class="zg-note">\u6240\u6709\u914D\u7F6E\u4EC5\u4FDD\u5B58\u5728\u5F53\u524D\u6CB9\u7334\u73AF\u5883\u4E2D\uFF0C\u4E0D\u4F1A\u8BFB\u53D6\u65E7\u63D2\u4EF6\u914D\u7F6E\uFF1B\u6E05\u7A7A\u6570\u636E\u540E\u9700\u91CD\u65B0\u586B\u5199\u3002</p>
              </section>
              <section class="zg-section">
                <h3 class="zg-grouptitle">\u6570\u636E</h3>
                <div class="zg-group">
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u91CD\u7F6E\u4E3A\u9ED8\u8BA4\u914D\u7F6E</span><span class="zg-rowdesc">\u542B\u63A5\u53E3\u5730\u5740\u4E0E\u56FE\u7247\u53C2\u6570\uFF0CAPI Key \u4E5F\u4F1A\u6E05\u7A7A</span></div>
                    <button class="zg-btn small danger" data-act="reset">\u91CD\u7F6E</button>
                  </div>
                  <div class="zg-row">
                    <div class="zg-rowmain"><span class="zg-rowlabel">\u6E05\u7A7A\u5168\u90E8\u6570\u636E</span><span class="zg-rowdesc">\u5386\u53F2\u3001\u7F13\u5B58\u3001\u6807\u51C6\u5E93\u4E0E\u914D\u7F6E\u4E00\u5E76\u5220\u9664</span></div>
                    <button class="zg-btn small danger" data-act="clear">\u6E05\u7A7A</button>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>

        <footer class="zg-foot">
          <div class="zg-foot-left">
            <button class="zg-btn small ghost" data-act="export">\u5BFC\u51FA\u914D\u7F6E</button>
            <button class="zg-btn small ghost" data-act="import">\u5BFC\u5165\u914D\u7F6E</button>
          </div>
          <div class="zg-foot-right">
            <button class="zg-btn" data-act="cancel">\u5173\u95ED</button>
            <button class="zg-btn primary" data-act="save">\u4FDD\u5B58\u914D\u7F6E</button>
          </div>
        </footer>
        <input type="file" data-config-file accept="application/json,.json" hidden>
        <div class="zygr-toast" data-toast hidden></div>
      </div>
    </div>`;
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
          this.shadow.querySelectorAll("[data-tab]").forEach((item) => {
            const active = item === tab;
            item.classList.toggle("is-active", active);
            item.setAttribute("aria-selected", String(active));
          });
          this.shadow.querySelectorAll("[data-page]").forEach((page) => {
            const active = page.getAttribute("data-page") === tab.dataset.tab;
            page.hidden = !active;
            page.classList.toggle("is-active", active);
          });
          this.q(".zg-pane").scrollTop = 0;
          return;
        }
        const segButton = target.closest(".zg-seg button");
        if (segButton) {
          const seg = segButton.parentElement;
          seg.querySelectorAll("button").forEach((item) => {
            item.setAttribute("aria-pressed", String(item === segButton));
          });
          const select = seg.dataset.seg === "thinking"
            ? this.shadow.querySelector('[data-field="pipeline.thinkingMode"]')
            : seg.dataset.seg === "detail"
              ? this.shadow.querySelector('[data-field="image.detail"]')
              : null;
          if (select) select.value = segButton.dataset.value;
          return;
        }
        const test = target.closest("[data-test]");
        if (test) {
          void this.test(test.dataset.test);
          return;
        }
        const action = target.closest("[data-act]")?.dataset.act;
        if (action === "toggle-key") {
          const input = this.shadow.querySelector('[data-field="pipeline.vlm.apiKey"]');
          if (input) {
            const show = input.type === "password";
            input.type = show ? "text" : "password";
            target.textContent = show ? "\u9690\u85CF" : "\u663E\u793A";
          }
          return;
        }
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
        if (action === "rubric-save") {
          this.callbacks.onRubricSave?.(this.readContextDraft());
          return;
        }
        if (action === "rubric-load") {
          this.callbacks.onRubricLoad?.();
          // 载入后立刻用落盘的配置重填表单，否则界面上还是旧内容，看起来像没生效。
          this.show(loadConfig());
          return;
        }
        if (action === "rubric-clear") {
          this.callbacks.onRubricClear?.();
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
          if (thumbs) thumbs.textContent = "";
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
        if (action === "close" || action === "cancel") {
          if (this.confirmDiscard()) this.hide();
        }
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
        else if (target.dataset.gen === "type") this.refreshRuleHint();
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
    // 分段控件只是显示层，真正的值仍写在隐藏的 select 里，getDraft / show / applyPlatform 不必改。
    syncSegments() {
      [["thinking", '[data-field="pipeline.thinkingMode"]'], ["detail", '[data-field="image.detail"]']].forEach(([name, selector]) => {
        const select = this.shadow.querySelector(selector);
        const seg = this.shadow.querySelector(`[data-seg="${name}"]`);
        if (!select || !seg) return;
        seg.querySelectorAll("button").forEach((button) => {
          button.setAttribute("aria-pressed", String(button.dataset.value === select.value));
        });
      });
    }
    // 思考只保留两档，历史配置里的 low/high/max 在回填时收敛为「模型默认」。
    clampThinkingSelect() {
      const element = this.shadow.querySelector('[data-field="pipeline.thinkingMode"]');
      if (element instanceof HTMLSelectElement) {
        element.value = clampThinkingLevel("", element.value);
        this.syncSegments();
      }
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
      this.shadow.querySelectorAll("[data-platform-select]").forEach((element) => {
        const current = getPath(this.config, element.dataset.field || "") || element.value;
        // 用 DOM 构造 option：预设名可能来自用户，拼进 innerHTML 会有注入风险。
        const fragment = document.createDocumentFragment();
        for (const preset of presets) {
          const option = document.createElement("option");
          option.value = preset.id;
          option.textContent = preset.label;
          fragment.appendChild(option);
        }
        element.replaceChildren(fragment);
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
      this.syncSegments();
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
        thinkingModes: loadPlatformThinkingModes(),
        rubrics: loadRubricLibrary()
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
        status.className = `zg-status${state ? ` ${state}` : ""}`;
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
      const previous = typeSelect.value;
      typeSelect.innerHTML = types.map((type) => `<option value="${type}">${type}</option>`).join("");
      if (types.includes(previous)) typeSelect.value = previous;
      this.refreshRuleHint();
    }
    // 题型到底影响什么：直接显示生成时用的评分方式与判分口径，别让人以为它只是摆设。
    refreshRuleHint() {
      const subjectSelect = this.shadow.querySelector('[data-gen="subject"]');
      const typeSelect = this.shadow.querySelector('[data-gen="type"]');
      const hint = this.shadow.querySelector('[data-gen="rule-hint"]');
      if (!subjectSelect || !typeSelect || !hint) return;
      const summary = typeof rubricRuleSummary === "function" ? rubricRuleSummary(subjectSelect.value, typeSelect.value) : "";
      hint.textContent = summary ? `\u751F\u6210\u53E3\u5F84\uFF1A${summary}` : "";
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
        status.className = `zg-status${state ? ` ${state}` : ""}`;
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
        status.className = `zg-status${state ? ` ${state}` : ""}`;
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
        status.className = `zg-status${state ? ` ${state}` : ""}`;
      };
      setStatus("\u6D4B\u8BD5\u4E2D\u2026");
      if (button) button.disabled = true;
      this.toast("\u6B63\u5728\u6D4B\u8BD5\u8FDE\u63A5\u2026");
      try {
        const ok = await this.callbacks.onTest(draft);
        const message = ok ? "\u56FE\u7247\u8BFB\u53D6\u6B63\u5E38" : "\u8FDE\u63A5\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u914D\u7F6E";
        setStatus(message, ok ? "ok" : "bad");
        this.toast(message);
      } catch (error) {
        const message = error instanceof Error ? error.message : "\u8FDE\u63A5\u5931\u8D25";
        const providerMessage = error?.providerMessage ? String(error.providerMessage) : "";
        const detail = error?.configSummary ? ` | \u5B9E\u9645\u914D\u7F6E: ${error.configSummary}` : "";
        setStatus(message + detail, "bad");
        this.toast(providerMessage ? providerMessage.slice(0, 120) : message.slice(0, 120));
      } finally {
        if (button) button.disabled = false;
      }
    }
    // 只取「批改上下文」这一块（题目/答案/标准/满分/学科），给标准库存取用。
    readContextDraft() {
      return this.getDraft().context;
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
    // 题目/答案/评分标准只有点「保存配置」或「保存本题标准」才会落盘；
    // 直接关窗口时提醒一次，避免整段标准白填。
    confirmDiscard() {
      try {
        const draft = this.getDraft();
        const saved = loadConfig();
        if (sameRubricContext(draft.context, saved.context)) return true;
        return window.confirm("\u6279\u6539\u4E0A\u4E0B\u6587\uFF08\u9898\u76EE / \u53C2\u8003\u7B54\u6848 / \u8BC4\u5206\u6807\u51C6\uFF09\u6709\u672A\u4FDD\u5B58\u7684\u4FEE\u6539\uFF0C\u786E\u5B9A\u5173\u95ED\uFF1F");
      } catch {
        return true;
      }
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
      this.syncSegments();
      const keyElement = this.shadow.querySelector('[data-field="pipeline.vlm.apiKey"]');
      // 钥匙默认遮住：只在本次打开期间允许「显示」，重新打开时回到密码态。
      if (keyElement instanceof HTMLInputElement) keyElement.type = "password";
      const reveal = this.shadow.querySelector('[data-act="toggle-key"]');
      if (reveal) reveal.textContent = "\u663E\u793A";
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
    // 从历史定位过来后重新批改：结果写回原条目，避免待复核队列一直指着旧分数打转。
    let regradeTargetId = "";
    let busy = false;
    // 提交互斥与冷却：连续批阅与手动点击可能同时触发提交，必须串行化。
    let submitting = false;
    let lastSubmitAt = 0;
    const SUBMIT_COOLDOWN = 1500;
    const forcedNotified = new Set();
    // 每个「平台 + 地址 + 模型」只做一次读图校验，避免每次批改都多花一次请求。
    const visionVerified = new Set();
    let autoMode = false;
    let autoStopRequested = false;
    // 复核队列：从「下一条需复核」进入后，提交完自动标记并跳到下一条待复核的卷子。
    let reviewQueueActive = false;
    let observer = null;
    let observerTimer = 0;
    let watchTimer = 0;
    // 阅卷 iframe 被路由整段换掉时，旧 doc 已不在文档里，需要重新 detect 而不是继续观察它。
    let redetecting = false;
    // 容器页是 SPA：阅卷页往往在点「阅卷」之后才在 iframe 里加载，没找到时按 1.5 秒轮询。
    let detectTimer = 0;
    let detecting = false;
    const panel = new GraderPanel({
      onGrade: () => {
        void runGrade2();
      },
      onContinuous: () => {
        void toggleContinuous();
      },
      onContinuousLimitChange: (value) => {
        config = { ...config, continuousLimit: value };
        saveConfig(config);
        panel.toast(`\u8FDE\u7EED\u6279\u9605\u4E0A\u9650\u5DF2\u8BBE\u4E3A ${value} \u4EFD`);
      },
      onOutputModeChange: (value) => {
        config = { ...config, pipeline: { ...config.pipeline, outputMode: value } };
        saveConfig(config);
        // 档位进缓存键：换档位不会误命中旧结果。
        panel.toast(`\u8F93\u51FA\u6863\u4F4D\u5DF2\u8BBE\u4E3A ${OUTPUT_MODE_SHORT[value] || value}`);
      },
      onSubmit: (skipConfirm) => {
        void submitResult({ skipConfirm });
      },
      onHistory: () => historyPanel.show(loadHistory()),
      onSettings: () => settingsPanel.show(config)
    });
    panel.setContinuousLimit(config.continuousLimit);
    panel.setOutputMode(config.pipeline.outputMode);
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
        panel.setContinuousLimit(config.continuousLimit);
        panel.setOutputMode(config.pipeline.outputMode);
        panel.setCache(pipelineLabel(config));
        // 保存配置时顺手把这套标准存进「本题」槽位，下次切回来直接可用。
        const slot = rubricSlotKey(currentQuestion);
        if (slot) putRubricPreset(slot, config.context);
        panel.setSubtitle("\u914D\u7F6E\u5DF2\u66F4\u65B0");
      },
      // 标准库的增删都用「当前题号」定位，避免把 A 题的标准存到 B 题上。
      onRubricSave: (context) => {
        const slot = rubricSlotKey(currentQuestion);
        if (!slot) {
          panel.toast("\u5C1A\u672A\u8BFB\u53D6\u5230\u9898\u53F7\uFF0C\u65E0\u6CD5\u5B58\u5165\u6807\u51C6\u5E93");
          return;
        }
        if (!rubricHasContent(context)) {
          panel.toast("\u53C2\u8003\u7B54\u6848\u4E0E\u8BC4\u5206\u6807\u51C6\u90FD\u662F\u7A7A\u7684\uFF0C\u6CA1\u5FC5\u8981\u5B58");
          return;
        }
        config = { ...config, context: rubricContextFields(context) };
        saveConfig(config);
        putRubricPreset(slot, config.context);
        panel.toast(`\u5DF2\u5B58\u5165\u6807\u51C6\u5E93\uFF1A\u9898\u53F7 ${rubricSlotLabel(currentQuestion)}`);
      },
      onRubricLoad: () => {
        const slot = rubricSlotKey(currentQuestion);
        const preset = getRubricPreset(slot);
        if (!preset) {
          panel.toast(`\u9898\u53F7 ${rubricSlotLabel(currentQuestion) || "\u672C\u9898"} \u8FD8\u6CA1\u5B58\u8FC7\u6807\u51C6`);
          return;
        }
        config = { ...config, context: rubricContextFields(preset) };
        saveConfig(config);
        panel.toast(`\u5DF2\u8F7D\u5165\u9898\u53F7 ${rubricSlotLabel(currentQuestion)} \u7684\u6807\u51C6`);
      },
      onRubricClear: () => {
        const slot = rubricSlotKey(currentQuestion);
        const removed = removeRubricPreset(slot);
        panel.toast(removed ? `\u5DF2\u6E05\u7A7A\u9898\u53F7 ${rubricSlotLabel(currentQuestion)} \u7684\u6807\u51C6` : "\u672C\u9898\u8FD8\u6CA1\u5B58\u8FC7\u6807\u51C6");
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
        if (isRecord(data.keys)) savePlatformKeys(data.keys);
        if (isRecord(data.models)) savePlatformModels(data.models);
        if (isRecord(data.thinkingModes)) savePlatformThinkingModes(data.thinkingModes);
        // 评分标准库只补不覆盖：导入配置不该抹掉本机已有的其它题目标准。
        if (isRecord(data.rubrics)) {
          const local = loadRubricLibrary();
          for (const [key, value] of Object.entries(data.rubrics)) {
            if (isRecord(value)) local[key] = value;
          }
          saveRubricLibrary(local);
        }
        syncKeysFromConfig(config);
        syncModelsFromConfig(config);
        syncThinkingModesFromConfig(config);
        cache = createCache();
        limiter = buildLimiter(config);
        panel.setContinuousLimit(config.continuousLimit);
        panel.setOutputMode(config.pipeline.outputMode);
        panel.setCache(pipelineLabel(config));
        panel.setSubtitle("\u914D\u7F6E\u5DF2\u5BFC\u5165");
      },
      onReset: () => {
        resetConfig();
        config = loadConfig();
        cache = createCache();
        limiter = buildLimiter(config);
        panel.setContinuousLimit(config.continuousLimit);
        panel.setOutputMode(config.pipeline.outputMode);
        settingsPanel.show(config);
      },
      onClear: () => {
        clearAllData();
        cache.clear();
        config = loadConfig();
        limiter = buildLimiter(config);
        panel.setContinuousLimit(config.continuousLimit);
        panel.setOutputMode(config.pipeline.outputMode);
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
      },
      // 复核留痕写回历史：备注、确认分、复核时间都只在本地。
      onReview: (id, patch) => {
        const history = loadHistory().map((entry) => entry.id === id ? { ...entry, ...patch } : entry);
        writeJson(STORAGE_KEYS.history, history);
        historyPanel.refresh(history);
        panel.toast("\u590D\u6838\u4FE1\u606F\u5DF2\u4FDD\u5B58");
      },
      // 点历史记录直接回到阅卷页对应那份卷子（复用平台的阅卷记录链路）。
      onJump: (entry, fromQueue) => {
        // 手动定位要退出队列模式，免得下一次提交被自动带去别的卷子。
        if (!fromQueue) reviewQueueActive = false;
        void jumpToHistory(entry, { fromQueue: Boolean(fromQueue) });
      },
      onEmptyQueue: () => panel.toast("\u6CA1\u6709\u5F85\u590D\u6838\u7684\u8BB0\u5F55")
    });
    panel.mount();
    // 观察器拿到新卷后立刻刷新题号与进度：页面 DOM 常比接口先就绪，只靠 MutationObserver 会漏。
    onHookUpdate(() => {
      if (!markingDoc) return;
      applyQuestion(readQuestion(markingDoc));
      updateProgress();
    });
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
    // 首次用某个模型批改前先做一次读图校验。文本模型在这一步就会被挡住，
    // 既不会写出一条 0 分历史，也不会让连续批阅一路批下去。
    async function ensureVisionSupport() {
      const service = config.pipeline.vlm;
      const key = `${service.platform}|${service.endpoint}|${service.model}`;
      if (visionVerified.has(key)) return;
      panel.setStage("校验图片读取能力", service.model);
      await testConnection(service, limiter);
      visionVerified.add(key);
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
        await ensureVisionSupport();
        panel.setStage("\u7B49\u5F85\u4F5C\u7B54\u56FE\u7247\u7A33\u5B9A");
        let images = await gatherAnswerImages();
        if (images.length === 0) {
          // DOM 一直不稳或链接已过期时，用接口观察到的新鲜地址兜底。
          images = freshAnswerImages();
        }
        if (images.length === 0) throw new Error("\u4F5C\u7B54\u56FE\u7247\u5C1A\u672A\u7A33\u5B9A\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
        // 身份只取台账号与题号：跨账号一致，且不含会过期的签名。
        const observedIdentity = currentHookIdentity();
        // 学号与试卷 ID 是「历史记录定位」的钥匙：记录列表只认学号，接口只认试卷 ID。
        const identity = observedIdentity && observedIdentity.scanRecordId
          ? {
            scanRecordId: observedIdentity.scanRecordId,
            topicNumStr: observedIdentity.topicNumStr || "",
            userCode: observedIdentity.userCode || "",
            markingPaperId: observedIdentity.markingPaperId || ""
          }
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
        // 从历史定位过来重批时更新原条目，普通批改才新增：否则复核队列会一直指着旧分数打转。
        const regradeTarget = regradeTargetId && loadHistory().find((entry) => entry.id === regradeTargetId);
        const historyEntry = {
          id: regradeTarget?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          createdAt: regradeTarget?.createdAt || Date.now(),
          question: historyQuestion(currentQuestion),
          result,
          submitted: false
        };
        lastHistoryId = historyEntry.id;
        if (regradeTarget) {
          const history = loadHistory().map((entry) => entry.id === regradeTarget.id
            ? {
              ...entry,
              ...historyEntry,
              // 新结果要重新复核：清掉上一轮的复核留痕，但保留用户填过的确认分。
              reviewedAt: void 0,
              reviewNote: void 0
            }
            : entry);
          writeJson(STORAGE_KEYS.history, history);
          historyPanel.refresh(history);
        } else {
          appendHistory(historyEntry, config.historyLimit);
          historyPanel.refresh(loadHistory());
        }
        if (!identity) {
          const gradedKeys = (currentQuestion.images || []).map(stableImageKey).join("|");
          void backfillIdentity(lastHistoryId, gradedKeys);
        }
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
    // 观察器晚于首份卷加载时（刷新后立刻批改、脚本刚注入），identity 是空的；
    // 等接口数据到了再回填，否则这条历史永远点不了「定位」。
    async function backfillIdentity(historyId, imageKeys) {
      const deadline = Date.now() + 8e3;
      while (Date.now() < deadline) {
        const observed = currentHookIdentity();
        if (observed && observed.scanRecordId) {
          // 卷子已经换了就别回填，否则会把上一位学生的身份贴到这条记录上。
          const nowKeys = (currentQuestion?.images || []).map(stableImageKey).join("|");
          if (nowKeys !== imageKeys) return;
          const history = loadHistory().map((entry) => entry.id === historyId
            ? {
              ...entry,
              question: {
                ...entry.question,
                // 顺带把题号修正成接口口径（DOM 的 "43(1)" 查记录列表查不到），
                // 只改「原本就是 DOM 口径」的那种，接口口径原样保留。
                topicNumStr: observed.topicNumStr || entry.question.topicNumStr,
                identity: {
                  scanRecordId: observed.scanRecordId,
                  topicNumStr: observed.topicNumStr || "",
                  userCode: observed.userCode || "",
                  markingPaperId: observed.markingPaperId || ""
                }
              }
            }
            : entry);
          writeJson(STORAGE_KEYS.history, history);
          historyPanel.refresh(history);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 300));
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
      // 两种失败原因分开说：「没进阅卷页」和「还没批改」是两件事。
      if (!markingDoc) {
        panel.showError("\u672A\u68C0\u6D4B\u5230\u9605\u5377\u63A7\u4EF6\uFF0C\u8BF7\u5148\u6253\u5F00\u9605\u5377\u9875");
        return { ok: false, oldIdentity: null };
      }
      if (!lastResult) {
        panel.showError("\u8FD8\u6CA1\u6709\u6279\u6539\u7ED3\u679C\uFF0C\u8BF7\u5148\u70B9\u300C\u5F00\u59CB\u6279\u6539\u300D");
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
        // 提交要等回执、最多几秒，这期间页面可能已经换卷，applyQuestion 会把 lastResult 清空。
        // 先用局部变量抓住这份结果，后面写历史、回缓存都只认它。
        const submittedResult = lastResult;
        const inputs = getScoreInputs(markingDoc);
        // 打分框比小题分多时，硬填只会把第一个框写上、后面留空，必须拦住说清楚。
        if (inputs.length > 1 && submittedResult.subScores.length !== inputs.length) {
          panel.showError(`小题分未回全（${submittedResult.subScores.length}/${inputs.length}），请先补齐再提交`);
          return { ok: false, oldIdentity: null };
        }
        const scores = inputs.length > 1 ? submittedResult.subScores.map((item) => item.score) : [Math.round(submittedResult.score * 10) / 10];
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
        // 回执丢了不代表没提交：再看一眼卷子有没有真的换，避免误报失败后老师重复提交。
        const changed = observed && !signal ? await waitPaperChanged(oldIdentity, oldScan, 3e3) : false;
        const verdict = judgeSubmit(observed, signal, changed);
        if (!verdict.ok) {
          panel.showError(verdict.reason);
          return { ok: false, oldIdentity };
        }
        // 提交即人工确认：需复核的条目顺手标记已复核，复核队列不会越积越长。
        const history = loadHistory().map((entry) => {
          if (entry.id !== lastHistoryId) return entry;
          const patch = { ...entry, result: submittedResult, submitted: true, submitConfirmed: verdict.confirmed };
          if (submittedResult?.needsReview && !entry.reviewedAt) {
            patch.reviewedAt = Date.now();
            patch.reviewNote = entry.reviewNote || "\u63D0\u4EA4\u65F6\u81EA\u52A8\u6807\u8BB0";
          }
          return patch;
        });
        writeJson(STORAGE_KEYS.history, history);
        historyPanel.refresh(history);
        // 顺手把「阅卷记录」里的记录 id 解析出来存进历史：下次点定位不用再翻列表。
        const submittedHistoryId = lastHistoryId;
        // 题号/试卷 ID 以刚写进历史的那条为准：此刻 currentQuestion 可能已经换成下一份了。
        const submittedEntry = loadHistory().find((entry) => entry.id === submittedHistoryId);
        const submittedIdentity = submittedEntry?.question?.identity || null;
        if (submittedHistoryId) {
          const fallbackIdentity = submittedIdentity || {
            scanRecordId: "",
            topicNumStr: submittedEntry?.question?.topicNumStr || "",
            userCode: "",
            markingPaperId: hookCurrentField("markingPaperId") || ""
          };
          void resolveMarkedRecordId(markingDoc, fallbackIdentity, submittedResult?.score).then((record) => {
            if (!record || !record.id) return;
            const patched = loadHistory().map((entry) => {
              if (entry.id !== submittedHistoryId) return entry;
              const identity = entry.question.identity || { scanRecordId: "", topicNumStr: "", userCode: "", markingPaperId: "" };
              return {
                ...entry,
                question: {
                  ...entry.question,
                  recordId: record.id,
                  // 学号是定位的钥匙：观察器漏了首份卷时靠这里补上。
                  identity: {
                    ...identity,
                    userCode: identity.userCode || record.userCode,
                    markingPaperId: identity.markingPaperId || fallbackIdentity.markingPaperId,
                    // 身份里的题号统一存接口口径（43,1），DOM 口径留着只用于显示
                    topicNumStr: identity.topicNumStr || jumpApiTopicNum(fallbackIdentity.topicNumStr)
                  }
                }
              };
            });
            writeJson(STORAGE_KEYS.history, patched);
            historyPanel.refresh(patched);
          }).catch(() => { /* 解析失败不影响提交结果 */ });
        }
        // 把人工改过的分数回写缓存：双评换第二个账号时命中缓存拿到的是最终分，而不是模型原始分。
        if (cache && submittedResult?.cacheKey) cache.set(submittedResult.cacheKey, submittedResult);
        lastResult = null;
        // 这份已提交，重批归属到此结束；下一份若来自队列，jumpToHistory 会重新设置。
        regradeTargetId = "";
        updateProgress();
        panel.setSubtitle(options.silent ? "\u8FDE\u7EED\u6279\u9605\u4E2D" : "\u5DF2\u63D0\u4EA4\uFF0C\u7B49\u5F85\u4E0B\u4E00\u4EFD");
        if (options.silent) {
          panel.setStage("\u5DF2\u63D0\u4EA4\uFF0C\u7B49\u5F85\u6362\u5377");
        } else {
          panel.toast(
            verdict.confirmed
              ? "\u5DF2\u63D0\u4EA4\uFF08\u5E73\u53F0\u5DF2\u786E\u8BA4\uFF09"
              : verdict.inferred
                ? "\u5DF2\u63D0\u4EA4\uFF08\u672A\u62FF\u5230\u56DE\u6267\uFF0C\u4F46\u9875\u9762\u5DF2\u6362\u5377\uFF09"
                : "\u5DF2\u63D0\u4EA4"
          );
          void waitForNextPaper(oldIdentity, oldScan).then((changed) => {
            if (changed) void detect();
            else panel.setSubtitle("\u672A\u68C0\u6D4B\u5230\u6362\u5377\uFF0C\u53EF\u7EE7\u7EED\u4EBA\u5DE5\u64CD\u4F5C");
          });
        }
        // 复核队列模式下，这一份已经提交（需复核的条目会被自动标记已复核），直接推进下一条。
        if (!options.silent && reviewQueueActive) scheduleReviewAdvance();
        return { ok: true, oldIdentity, oldScan };
      } finally {
        submitting = false;
      }
    }
    // 历史记录定位：切题号 → 学号换记录 id → 调页面自己的回评方法 → 重新读题号与满分。
    async function jumpToHistory(entry, options = {}) {
      if (autoMode) {
        panel.toast("\u8FDE\u7EED\u6279\u9605\u4E2D\u4E0D\u80FD\u5B9A\u4F4D\uFF0C\u8BF7\u5148\u505C\u6B62");
        return;
      }
      if (busy || submitting) {
        panel.toast("\u6B63\u5728\u5904\u7406\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5");
        return;
      }
      const doc = markingDoc || await waitForMarkingDocument(6e3);
      if (!doc) {
        panel.showError("\u672A\u68C0\u6D4B\u5230\u9605\u5377\u63A7\u4EF6\uFF0C\u8BF7\u5148\u6253\u5F00\u9605\u5377\u9875");
        return;
      }
      markingDoc = doc;
      ensureZhixueHook(doc);
      // 跳转前先记下当前打分框的值，跳完要等它换成目标卷的分数再对账。
      const scoresBefore = readFilledScores(doc);
      busy = true;
      panel.setBusy(true);
      panel.clearError();
      panel.setStage("\u5B9A\u4F4D\u5386\u53F2\u8BB0\u5F55");
      try {
        const result = await jumpToMarkedRecord(entry, {
          doc,
          onPage: (page, total) => panel.setStage("\u5B9A\u4F4D\u5386\u53F2\u8BB0\u5F55", `\u7FFB\u8BB0\u5F55 ${page}/${total} \u9875`)
        });
        if (!result.ok) {
          panel.showError(result.error);
          // 定位失败就退出队列模式，避免下一次提交被带去别的卷子。
          reviewQueueActive = false;
          regradeTargetId = "";
          return;
        }
        // 没换卷时只有「当前学号就是目标学号」才算定位成功：否则队列会把眼前这份卷写到别人的历史记录上。
        const expectedUser = String(entry?.question?.identity?.userCode || "").trim();
        const observedUser = String(currentHookIdentity()?.userCode || (answerSnapshot(doc)?.identity || {}).userCode || "").trim();
        if (!result.changed && (!expectedUser || observedUser !== expectedUser)) {
          panel.showError("\u56DE\u8BC4\u540E\u6CA1\u770B\u5230\u76EE\u6807\u5377\uFF0C\u5DF2\u505C\u6B62\u5B9A\u4F4D\uFF1B\u8BF7\u4EBA\u5DE5\u786E\u8BA4\u5F53\u524D\u5377\u540E\u91CD\u8BD5");
          reviewQueueActive = false;
          regradeTargetId = "";
          return;
        }
        if (!result.changed) panel.toast("\u5DF2\u53D1\u9001\u56DE\u8BC4\uFF0C\u4F46\u6CA1\u770B\u5230\u6362\u5377\uFF0C\u8BF7\u4EBA\u5DE5\u786E\u8BA4");
        // 定位成功后才进入队列模式：失败时不能让下一次提交被带去别的卷子。
        if (options.fromQueue) reviewQueueActive = true;
        // 换卷后旧结果必须作废：面板上留着上一份的分数会诱导提交到这份卷上。
        lastResult = null;
        currentQuestion = null;
        panel.clearResult();
        if (result.record?.id && entry?.id) {
          const patched = loadHistory().map((item) => item.id === entry.id
            ? { ...item, question: { ...item.question, recordId: result.record.id } }
            : item);
          writeJson(STORAGE_KEYS.history, patched);
          historyPanel.refresh(patched);
        }
        applyQuestion(readQuestion(doc));
        // 记录这次批改归属：后面「开始批改」要覆盖这条，而不是再插一条重复历史。
        regradeTargetId = entry?.id || "";
        updateProgress();
        // 平台回填的是「这条记录当时的分数」，和本地历史对不上说明中途有人改过分。
        // 顺带用它给一句明确的定位反馈：换卷后副标题会被观察器改回「已读取题号」。
        const filled = await waitScoresSettled(doc, scoresBefore, 1500);
        const actual = filled.length > 1 ? filled.reduce((sum, value) => sum + value, 0) : filled[0];
        const expected = Number(entry?.result?.score);
        const mismatch = Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) > 0.05;
        panel.toast(
          mismatch
            ? `\u8BE5\u5377\u5F53\u524D ${actual} \u5206\uFF0C\u5386\u53F2\u8BB0\u5F55\u662F ${expected} \u5206\uFF0C\u53EF\u80FD\u5DF2\u88AB\u4ED6\u4EBA\u6539\u5206`
            : `\u5DF2\u5B9A\u4F4D\u5230\u5B66\u53F7 ${result.userCode}${Number.isFinite(actual) ? `\uFF0C\u5F53\u524D ${actual} \u5206` : ""}`
        );
        historyPanel.hide();
        panel.setSubtitle(`\u5DF2\u5B9A\u4F4D\u5230\u5B66\u53F7 ${result.userCode}`);
        if (reviewQueueActive) {
          const remain = pendingReviewEntries().length;
          panel.setSubtitle(`\u590D\u6838\u961F\u5217 \xB7 \u5269\u4F59 ${remain} \u6761`);
        }
      } catch (error) {
        panel.showError(error instanceof Error ? error.message : "\u5B9A\u4F4D\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u5728\u9605\u5377\u8BB0\u5F55\u91CC\u627E\u8FD9\u4E00\u4EFD");
        reviewQueueActive = false;
        regradeTargetId = "";
      } finally {
        busy = false;
        panel.setBusy(false);
      }
    }
    // 队列里还剩哪些：需复核 + 未标记已复核 + 能定位。
    function pendingReviewEntries() {
      return loadHistory().filter((entry) => entry.result?.needsReview && !entry.reviewedAt && canJumpRecord(entry));
    }
    // 提交成功后自动跳下一条，把「复核」做成一路走到底的流程；队列空了就收尾。
    function scheduleReviewAdvance() {
      window.setTimeout(() => {
        void advanceReviewQueue();
      }, 900);
    }
    async function advanceReviewQueue() {
      if (!reviewQueueActive || autoMode) return;
      const pending = pendingReviewEntries();
      if (pending.length === 0) {
        reviewQueueActive = false;
        panel.toast("\u590D\u6838\u961F\u5217\u5DF2\u5B8C\u6210");
        panel.setSubtitle("\u590D\u6838\u961F\u5217\u5DF2\u5B8C\u6210");
        return;
      }
      await jumpToHistory(pending[0], { fromQueue: true });
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
      // 份数上限：无人看管时也不会一路跑到没配额。
      const limit = Math.max(1, Math.min(CONTINUOUS_LIMIT_MAX, Number(config.continuousLimit) || 20));
      while (autoMode && !autoStopRequested) {
        if (count >= limit) {
          panel.setSubtitle(`\u5DF2\u8FBE\u8FDE\u7EED\u6279\u9605\u4E0A\u9650 ${limit} \u4EFD\uFF0C\u5DF2\u505C\u6B62`);
          panel.toast(`\u5DF2\u8FBE\u5230 ${limit} \u4EFD\u4E0A\u9650`);
          break;
        }
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
    async function detect(waitMs) {
      if (detecting) return;
      detecting = true;
      window.clearTimeout(detectTimer);
      try {
        if (!isZhixueHost()) {
          panel.setSubtitle("\u5F53\u524D\u975E\u9605\u5377\u9875\u9762");
          return;
        }
        const doc = await waitForMarkingDocument(waitMs === void 0 ? 1e4 : waitMs);
        if (!doc) {
          panel.setSubtitle("\u672A\u68C0\u6D4B\u5230\u9605\u5377\u63A7\u4EF6");
          // 智学网是「容器 + iframe」的 SPA：启动时 iframe 还停在试卷列表，
          // 点「阅卷」后同一个 iframe 才导航到阅卷页。只探测一次会永远错过，
          // 这里退到 1.5 秒一轮的轻量轮询，找到阅卷页后自动停止。
          detectTimer = window.setTimeout(() => {
            void detect(0).catch(() => {});
          }, 1500);
          return;
        }
        markingDoc = doc;
        // 每次拿到阅卷文档都校验一次：平台路由切换会换掉 iframe，旧 hook 随之失效。
        ensureZhixueHook(doc);
        applyQuestion(readQuestion(doc));
        updateProgress();
        watchDocument(doc);
      } finally {
        detecting = false;
      }
    }
    // 判「还是同一份卷」：题号 + 作答图（去签名）+ 接口身份三者都对得上才算没换。
    // 刚换卷时观察器比 DOM 慢，scanRecordId 可能一边为空——这时不能据此判换卷，
    // 否则老师刚批完就被清空结果，点提交只会得到「请先完成批改」。
    function samePaper(a, b) {
      if (!a || !b) return false;
      // 题号口径会从 DOM 的 43(1) 变成接口的 43,1，归一后再比，别把同一道题判成换卷。
      const topicOf = (value) => (typeof rubricTopicKey === "function" ? rubricTopicKey(value) : String(value || ""));
      if (topicOf(a.questionId) !== topicOf(b.questionId)) return false;
      if ((a.images || []).length !== (b.images || []).length) return false;
      if (a.scanRecordId && b.scanRecordId && a.scanRecordId !== b.scanRecordId) return false;
      const key = (url) => resourceKey(url) || url;
      const left = (a.images || []).map(key).sort().join("|");
      const right = (b.images || []).map(key).sort().join("|");
      return left === right;
    }
    function applyQuestion(question) {
      if (!question) return;
      if (samePaper(currentQuestion, question)) return;
      // 自然换卷后不再属于刚才定位的历史条目，重批目标随之失效。
      regradeTargetId = "";
      const previousSlot = rubricSlotKey(currentQuestion);
      currentQuestion = question;
      lastResult = null;
      panel.setQuestion(question);
      panel.setSubtitle(`\u5DF2\u8BFB\u53D6\u9898\u53F7 ${question.questionId}`);
      panel.clearError();
      syncRubricForQuestion(previousSlot, question);
    }
    // 切题时把上一题的标准存回它的槽位，再载入新题号已存的那份。
    // 新题号没存过就清空答案/标准（上一题已自动保存）：拿错答案键批改比多填一次危险得多。
    function syncRubricForQuestion(previousSlot, question) {
      const nextSlot = rubricSlotKey(question);
      const switched = Boolean(previousSlot) && previousSlot !== nextSlot;
      const saved = switched ? putRubricPreset(previousSlot, config.context) : false;
      if (!nextSlot) return;
      const preset = getRubricPreset(nextSlot);
      if (preset && rubricHasContent(preset)) {
        if (sameRubricContext(config.context, preset)) return;
        config = { ...config, context: rubricContextFields(preset) };
        saveConfig(config);
        panel.toast(`\u5DF2\u8F7D\u5165\u9898\u53F7 ${rubricSlotLabel(question)} \u7684\u8BC4\u5206\u6807\u51C6`);
        return;
      }
      if (!switched || !saved || !rubricHasContent(config.context)) return;
      config = { ...config, context: { ...config.context, question: "", answer: "", rubric: "", maxScore: 0 } };
      saveConfig(config);
      panel.toast(`\u9898\u53F7 ${rubricSlotLabel(question)} \u8FD8\u6CA1\u5B58\u8FC7\u6807\u51C6\uFF0C\u4E0A\u4E00\u9898\u7684\u5DF2\u81EA\u52A8\u4FDD\u5B58`);
    }
    // 进度条：页面文本「初评已阅量/任务量」优先，接口计数兜底。
    function updateProgress() {
      const progress = readProgress(markingDoc);
      panel.setProgress(progress ? `\u5DF2\u6279 ${progress.marked} / \u4EFB\u52A1 ${progress.todo}` : "");
    }
    // 只盯题号/作答图/进度这几个容器：监听整个 body 会让「阅卷记录」这种大列表
    // 每敲一个字、每翻一页都触发一次全量快照。节点被路由整段替换时靠 2 秒复检重新挂。
    function watchDocument(doc) {
      observer?.disconnect();
      window.clearTimeout(observerTimer);
      window.clearInterval(watchTimer);
      // doc 可能是 iframe 文档，也可能是 wujie 的 shadow root（没有 body）。
      const scope = doc.body || doc;
      if (!scope) return;
      const refresh = () => {
        applyQuestion(readQuestion(doc));
        updateProgress();
      };
      const schedule = () => {
        window.clearTimeout(observerTimer);
        observerTimer = window.setTimeout(refresh, 600);
      };
      const targets = () => Array.from(doc.querySelectorAll("#topicImgContent, #currentTopicIndex, #containter_topicTxt, .progress"));
      const quickKey = () => {
        const first = doc.querySelector('div[name="topicImg"] img');
        return `${doc.querySelector(SELECTORS.topicIndex)?.textContent?.trim() || ""}|${(first?.currentSrc || first?.src || "").slice(-80)}`;
      };
      let bound = [];
      let lastKey = quickKey();
      const bind = () => {
        const list = targets();
        const alive = list.length > 0 && list.every((node) => node.isConnected);
        if (alive && bound.length === list.length && bound.every((node, index) => node === list[index])) return;
        observer?.disconnect();
        bound = list.length > 0 ? list : [scope];
        observer = new MutationObserver(schedule);
        for (const node of bound) observer.observe(node, { childList: true, subtree: true, characterData: true });
      };
      bind();
      // 兜底：接口和 DOM 事件都没反应时，题号或首图变了也补一次刷新。
      watchTimer = window.setInterval(() => {
        // 首次打开时 iframe/微前端容器可能先给一个只有打分框的中间页，随后整段换掉。
        // 旧 doc 脱离页面后继续观察它永远等不到图，这里重新探测一次。
        if (!rootAlive(doc)) {
          if (!redetecting) {
            redetecting = true;
            void detect().finally(() => {
              redetecting = false;
            });
          }
          return;
        }
        bind();
        const key = quickKey();
        if (key === lastKey) return;
        lastKey = key;
        schedule();
      }, 2000);
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
