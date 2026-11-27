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

