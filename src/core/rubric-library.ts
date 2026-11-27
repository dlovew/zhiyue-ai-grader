  // src/core/rubric-library.ts
  // 评分标准库：按「试卷 + 题号」保存题目 / 参考答案 / 评分标准 / 满分 / 学科。
  // 切题时自动把当前这份存回旧槽、把新题号已存的那份载入，省掉每换一题重填一遍。
  var RUBRIC_LIBRARY_KEY = "zygr.rubrics.v1";
  var RUBRIC_LIBRARY_LIMIT = 300;

  // 槽位键：同一场考试的试卷 ID + 题号；没有试卷 ID 时退回只有题号（旧记录也能用）。
  // 题号统一成接口口径（43,1）：否则观察器晚到时会从 43(1) 变成 43,1，同一道题被当成两道。
  function rubricTopicKey(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    return typeof jumpApiTopicNum === "function" ? jumpApiTopicNum(text) : text;
  }
  function currentPaperId() {
    // 观察器拿到试卷 ID 后，即使 question.identity 还没补上，也用真实 ID 当槽位，
    // 否则同一份卷会先存进 "paper|43,1"、再存进 "<真实ID>|43,1"，切题时读不到自己刚存的标准。
    try {
      if (typeof hookCurrentField !== "function") return "";
      return String(hookCurrentField("markingPaperId") || "").trim();
    } catch {
      return "";
    }
  }
  function rubricSlotKey(question) {
    const identity = question?.identity || {};
    const paper = String(identity.markingPaperId || "").trim() || currentPaperId();
    const topic = rubricTopicKey(question?.topicNumStr || question?.questionId || "");
    if (!topic) return "";
    return `${paper || "paper"}|${topic}`;
  }
  // 老版本按 DOM 题号存过 "paper|43(1)"：读取时统一成接口口径，避免同一题两份标准。
  function normalizeRubricSlot(slot) {
    const text = String(slot || "").trim();
    if (!text) return "";
    const split = text.indexOf("|");
    if (split < 0) return rubricTopicKey(text);
    const storedPaper = text.slice(0, split).trim() || "paper";
    // 老记录可能在接口身份到位前按通用 paper 存；现在知道真实试卷 ID 就并过去。
    const paper = storedPaper === "paper" ? (currentPaperId() || storedPaper) : storedPaper;
    const topic = rubricTopicKey(text.slice(split + 1));
    return topic ? `${paper}|${topic}` : "";
  }
  function rubricSlotLabel(question) {
    return String(question?.topicNumStr || question?.questionId || "").trim();
  }
  function rubricContextSnapshot(context) {
    const source = isRecord(context) ? context : {};
    return {
      question: String(source.question || ""),
      answer: String(source.answer || ""),
      rubric: String(source.rubric || ""),
      maxScore: Number(source.maxScore) || 0,
      subject: String(source.subject || ""),
      updatedAt: Date.now()
    };
  }
  // 只取配置里存在的那五个字段，别把 updatedAt 之类的书签字段写回 config。
  function rubricContextFields(context) {
    const source = context || {};
    return {
      question: String(source.question || ""),
      answer: String(source.answer || ""),
      rubric: String(source.rubric || ""),
      maxScore: Number(source.maxScore) || 0,
      subject: String(source.subject || "")
    };
  }
  function rubricHasContent(snapshot) {
    const value = snapshot || {};
    return Boolean(String(value.answer || "").trim() || String(value.rubric || "").trim() || String(value.question || "").trim());
  }
  function sameRubricContext(a, b) {
    const left = a || {};
    const right = b || {};
    return String(left.question || "") === String(right.question || "")
      && String(left.answer || "") === String(right.answer || "")
      && String(left.rubric || "") === String(right.rubric || "")
      && (Number(left.maxScore) || 0) === (Number(right.maxScore) || 0)
      && String(left.subject || "") === String(right.subject || "");
  }
  function loadRubricLibrary() {
    const raw = readJson(RUBRIC_LIBRARY_KEY, {});
    if (!isRecord(raw)) return {};
    // 只在真有旧键/坏记录时回写一次，正常路径不产生额外存储写入。
    let migrated = false;
    const normalized = {};
    Object.keys(raw).forEach((slot) => {
      const key = normalizeRubricSlot(slot);
      const entry = raw[slot];
      if (key !== slot) migrated = true;
      if (!key || !isRecord(entry)) {
        migrated = true;
        return;
      }
      const previous = normalized[key];
      if (!previous || (Number(entry.updatedAt) || 0) > (Number(previous.updatedAt) || 0)) normalized[key] = entry;
    });
    if (migrated) saveRubricLibrary(normalized);
    return normalized;
  }
  function saveRubricLibrary(map) {
    return writeJson(RUBRIC_LIBRARY_KEY, map);
  }
  function getRubricPreset(slot) {
    const key = normalizeRubricSlot(slot);
    if (!key) return null;
    const library = loadRubricLibrary();
    if (isRecord(library[key])) return library[key];
    // 当前还没拿到试卷 ID 时键会退化成 "paper|43,2"；库里若只有一条同题号记录，
    // 说明就是同一场考试，直接复用，避免切回来时看起来「标准没了」。
    const split = key.indexOf("|");
    if (split < 0 || key.slice(0, split) !== "paper") return null;
    const topic = key.slice(split + 1);
    const matches = Object.keys(library).filter((item) => item.endsWith(`|${topic}`));
    return matches.length === 1 ? library[matches[0]] : null;
  }
  function putRubricPreset(slot, context) {
    const key = normalizeRubricSlot(slot);
    if (!key) return false;
    const snapshot = rubricContextSnapshot(context);
    if (!rubricHasContent(snapshot)) return false;
    const library = loadRubricLibrary();
    library[key] = snapshot;
    const keys = Object.keys(library);
    // 超量时按更新时间淘汰最旧的，避免本地存储无限膨胀。
    if (keys.length > RUBRIC_LIBRARY_LIMIT) {
      keys.sort((a, b) => (Number(library[a]?.updatedAt) || 0) - (Number(library[b]?.updatedAt) || 0));
      for (const key of keys.slice(0, keys.length - RUBRIC_LIBRARY_LIMIT)) delete library[key];
    }
    return saveRubricLibrary(library);
  }
  function removeRubricPreset(slot) {
    const key = normalizeRubricSlot(slot);
    if (!key) return false;
    const library = loadRubricLibrary();
    if (!Object.prototype.hasOwnProperty.call(library, key)) return false;
    delete library[key];
    return saveRubricLibrary(library);
  }
  function countRubricPresets() {
    return Object.keys(loadRubricLibrary()).length;
  }
