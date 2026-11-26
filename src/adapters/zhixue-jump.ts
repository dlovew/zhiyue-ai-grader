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
  const root = doc || getIframeDoc() || mainDoc();
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
  const root = doc || getIframeDoc() || mainDoc();
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
  const root = doc || getIframeDoc() || mainDoc();
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
  const doc = options.doc || getIframeDoc() || mainDoc();
  if (!doc) return { ok: false, error: "未检测到阅卷控件，请先打开阅卷页" };
  const win = doc.defaultView || null;
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
  const win = doc.defaultView || null;
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
