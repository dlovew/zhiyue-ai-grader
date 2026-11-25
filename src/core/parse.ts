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
  function extractScore(text, maxScore) {
    const labeled = text.match(/【得分】\s*([+\-]?\d+(?:\.\d+)?)/);
    if (labeled) return clamp(Number(labeled[1]), maxScore);
    const equations = [...text.matchAll(/=\s*([+\-]?\d+(?:\.\d+)?)/g)];
    if (equations.length > 0) {
      return clamp(Number(equations[equations.length - 1][1]), maxScore);
    }
    const numbers = [...text.matchAll(/[+\-]?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
    if (numbers.length === 0) return 0;
    return clamp(numbers[numbers.length - 1], maxScore);
  }
  // 兼容两种协议：紧凑版（i/sc/r）与旧版（label/score/maxScore/reason）。
  // 小题名称与满分由输入给出，模型不再回写，避免每份卷子白花几十个输出 token。
  function parseSubScores(value, maxScore, subQuestions = []) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      const record = asRecord(item);
      if (!record) return [];
      const index = Number(record.i ?? record.index);
      const base = Number.isInteger(index) && index >= 0 && index < subQuestions.length ? subQuestions[index] : null;
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
      const fallbackScore = subScores.reduce((sum, item) => sum + item.score, 0);
      const scoreValue = record.sc ?? record.score ?? fallbackScore;
      return {
        status: mapStatus(record.s ?? record.status),
        score: clamp(Number(scoreValue), maxScore),
        subScores,
        reason: String(record.r ?? record.reason ?? "").slice(0, 300),
        confidence: clamp(Number(record.c ?? record.confidence ?? 0.7), 1),
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
    return {
      status: statusMatch ? mapStatus(statusMatch[1]) : "legible",
      score: subScores.length > 0 ? subTotal : extractScore(raw, maxScore),
      subScores,
      reason: reasonMatch ? reasonMatch[1].trim().slice(0, 300) : "",
      confidence: 0.5,
      raw
    };
  }
  function parseGrade(raw, maxScore, subQuestions = []) {
    return fromJson(raw, maxScore, subQuestions) ?? fromText(raw, maxScore, subQuestions);
  }

