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

