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
