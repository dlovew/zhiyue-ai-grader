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

