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

