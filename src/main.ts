  // src/main.ts
  function buildLimiter(config) {
    return new RateLimiter({
      maxConcurrent: config.pipeline.maxConcurrent,
      maxRpm: config.pipeline.maxRpm,
      maxTpm: config.pipeline.maxTpm
    });
  }
  function pipelineLabel(config) {
    return "\u591A\u6A21\u6001\u76F4\u8BC4";
  }
  async function bootstrap() {
    let config = loadConfig();
    let cache = null;
    // 缓存条数上限可配（默认 2000）：双评大卷时同一份卷可能在很后面再次出现。
    const createCache = () => new CacheStore(config.cacheTtlDays, config.cacheMaxEntries, {
      onStorageError: () => panel.toast("\u5B58\u50A8\u914D\u989D\u5DF2\u6EE1\uFF0C\u672C\u5730\u7F13\u5B58\u5DF2\u505C\u6B62\u5199\u5165\uFF0C\u8BF7\u6E05\u7406\u5386\u53F2\u6216\u7F13\u5B58")
    });
    let limiter = buildLimiter(config);
    let markingDoc = null;
    let currentQuestion = null;
    let lastResult = null;
    let lastHistoryId = "";
    // 从历史定位过来后重新批改：结果写回原条目，避免待复核队列一直指着旧分数打转。
    let regradeTargetId = "";
    let busy = false;
    // 提交互斥与冷却：连续批阅与手动点击可能同时触发提交，必须串行化。
    let submitting = false;
    let lastSubmitAt = 0;
    const SUBMIT_COOLDOWN = 1500;
    const forcedNotified = new Set();
    let autoMode = false;
    let autoStopRequested = false;
    // 复核队列：从「下一条需复核」进入后，提交完自动标记并跳到下一条待复核的卷子。
    let reviewQueueActive = false;
    let observer = null;
    let observerTimer = 0;
    let watchTimer = 0;
    const panel = new GraderPanel({
      onGrade: () => {
        void runGrade2();
      },
      onContinuous: () => {
        void toggleContinuous();
      },
      onSubmit: (skipConfirm) => {
        void submitResult({ skipConfirm });
      },
      onHistory: () => historyPanel.show(loadHistory()),
      onSettings: () => settingsPanel.show(config)
    });
    cache = createCache();
    const settingsPanel = new SettingsPanel({
      onSave: (draft) => {
        config = draft;
        saveConfig(config);
        // TPM 太低时大图会长期排队，提示一次而不是等用户自己发现。
        if (config.pipeline.maxTpm < 12000) panel.toast("TPM \u9884\u7B97\u4F4E\u4E8E 12000\uFF0C\u5927\u56FE\u5BB9\u6613\u6392\u961F\uFF0C\u5EFA\u8BAE\u8C03\u5927");
        syncKeysFromConfig(config);
        syncModelsFromConfig(config);
        syncThinkingModesFromConfig(config);
        cache = createCache();
        limiter = buildLimiter(config);
        panel.setCache(pipelineLabel(config));
        // 保存配置时顺手把这套标准存进「本题」槽位，下次切回来直接可用。
        const slot = rubricSlotKey(currentQuestion);
        if (slot) putRubricPreset(slot, config.context);
        panel.setSubtitle("\u914D\u7F6E\u5DF2\u66F4\u65B0");
      },
      // 标准库的增删都用「当前题号」定位，避免把 A 题的标准存到 B 题上。
      onRubricSave: (context) => {
        const slot = rubricSlotKey(currentQuestion);
        if (!slot) {
          panel.toast("\u5C1A\u672A\u8BFB\u53D6\u5230\u9898\u53F7\uFF0C\u65E0\u6CD5\u5B58\u5165\u6807\u51C6\u5E93");
          return;
        }
        if (!rubricHasContent(context)) {
          panel.toast("\u53C2\u8003\u7B54\u6848\u4E0E\u8BC4\u5206\u6807\u51C6\u90FD\u662F\u7A7A\u7684\uFF0C\u6CA1\u5FC5\u8981\u5B58");
          return;
        }
        config = { ...config, context: rubricContextFields(context) };
        saveConfig(config);
        putRubricPreset(slot, config.context);
        panel.toast(`\u5DF2\u5B58\u5165\u6807\u51C6\u5E93\uFF1A\u9898\u53F7 ${rubricSlotLabel(currentQuestion)}`);
      },
      onRubricLoad: () => {
        const slot = rubricSlotKey(currentQuestion);
        const preset = getRubricPreset(slot);
        if (!preset) {
          panel.toast(`\u9898\u53F7 ${rubricSlotLabel(currentQuestion) || "\u672C\u9898"} \u8FD8\u6CA1\u5B58\u8FC7\u6807\u51C6`);
          return;
        }
        config = { ...config, context: rubricContextFields(preset) };
        saveConfig(config);
        panel.toast(`\u5DF2\u8F7D\u5165\u9898\u53F7 ${rubricSlotLabel(currentQuestion)} \u7684\u6807\u51C6`);
      },
      onRubricClear: () => {
        const slot = rubricSlotKey(currentQuestion);
        const removed = removeRubricPreset(slot);
        panel.toast(removed ? `\u5DF2\u6E05\u7A7A\u9898\u53F7 ${rubricSlotLabel(currentQuestion)} \u7684\u6807\u51C6` : "\u672C\u9898\u8FD8\u6CA1\u5B58\u8FC7\u6807\u51C6");
      },
      onTest: (draft) => testService(draft),
      onFetchModels: (draft) => fetchModels(draft.pipeline.vlm),
      onGenerateRubric: (draft, payload) => {
        const service = draft.pipeline.vlm;
        service.thinkingMode = normalizeThinkingMode(draft.pipeline.thinkingMode !== void 0 ? draft.pipeline.thinkingMode : draft.pipeline.disableThinking);
        return generateRubric(payload, service, buildLimiter(draft), draft.image);
      },
      onTestThinking: (draft) => {
        draft.pipeline.vlm.thinkingMode = normalizeThinkingMode(draft.pipeline.thinkingMode !== void 0 ? draft.pipeline.thinkingMode : draft.pipeline.disableThinking);
        return probeThinking(draft.pipeline.vlm);
      },
      onImport: (data) => {
        config = merge(DEFAULT_CONFIG, data.config);
        saveConfig(config);
        if (isRecord(data.keys)) savePlatformKeys(data.keys);
        if (isRecord(data.models)) savePlatformModels(data.models);
        if (isRecord(data.thinkingModes)) savePlatformThinkingModes(data.thinkingModes);
        syncKeysFromConfig(config);
        syncModelsFromConfig(config);
        syncThinkingModesFromConfig(config);
        cache = createCache();
        limiter = buildLimiter(config);
        panel.setCache(pipelineLabel(config));
        panel.setSubtitle("\u914D\u7F6E\u5DF2\u5BFC\u5165");
      },
      onReset: () => {
        resetConfig();
        config = loadConfig();
        cache = createCache();
        limiter = buildLimiter(config);
        settingsPanel.show(config);
      },
      onClear: () => {
        clearAllData();
        cache.clear();
        config = loadConfig();
        limiter = buildLimiter(config);
        panel.setCache("\u672A\u914D\u7F6E", "warn");
        panel.setSubtitle("\u6570\u636E\u5DF2\u6E05\u7A7A");
        historyPanel.refresh([]);
        settingsPanel.show(config);
      }
    });
    const historyPanel = new HistoryPanel({
      onExport: (kind) => {
        downloadText(
          exportFilename(kind),
          kind === "csv" ? toCsv(loadHistory()) : toHtml(loadHistory()),
          kind === "csv" ? "text/csv;charset=utf-8" : "text/html;charset=utf-8"
        );
      },
      onClear: () => {
        clearHistory();
        historyPanel.refresh([]);
        panel.toast("\u5386\u53F2\u5DF2\u6E05\u7A7A");
      },
      // 复核留痕写回历史：备注、确认分、复核时间都只在本地。
      onReview: (id, patch) => {
        const history = loadHistory().map((entry) => entry.id === id ? { ...entry, ...patch } : entry);
        writeJson(STORAGE_KEYS.history, history);
        historyPanel.refresh(history);
        panel.toast("\u590D\u6838\u4FE1\u606F\u5DF2\u4FDD\u5B58");
      },
      // 点历史记录直接回到阅卷页对应那份卷子（复用平台的阅卷记录链路）。
      onJump: (entry, fromQueue) => {
        // 手动定位要退出队列模式，免得下一次提交被自动带去别的卷子。
        if (!fromQueue) reviewQueueActive = false;
        void jumpToHistory(entry, { fromQueue: Boolean(fromQueue) });
      },
      onEmptyQueue: () => panel.toast("\u6CA1\u6709\u5F85\u590D\u6838\u7684\u8BB0\u5F55")
    });
    panel.mount();
    // 观察器拿到新卷后立刻刷新题号与进度：页面 DOM 常比接口先就绪，只靠 MutationObserver 会漏。
    onHookUpdate(() => {
      if (!markingDoc) return;
      applyQuestion(readQuestion(markingDoc));
      updateProgress();
    });
    panel.setCache(pipelineLabel(config));
    if (validateConfig(config).length > 0) {
      panel.setSubtitle("\u8BF7\u70B9\u51FB\u300C\u8BBE\u7F6E\u300D\u5B8C\u6210\u914D\u7F6E");
    }
    async function testService(draft) {
      const serviceLimiter = buildLimiter(draft);
      draft.pipeline.vlm.thinkingMode = normalizeThinkingMode(draft.pipeline.thinkingMode !== void 0 ? draft.pipeline.thinkingMode : draft.pipeline.disableThinking);
      const service = draft.pipeline.vlm;
      if (!service.endpoint.trim() || !service.model.trim()) return false;
      return testConnection(service, serviceLimiter);
    }
    async function runGrade2() {
      if (busy) return false;
      if (!currentQuestion || !markingDoc) {
        panel.showError("\u5C1A\u672A\u8BFB\u53D6\u5230\u9898\u76EE\uFF0C\u8BF7\u6253\u5F00\u667A\u5B66\u7F51\u9605\u5377\u9875");
        return false;
      }
      // 满分以页面（接口优先）为准：不一致就自动写回配置，不再阻断批改。
      const scoreCheck = checkMaxScore(config.context.maxScore, markingDoc);
      if (scoreCheck.maxScore > 0 && scoreCheck.mismatch) {
        config.context.maxScore = scoreCheck.maxScore;
        saveConfig(config);
        panel.toast(`\u5DF2\u6309\u9875\u9762\u540C\u6B65\u6EE1\u5206\uFF1A${scoreCheck.maxScore} \u5206`);
      }
      const errors = validateConfig(config);
      if (errors.length > 0) {
        panel.showError(`${errors[0]}\uFF08\u8BF7\u70B9\u51FB\u300C\u8BBE\u7F6E\u300D\u624B\u52A8\u4FEE\u6539\uFF09`);
        return false;
      }
      busy = true;
      panel.setBusy(true);
      panel.clearError();
      try {
        panel.setStage("\u7B49\u5F85\u4F5C\u7B54\u56FE\u7247\u7A33\u5B9A");
        let images = await gatherAnswerImages();
        if (images.length === 0) {
          // DOM 一直不稳或链接已过期时，用接口观察到的新鲜地址兜底。
          images = freshAnswerImages();
        }
        if (images.length === 0) throw new Error("\u4F5C\u7B54\u56FE\u7247\u5C1A\u672A\u7A33\u5B9A\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
        // 身份只取台账号与题号：跨账号一致，且不含会过期的签名。
        const observedIdentity = currentHookIdentity();
        // 学号与试卷 ID 是「历史记录定位」的钥匙：记录列表只认学号，接口只认试卷 ID。
        const identity = observedIdentity && observedIdentity.scanRecordId
          ? {
            scanRecordId: observedIdentity.scanRecordId,
            topicNumStr: observedIdentity.topicNumStr || "",
            userCode: observedIdentity.userCode || "",
            markingPaperId: observedIdentity.markingPaperId || ""
          }
          : null;
        currentQuestion = { ...currentQuestion, images, identity };
        panel.setQuestion(currentQuestion);
        const result = await gradeQuestion({
          config,
          question: currentQuestion,
          cache,
          rateLimiter: limiter,
          events: { onStage: (stage, detail) => panel.setStage(stage, detail) }
        });
        lastResult = result;
        panel.setResult(result);
        // 从历史定位过来重批时更新原条目，普通批改才新增：否则复核队列会一直指着旧分数打转。
        const regradeTarget = regradeTargetId && loadHistory().find((entry) => entry.id === regradeTargetId);
        const historyEntry = {
          id: regradeTarget?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          createdAt: regradeTarget?.createdAt || Date.now(),
          question: historyQuestion(currentQuestion),
          result,
          submitted: false
        };
        lastHistoryId = historyEntry.id;
        if (regradeTarget) {
          const history = loadHistory().map((entry) => entry.id === regradeTarget.id
            ? {
              ...entry,
              ...historyEntry,
              // 新结果要重新复核：清掉上一轮的复核留痕，但保留用户填过的确认分。
              reviewedAt: void 0,
              reviewNote: void 0
            }
            : entry);
          writeJson(STORAGE_KEYS.history, history);
          historyPanel.refresh(history);
        } else {
          appendHistory(historyEntry, config.historyLimit);
          historyPanel.refresh(loadHistory());
        }
        if (!identity) {
          const gradedKeys = (currentQuestion.images || []).map(stableImageKey).join("|");
          void backfillIdentity(lastHistoryId, gradedKeys);
        }
        if (result.needsReview) panel.toast("\u6279\u6539\u5B8C\u6210\uFF0C\u5EFA\u8BAE\u4EBA\u5DE5\u590D\u6838");
        // 强制思考的模型只提示一次，避免每份卷子都弹。
        if (result.thinkingForced && !forcedNotified.has(config.pipeline.vlm.model)) {
          forcedNotified.add(config.pipeline.vlm.model);
          panel.toast(`\u300C${config.pipeline.vlm.model}\u300D\u5F3A\u5236\u601D\u8003\u3001\u65E0\u6CD5\u5173\u95ED\uFF0C\u5DF2\u6309\u6A21\u578B\u9ED8\u8BA4\u8FD0\u884C`);
        }
        return true;
      } catch (error) {
        panel.showError(error instanceof Error ? error.message : "\u6279\u6539\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u63A5\u53E3\u914D\u7F6E");
        return false;
      } finally {
        busy = false;
        panel.setBusy(false);
      }
    }
    // 观察器晚于首份卷加载时（刷新后立刻批改、脚本刚注入），identity 是空的；
    // 等接口数据到了再回填，否则这条历史永远点不了「定位」。
    async function backfillIdentity(historyId, imageKeys) {
      const deadline = Date.now() + 8e3;
      while (Date.now() < deadline) {
        const observed = currentHookIdentity();
        if (observed && observed.scanRecordId) {
          // 卷子已经换了就别回填，否则会把上一位学生的身份贴到这条记录上。
          const nowKeys = (currentQuestion?.images || []).map(stableImageKey).join("|");
          if (nowKeys !== imageKeys) return;
          const history = loadHistory().map((entry) => entry.id === historyId
            ? {
              ...entry,
              question: {
                ...entry.question,
                // 顺带把题号修正成接口口径（DOM 的 "43(1)" 查记录列表查不到），
                // 只改「原本就是 DOM 口径」的那种，接口口径原样保留。
                topicNumStr: observed.topicNumStr || entry.question.topicNumStr,
                identity: {
                  scanRecordId: observed.scanRecordId,
                  topicNumStr: observed.topicNumStr || "",
                  userCode: observed.userCode || "",
                  markingPaperId: observed.markingPaperId || ""
                }
              }
            }
            : entry);
          writeJson(STORAGE_KEYS.history, history);
          historyPanel.refresh(history);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 300));
      }
    }
    // 历史只留定位字段与归一化后的图片键：签名 URL / data URI 会过期并迅速撑爆存储。
    function historyQuestion(question) {
      return {
        questionId: question.questionId,
        // 题号与接口原始题号都留一份，方便按平台口径对账。
        topicNumStr: question.topicNumStr || question.questionId,
        questionText: question.questionText,
        maxScore: question.maxScore,
        subQuestions: question.subQuestions,
        identity: question.identity || null,
        imageKeys: (question.images || []).map(stableImageKey)
      };
    }
    function applyScoreEdits() {
      const edits = typeof panel.getScoreEdits === "function" ? panel.getScoreEdits() : null;
      if (!edits || (!Number.isFinite(edits.total) && !edits.subScores)) return;
      // 批改结果与缓存共享 subScores 引用，先深拷贝再改，避免污染缓存。
      lastResult = { ...lastResult, subScores: lastResult.subScores.map((item) => ({ ...item })) };
      if (edits.subScores && edits.subScores.length === lastResult.subScores.length) {
        edits.subScores.forEach((value, index) => {
          if (!Number.isFinite(value)) return;
          const max = Number(lastResult.subScores[index].maxScore) || 999;
          lastResult.subScores[index].score = Math.min(Math.max(value, 0), max);
        });
        lastResult.score = lastResult.subScores.reduce((sum, item) => sum + Number(item.score || 0), 0);
      }
      if (Number.isFinite(edits.total)) {
        const total = Math.min(Math.max(edits.total, 0), Number(lastResult.maxScore) || 999);
        if (lastResult.subScores.length) {
          const currentSum = lastResult.subScores.reduce((sum, item) => sum + Number(item.score || 0), 0);
          if (currentSum > 0) {
            lastResult.subScores.forEach((item) => {
              const max = Number(item.maxScore) || 999;
              item.score = Math.min(Math.max(Number(item.score || 0) * total / currentSum, 0), max);
            });
            const newSum = lastResult.subScores.reduce((sum, item) => sum + Number(item.score || 0), 0);
            const diff = Math.round((total - newSum) * 10) / 10;
            if (diff !== 0 && lastResult.subScores.length) {
              const last = lastResult.subScores[lastResult.subScores.length - 1];
              last.score = Math.min(Math.max(Math.round((Number(last.score || 0) + diff) * 10) / 10, 0), Number(last.maxScore) || 999);
            }
          }
        }
        lastResult.score = total;
      }
    }
    async function submitResult(options = {}) {
      // 两种失败原因分开说：「没进阅卷页」和「还没批改」是两件事。
      if (!markingDoc) {
        panel.showError("\u672A\u68C0\u6D4B\u5230\u9605\u5377\u63A7\u4EF6\uFF0C\u8BF7\u5148\u6253\u5F00\u9605\u5377\u9875");
        return { ok: false, oldIdentity: null };
      }
      if (!lastResult) {
        panel.showError("\u8FD8\u6CA1\u6709\u6279\u6539\u7ED3\u679C\uFF0C\u8BF7\u5148\u70B9\u300C\u5F00\u59CB\u6279\u6539\u300D");
        return { ok: false, oldIdentity: null };
      }
      // 互斥 + 冷却：连点会把同一份卷提交两次，也会让提交回执错位到下一次点击上。
      if (submitting) return { ok: false, oldIdentity: null };
      if (Date.now() - lastSubmitAt < SUBMIT_COOLDOWN) {
        panel.toast("\u521A\u63D0\u4EA4\u8FC7\uFF0C\u8BF7\u7A0D\u5019\u518D\u8BD5");
        return { ok: false, oldIdentity: null };
      }
      submitting = true;
      try {
        applyScoreEdits();
        // 提交要等回执、最多几秒，这期间页面可能已经换卷，applyQuestion 会把 lastResult 清空。
        // 先用局部变量抓住这份结果，后面写历史、回缓存都只认它。
        const submittedResult = lastResult;
        const inputs = getScoreInputs(markingDoc);
        // 打分框比小题分多时，硬填只会把第一个框写上、后面留空，必须拦住说清楚。
        if (inputs.length > 1 && submittedResult.subScores.length !== inputs.length) {
          panel.showError(`小题分未回全（${submittedResult.subScores.length}/${inputs.length}），请先补齐再提交`);
          return { ok: false, oldIdentity: null };
        }
        const scores = inputs.length > 1 ? submittedResult.subScores.map((item) => item.score) : [Math.round(submittedResult.score * 10) / 10];
        const label = scores.length > 1 ? `\u5404\u5C0F\u9898\u5206\u6570 ${scores.join("\u3001")}` : `${scores[0]} \u5206`;
        if (!options.silent && !options.skipConfirm && !window.confirm(`\u786E\u8BA4\u5199\u5165${label}\u5E76\u63D0\u4EA4\uFF1F`)) {
          return { ok: false, oldIdentity: null };
        }
        const oldIdentity = getPaperIdentity();
        // 换卷判据需要提交前的 scanRecordId；接口没给就留空、退回图片判定。
        const oldScan = currentScanRecordId();
        // 填分必须回读一致才算写入成功，否则宁可不提交。
        const filled = fillScores(scores, markingDoc);
        if (!filled.ok) {
          panel.showError(`\u5206\u6570\u672A\u5199\u5165\uFF0C\u5DF2\u4E2D\u6B62\u63D0\u4EA4\uFF1A${filled.error}`);
          return { ok: false, oldIdentity };
        }
        // iframe 可能刚被路由替换，提交前再确认一次观察器存活。
        ensureZhixueHook(markingDoc);
        resetCommitSignal();
        if (!submitGrade(markingDoc)) {
          panel.showError("\u5206\u6570\u5DF2\u586B\u5165\uFF0C\u4F46\u672A\u627E\u5230\u63D0\u4EA4\u6309\u94AE\uFF0C\u8BF7\u624B\u52A8\u63D0\u4EA4");
          return { ok: false, oldIdentity };
        }
        lastSubmitAt = Date.now();
        // 有接口观察器就以平台回执为准（最多等 2.5 秒）；没有观察器时保持旧行为。
        const observed = hookActive();
        const signal = observed ? await waitCommitSignal(2500) : null;
        // 回执丢了不代表没提交：再看一眼卷子有没有真的换，避免误报失败后老师重复提交。
        const changed = observed && !signal ? await waitPaperChanged(oldIdentity, oldScan, 3e3) : false;
        const verdict = judgeSubmit(observed, signal, changed);
        if (!verdict.ok) {
          panel.showError(verdict.reason);
          return { ok: false, oldIdentity };
        }
        // 提交即人工确认：需复核的条目顺手标记已复核，复核队列不会越积越长。
        const history = loadHistory().map((entry) => {
          if (entry.id !== lastHistoryId) return entry;
          const patch = { ...entry, result: submittedResult, submitted: true, submitConfirmed: verdict.confirmed };
          if (submittedResult?.needsReview && !entry.reviewedAt) {
            patch.reviewedAt = Date.now();
            patch.reviewNote = entry.reviewNote || "\u63D0\u4EA4\u65F6\u81EA\u52A8\u6807\u8BB0";
          }
          return patch;
        });
        writeJson(STORAGE_KEYS.history, history);
        historyPanel.refresh(history);
        // 顺手把「阅卷记录」里的记录 id 解析出来存进历史：下次点定位不用再翻列表。
        const submittedHistoryId = lastHistoryId;
        // 题号/试卷 ID 以刚写进历史的那条为准：此刻 currentQuestion 可能已经换成下一份了。
        const submittedEntry = loadHistory().find((entry) => entry.id === submittedHistoryId);
        const submittedIdentity = submittedEntry?.question?.identity || null;
        if (submittedHistoryId) {
          const fallbackIdentity = submittedIdentity || {
            scanRecordId: "",
            topicNumStr: submittedEntry?.question?.topicNumStr || "",
            userCode: "",
            markingPaperId: hookCurrentField("markingPaperId") || ""
          };
          void resolveMarkedRecordId(markingDoc, fallbackIdentity, submittedResult?.score).then((record) => {
            if (!record || !record.id) return;
            const patched = loadHistory().map((entry) => {
              if (entry.id !== submittedHistoryId) return entry;
              const identity = entry.question.identity || { scanRecordId: "", topicNumStr: "", userCode: "", markingPaperId: "" };
              return {
                ...entry,
                question: {
                  ...entry.question,
                  recordId: record.id,
                  // 学号是定位的钥匙：观察器漏了首份卷时靠这里补上。
                  identity: {
                    ...identity,
                    userCode: identity.userCode || record.userCode,
                    markingPaperId: identity.markingPaperId || fallbackIdentity.markingPaperId,
                    // 身份里的题号统一存接口口径（43,1），DOM 口径留着只用于显示
                    topicNumStr: identity.topicNumStr || jumpApiTopicNum(fallbackIdentity.topicNumStr)
                  }
                }
              };
            });
            writeJson(STORAGE_KEYS.history, patched);
            historyPanel.refresh(patched);
          }).catch(() => { /* 解析失败不影响提交结果 */ });
        }
        // 把人工改过的分数回写缓存：双评换第二个账号时命中缓存拿到的是最终分，而不是模型原始分。
        if (cache && submittedResult?.cacheKey) cache.set(submittedResult.cacheKey, submittedResult);
        lastResult = null;
        // 这份已提交，重批归属到此结束；下一份若来自队列，jumpToHistory 会重新设置。
        regradeTargetId = "";
        updateProgress();
        panel.setSubtitle(options.silent ? "\u8FDE\u7EED\u6279\u9605\u4E2D" : "\u5DF2\u63D0\u4EA4\uFF0C\u7B49\u5F85\u4E0B\u4E00\u4EFD");
        if (options.silent) {
          panel.setStage("\u5DF2\u63D0\u4EA4\uFF0C\u7B49\u5F85\u6362\u5377");
        } else {
          panel.toast(
            verdict.confirmed
              ? "\u5DF2\u63D0\u4EA4\uFF08\u5E73\u53F0\u5DF2\u786E\u8BA4\uFF09"
              : verdict.inferred
                ? "\u5DF2\u63D0\u4EA4\uFF08\u672A\u62FF\u5230\u56DE\u6267\uFF0C\u4F46\u9875\u9762\u5DF2\u6362\u5377\uFF09"
                : "\u5DF2\u63D0\u4EA4"
          );
          void waitForNextPaper(oldIdentity, oldScan).then((changed) => {
            if (changed) void detect();
            else panel.setSubtitle("\u672A\u68C0\u6D4B\u5230\u6362\u5377\uFF0C\u53EF\u7EE7\u7EED\u4EBA\u5DE5\u64CD\u4F5C");
          });
        }
        // 复核队列模式下，这一份已经提交（需复核的条目会被自动标记已复核），直接推进下一条。
        if (!options.silent && reviewQueueActive) scheduleReviewAdvance();
        return { ok: true, oldIdentity, oldScan };
      } finally {
        submitting = false;
      }
    }
    // 历史记录定位：切题号 → 学号换记录 id → 调页面自己的回评方法 → 重新读题号与满分。
    async function jumpToHistory(entry, options = {}) {
      if (autoMode) {
        panel.toast("\u8FDE\u7EED\u6279\u9605\u4E2D\u4E0D\u80FD\u5B9A\u4F4D\uFF0C\u8BF7\u5148\u505C\u6B62");
        return;
      }
      if (busy || submitting) {
        panel.toast("\u6B63\u5728\u5904\u7406\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5");
        return;
      }
      const doc = markingDoc || await waitForMarkingDocument(6e3);
      if (!doc) {
        panel.showError("\u672A\u68C0\u6D4B\u5230\u9605\u5377\u63A7\u4EF6\uFF0C\u8BF7\u5148\u6253\u5F00\u9605\u5377\u9875");
        return;
      }
      markingDoc = doc;
      ensureZhixueHook(doc);
      // 跳转前先记下当前打分框的值，跳完要等它换成目标卷的分数再对账。
      const scoresBefore = readFilledScores(doc);
      busy = true;
      panel.setBusy(true);
      panel.clearError();
      panel.setStage("\u5B9A\u4F4D\u5386\u53F2\u8BB0\u5F55");
      try {
        const result = await jumpToMarkedRecord(entry, {
          doc,
          onPage: (page, total) => panel.setStage("\u5B9A\u4F4D\u5386\u53F2\u8BB0\u5F55", `\u7FFB\u8BB0\u5F55 ${page}/${total} \u9875`)
        });
        if (!result.ok) {
          panel.showError(result.error);
          // 定位失败就退出队列模式，避免下一次提交被带去别的卷子。
          reviewQueueActive = false;
          regradeTargetId = "";
          return;
        }
        // 没换卷时只有「当前学号就是目标学号」才算定位成功：否则队列会把眼前这份卷写到别人的历史记录上。
        const expectedUser = String(entry?.question?.identity?.userCode || "").trim();
        const observedUser = String(currentHookIdentity()?.userCode || (answerSnapshot(doc)?.identity || {}).userCode || "").trim();
        if (!result.changed && (!expectedUser || observedUser !== expectedUser)) {
          panel.showError("\u56DE\u8BC4\u540E\u6CA1\u770B\u5230\u76EE\u6807\u5377\uFF0C\u5DF2\u505C\u6B62\u5B9A\u4F4D\uFF1B\u8BF7\u4EBA\u5DE5\u786E\u8BA4\u5F53\u524D\u5377\u540E\u91CD\u8BD5");
          reviewQueueActive = false;
          regradeTargetId = "";
          return;
        }
        if (!result.changed) panel.toast("\u5DF2\u53D1\u9001\u56DE\u8BC4\uFF0C\u4F46\u6CA1\u770B\u5230\u6362\u5377\uFF0C\u8BF7\u4EBA\u5DE5\u786E\u8BA4");
        // 定位成功后才进入队列模式：失败时不能让下一次提交被带去别的卷子。
        if (options.fromQueue) reviewQueueActive = true;
        // 换卷后旧结果必须作废：面板上留着上一份的分数会诱导提交到这份卷上。
        lastResult = null;
        currentQuestion = null;
        panel.clearResult();
        if (result.record?.id && entry?.id) {
          const patched = loadHistory().map((item) => item.id === entry.id
            ? { ...item, question: { ...item.question, recordId: result.record.id } }
            : item);
          writeJson(STORAGE_KEYS.history, patched);
          historyPanel.refresh(patched);
        }
        applyQuestion(readQuestion(doc));
        // 记录这次批改归属：后面「开始批改」要覆盖这条，而不是再插一条重复历史。
        regradeTargetId = entry?.id || "";
        updateProgress();
        // 平台回填的是「这条记录当时的分数」，和本地历史对不上说明中途有人改过分。
        // 顺带用它给一句明确的定位反馈：换卷后副标题会被观察器改回「已读取题号」。
        const filled = await waitScoresSettled(doc, scoresBefore, 1500);
        const actual = filled.length > 1 ? filled.reduce((sum, value) => sum + value, 0) : filled[0];
        const expected = Number(entry?.result?.score);
        const mismatch = Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) > 0.05;
        panel.toast(
          mismatch
            ? `\u8BE5\u5377\u5F53\u524D ${actual} \u5206\uFF0C\u5386\u53F2\u8BB0\u5F55\u662F ${expected} \u5206\uFF0C\u53EF\u80FD\u5DF2\u88AB\u4ED6\u4EBA\u6539\u5206`
            : `\u5DF2\u5B9A\u4F4D\u5230\u5B66\u53F7 ${result.userCode}${Number.isFinite(actual) ? `\uFF0C\u5F53\u524D ${actual} \u5206` : ""}`
        );
        historyPanel.hide();
        panel.setSubtitle(`\u5DF2\u5B9A\u4F4D\u5230\u5B66\u53F7 ${result.userCode}`);
        if (reviewQueueActive) {
          const remain = pendingReviewEntries().length;
          panel.setSubtitle(`\u590D\u6838\u961F\u5217 \xB7 \u5269\u4F59 ${remain} \u6761`);
        }
      } catch (error) {
        panel.showError(error instanceof Error ? error.message : "\u5B9A\u4F4D\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u5728\u9605\u5377\u8BB0\u5F55\u91CC\u627E\u8FD9\u4E00\u4EFD");
        reviewQueueActive = false;
        regradeTargetId = "";
      } finally {
        busy = false;
        panel.setBusy(false);
      }
    }
    // 队列里还剩哪些：需复核 + 未标记已复核 + 能定位。
    function pendingReviewEntries() {
      return loadHistory().filter((entry) => entry.result?.needsReview && !entry.reviewedAt && canJumpRecord(entry));
    }
    // 提交成功后自动跳下一条，把「复核」做成一路走到底的流程；队列空了就收尾。
    function scheduleReviewAdvance() {
      window.setTimeout(() => {
        void advanceReviewQueue();
      }, 900);
    }
    async function advanceReviewQueue() {
      if (!reviewQueueActive || autoMode) return;
      const pending = pendingReviewEntries();
      if (pending.length === 0) {
        reviewQueueActive = false;
        panel.toast("\u590D\u6838\u961F\u5217\u5DF2\u5B8C\u6210");
        panel.setSubtitle("\u590D\u6838\u961F\u5217\u5DF2\u5B8C\u6210");
        return;
      }
      await jumpToHistory(pending[0], { fromQueue: true });
    }
    async function toggleContinuous() {
      if (autoMode) {
        autoMode = false;
        autoStopRequested = true;
        panel.setAutoMode(false);
        panel.setSubtitle("\u5DF2\u505C\u6B62\u8FDE\u7EED\u6279\u9605");
        panel.toast("\u8FDE\u7EED\u6279\u9605\u5DF2\u505C\u6B62");
        return;
      }
      const confirmed = window.confirm("\u8FDE\u7EED\u6279\u9605\u4F1A\u81EA\u52A8\u6279\u6539\u5E76\u63D0\u4EA4\u6BCF\u4E00\u4EFD\uFF0C\u9047\u5230\u9519\u8BEF\u6216\u7B49\u4E0D\u5230\u6362\u5377\u4F1A\u505C\u6B62\u3002\u786E\u5B9A\u5F00\u59CB\uFF1F");
      if (!confirmed) return;
      autoMode = true;
      autoStopRequested = false;
      panel.setAutoMode(true);
      panel.clearError();
      let count = 0;
      // 份数上限：无人看管时也不会一路跑到没配额。
      const limit = Math.max(1, Math.min(200, Number(config.continuousLimit) || 20));
      while (autoMode && !autoStopRequested) {
        if (count >= limit) {
          panel.setSubtitle(`\u5DF2\u8FBE\u8FDE\u7EED\u6279\u9605\u4E0A\u9650 ${limit} \u4EFD\uFF0C\u5DF2\u505C\u6B62`);
          panel.toast(`\u5DF2\u8FBE\u5230 ${limit} \u4EFD\u4E0A\u9650`);
          break;
        }
        count += 1;
        panel.setSubtitle(`\u8FDE\u7EED\u6279\u9605\u4E2D \xB7 \u7B2C ${count} \u4EFD`);
        const graded = await runGrade2();
        if (!graded || !autoMode || autoStopRequested) break;
        const submitted = await submitResult({ silent: true });
        if (!submitted.ok || !autoMode || autoStopRequested) break;
        panel.setSubtitle(`\u8FDE\u7EED\u6279\u9605\u4E2D \xB7 \u7B2C ${count} \u4EFD\u5DF2\u63D0\u4EA4\uFF0C\u7B49\u5F85\u6362\u5377\uFF08\u53EF\u5207\u6362\u5230\u5176\u4ED6\u6807\u7B7E\u9875\uFF09`);
        const changed = await waitForNextPaper(submitted.oldIdentity, submitted.oldScan);
        if (!changed || !autoMode || autoStopRequested) {
          if (autoMode) panel.showError("\u7B49\u5F85\u6362\u5377\u8D85\u65F6\uFF0C\u8FDE\u7EED\u6279\u9605\u5DF2\u505C\u6B62\u3002\u82E5\u521A\u624D\u5207\u6362\u4E86\u754C\u9762\uFF0C\u8BF7\u786E\u8BA4\u9605\u5377\u9875\u4ECD\u6253\u5F00\u4E14\u5DF2\u663E\u793A\u65B0\u4F5C\u7B54\u56FE\u540E\u91CD\u65B0\u5F00\u59CB");
          break;
        }
        await detect();
        await new Promise((resolve) => window.setTimeout(resolve, 300));
      }
      autoMode = false;
      autoStopRequested = false;
      panel.setAutoMode(false);
      panel.setSubtitle(`\u8FDE\u7EED\u6279\u9605\u5DF2\u505C\u6B62 \xB7 \u5171 ${count} \u4EFD`);
    }
    async function detect() {
      if (!isZhixueHost()) {
        panel.setSubtitle("\u5F53\u524D\u975E\u9605\u5377\u9875\u9762");
        return;
      }
      const doc = await waitForMarkingDocument();
      if (!doc) {
        panel.setSubtitle("\u672A\u68C0\u6D4B\u5230\u9605\u5377\u63A7\u4EF6");
        return;
      }
      markingDoc = doc;
      // 每次拿到阅卷文档都校验一次：平台路由切换会换掉 iframe，旧 hook 随之失效。
      ensureZhixueHook(doc);
      applyQuestion(readQuestion(doc));
      updateProgress();
      watchDocument(doc);
    }
    // 判「还是同一份卷」：题号 + 作答图（去签名）+ 接口身份三者都对得上才算没换。
    // 刚换卷时观察器比 DOM 慢，scanRecordId 可能一边为空——这时不能据此判换卷，
    // 否则老师刚批完就被清空结果，点提交只会得到「请先完成批改」。
    function samePaper(a, b) {
      if (!a || !b) return false;
      // 题号口径会从 DOM 的 43(1) 变成接口的 43,1，归一后再比，别把同一道题判成换卷。
      const topicOf = (value) => (typeof rubricTopicKey === "function" ? rubricTopicKey(value) : String(value || ""));
      if (topicOf(a.questionId) !== topicOf(b.questionId)) return false;
      if ((a.images || []).length !== (b.images || []).length) return false;
      if (a.scanRecordId && b.scanRecordId && a.scanRecordId !== b.scanRecordId) return false;
      const key = (url) => resourceKey(url) || url;
      const left = (a.images || []).map(key).sort().join("|");
      const right = (b.images || []).map(key).sort().join("|");
      return left === right;
    }
    function applyQuestion(question) {
      if (!question) return;
      if (samePaper(currentQuestion, question)) return;
      // 自然换卷后不再属于刚才定位的历史条目，重批目标随之失效。
      regradeTargetId = "";
      const previousSlot = rubricSlotKey(currentQuestion);
      currentQuestion = question;
      lastResult = null;
      panel.setQuestion(question);
      panel.setSubtitle(`\u5DF2\u8BFB\u53D6\u9898\u53F7 ${question.questionId}`);
      panel.clearError();
      syncRubricForQuestion(previousSlot, question);
    }
    // 切题时把上一题的标准存回它的槽位，再载入新题号已存的那份。
    // 新题号没存过就清空答案/标准（上一题已自动保存）：拿错答案键批改比多填一次危险得多。
    function syncRubricForQuestion(previousSlot, question) {
      const nextSlot = rubricSlotKey(question);
      const switched = Boolean(previousSlot) && previousSlot !== nextSlot;
      const saved = switched ? putRubricPreset(previousSlot, config.context) : false;
      if (!nextSlot) return;
      const preset = getRubricPreset(nextSlot);
      if (preset && rubricHasContent(preset)) {
        if (sameRubricContext(config.context, preset)) return;
        config = { ...config, context: rubricContextFields(preset) };
        saveConfig(config);
        panel.toast(`\u5DF2\u8F7D\u5165\u9898\u53F7 ${rubricSlotLabel(question)} \u7684\u8BC4\u5206\u6807\u51C6`);
        return;
      }
      if (!switched || !saved || !rubricHasContent(config.context)) return;
      config = { ...config, context: { ...config.context, question: "", answer: "", rubric: "", maxScore: 0 } };
      saveConfig(config);
      panel.toast(`\u9898\u53F7 ${rubricSlotLabel(question)} \u8FD8\u6CA1\u5B58\u8FC7\u6807\u51C6\uFF0C\u4E0A\u4E00\u9898\u7684\u5DF2\u81EA\u52A8\u4FDD\u5B58`);
    }
    // 进度条：页面文本「初评已阅量/任务量」优先，接口计数兜底。
    function updateProgress() {
      const progress = readProgress(markingDoc);
      panel.setProgress(progress ? `\u5DF2\u6279 ${progress.marked} / \u4EFB\u52A1 ${progress.todo}` : "");
    }
    // 只盯题号/作答图/进度这几个容器：监听整个 body 会让「阅卷记录」这种大列表
    // 每敲一个字、每翻一页都触发一次全量快照。节点被路由整段替换时靠 2 秒复检重新挂。
    function watchDocument(doc) {
      observer?.disconnect();
      window.clearTimeout(observerTimer);
      window.clearInterval(watchTimer);
      if (!doc.body) return;
      const refresh = () => {
        applyQuestion(readQuestion(doc));
        updateProgress();
      };
      const schedule = () => {
        window.clearTimeout(observerTimer);
        observerTimer = window.setTimeout(refresh, 600);
      };
      const targets = () => Array.from(doc.querySelectorAll("#topicImgContent, #currentTopicIndex, #containter_topicTxt, .progress"));
      const quickKey = () => {
        const first = doc.querySelector('div[name="topicImg"] img');
        return `${doc.querySelector(SELECTORS.topicIndex)?.textContent?.trim() || ""}|${(first?.currentSrc || first?.src || "").slice(-80)}`;
      };
      let bound = [];
      let lastKey = quickKey();
      const bind = () => {
        const list = targets();
        const alive = list.length > 0 && list.every((node) => node.isConnected);
        if (alive && bound.length === list.length && bound.every((node, index) => node === list[index])) return;
        observer?.disconnect();
        bound = list.length > 0 ? list : [doc.body];
        observer = new MutationObserver(schedule);
        for (const node of bound) observer.observe(node, { childList: true, subtree: true, characterData: true });
      };
      bind();
      // 兜底：接口和 DOM 事件都没反应时，题号或首图变了也补一次刷新。
      watchTimer = window.setInterval(() => {
        bind();
        const key = quickKey();
        if (key === lastKey) return;
        lastKey = key;
        schedule();
      }, 2000);
    }
    GM_registerMenuCommand("\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u6253\u5F00\u9762\u677F", () => panel.show());
    GM_registerMenuCommand("\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u8FDE\u7EED\u6279\u9605", () => {
      void toggleContinuous();
    });
    GM_registerMenuCommand("\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u8BBE\u7F6E", () => settingsPanel.show(config));
    GM_registerMenuCommand("\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u5386\u53F2", () => historyPanel.show(loadHistory()));
    GM_registerMenuCommand("\u667A\u9605\u6279\u6539\u52A9\u624B \xB7 \u6E05\u7A7A\u7F13\u5B58", () => {
      cache.clear();
      panel.toast("\u7F13\u5B58\u5DF2\u6E05\u7A7A");
    });
    // 缓存写入是合并批量的，页面关闭前补一次落盘，避免丢最后几份结果。
    window.addEventListener("pagehide", () => cache?.flush?.());
    await detect();
  }
  void bootstrap().catch((error) => {
    console.warn("[\u667A\u9605\u6279\u6539\u52A9\u624B] \u542F\u52A8\u5931\u8D25", error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF");
  });
