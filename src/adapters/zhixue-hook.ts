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
