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

