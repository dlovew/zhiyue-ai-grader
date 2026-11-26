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
