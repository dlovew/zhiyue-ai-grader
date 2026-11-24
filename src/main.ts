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
    let cache = new CacheStore(config.cacheTtlDays);
    let limiter = buildLimiter(config);
    let markingDoc = null;
    let currentQuestion = null;
    let lastResult = null;
    let lastHistoryId = "";
    let busy = false;
    let autoMode = false;
    let autoStopRequested = false;
    let observer = null;
    let observerTimer = 0;
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
    const settingsPanel = new SettingsPanel({
      onSave: (draft) => {
        config = draft;
        saveConfig(config);
        syncKeysFromConfig(config);
        syncModelsFromConfig(config);
        cache = new CacheStore(config.cacheTtlDays);
        limiter = buildLimiter(config);
        panel.setCache(pipelineLabel(config));
        panel.setSubtitle("\u914D\u7F6E\u5DF2\u66F4\u65B0");
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
        return probeThinking(draft.pipeline.vlm, buildLimiter(draft));
      },
      onImport: (data) => {
        config = merge(DEFAULT_CONFIG, data.config);
        saveConfig(config);
        if (Array.isArray(data.presets)) saveCustomPresets(data.presets);
        if (isRecord(data.keys)) savePlatformKeys(data.keys);
        if (isRecord(data.models)) savePlatformModels(data.models);
        syncKeysFromConfig(config);
        syncModelsFromConfig(config);
        cache = new CacheStore(config.cacheTtlDays);
        limiter = buildLimiter(config);
        panel.setCache(pipelineLabel(config));
        panel.setSubtitle("\u914D\u7F6E\u5DF2\u5BFC\u5165");
      },
      onReset: () => {
        resetConfig();
        config = loadConfig();
        cache = new CacheStore(config.cacheTtlDays);
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
      }
    });
    panel.mount();
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
      const errors = validateConfig(config);
      if (errors.length > 0) {
        panel.showError(`${errors[0]}\uFF08\u8BF7\u70B9\u51FB\u300C\u8BBE\u7F6E\u300D\u624B\u52A8\u4FEE\u6539\uFF09`);
        return false;
      }
      const scoreError = checkMaxScore(config.context.maxScore, markingDoc);
      if (scoreError) {
        panel.showError(scoreError);
        return false;
      }
      busy = true;
      panel.setBusy(true);
      panel.clearError();
      try {
        panel.setStage("\u7B49\u5F85\u4F5C\u7B54\u56FE\u7247\u7A33\u5B9A");
        const images = await gatherAnswerImages();
        if (images.length === 0) throw new Error("\u4F5C\u7B54\u56FE\u7247\u5C1A\u672A\u7A33\u5B9A\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
        currentQuestion = { ...currentQuestion, images };
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
        lastHistoryId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        appendHistory({
          id: lastHistoryId,
          createdAt: Date.now(),
          question: currentQuestion,
          result,
          submitted: false
        }, config.historyLimit);
        historyPanel.refresh(loadHistory());
        if (result.needsReview) panel.toast("\u6279\u6539\u5B8C\u6210\uFF0C\u5EFA\u8BAE\u4EBA\u5DE5\u590D\u6838");
        return true;
      } catch (error) {
        panel.showError(error instanceof Error ? error.message : "\u6279\u6539\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u63A5\u53E3\u914D\u7F6E");
        return false;
      } finally {
        busy = false;
        panel.setBusy(false);
      }
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
      if (!lastResult || !markingDoc) {
        panel.showError("\u8BF7\u5148\u5B8C\u6210\u6279\u6539\u5E76\u8FDB\u5165\u9605\u5377\u9875\u9762");
        return { ok: false, oldIdentity: null };
      }
      applyScoreEdits();
      const inputs = getScoreInputs(markingDoc);
      const scores = inputs.length > 1 && lastResult.subScores.length === inputs.length ? lastResult.subScores.map((item) => item.score) : [Math.round(lastResult.score * 10) / 10];
      const label = scores.length > 1 ? `\u5404\u5C0F\u9898\u5206\u6570 ${scores.join("\u3001")}` : `${scores[0]} \u5206`;
      if (!options.silent && !options.skipConfirm && !window.confirm(`\u786E\u8BA4\u5199\u5165${label}\u5E76\u63D0\u4EA4\uFF1F`)) {
        return { ok: false, oldIdentity: null };
      }
      const oldIdentity = getPaperIdentity();
      if (!fillScores(scores, markingDoc)) {
        panel.showError("\u5206\u6570\u5199\u5165\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u6253\u5206\u7248\u8F93\u5165\u9879");
        return { ok: false, oldIdentity };
      }
      if (!submitGrade(markingDoc)) {
        panel.showError("\u5206\u6570\u5DF2\u586B\u5165\uFF0C\u4F46\u672A\u627E\u5230\u63D0\u4EA4\u6309\u94AE\uFF0C\u8BF7\u624B\u52A8\u63D0\u4EA4");
        return { ok: false, oldIdentity };
      }
      const history = loadHistory().map((entry) => entry.id === lastHistoryId ? { ...entry, result: lastResult, submitted: true } : entry);
      writeJson(STORAGE_KEYS.history, history);
      historyPanel.refresh(history);
      lastResult = null;
      panel.setSubtitle(options.silent ? "\u8FDE\u7EED\u6279\u9605\u4E2D" : "\u5DF2\u63D0\u4EA4\uFF0C\u7B49\u5F85\u4E0B\u4E00\u4EFD");
      if (options.silent) {
        panel.setStage("\u5DF2\u63D0\u4EA4\uFF0C\u7B49\u5F85\u6362\u5377");
      } else {
        panel.toast("\u5DF2\u63D0\u4EA4");
        void waitForNextPaper(oldIdentity).then((changed) => {
          if (changed) void detect();
          else panel.setSubtitle("\u672A\u68C0\u6D4B\u5230\u6362\u5377\uFF0C\u53EF\u7EE7\u7EED\u4EBA\u5DE5\u64CD\u4F5C");
        });
      }
      return { ok: true, oldIdentity };
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
      while (autoMode && !autoStopRequested) {
        count += 1;
        panel.setSubtitle(`\u8FDE\u7EED\u6279\u9605\u4E2D \xB7 \u7B2C ${count} \u4EFD`);
        const graded = await runGrade2();
        if (!graded || !autoMode || autoStopRequested) break;
        const submitted = await submitResult({ silent: true });
        if (!submitted.ok || !autoMode || autoStopRequested) break;
        const changed = await waitForNextPaper(submitted.oldIdentity);
        if (!changed || !autoMode || autoStopRequested) {
          if (autoMode) panel.showError("\u672A\u68C0\u6D4B\u5230\u6362\u5377\uFF0C\u8FDE\u7EED\u6279\u9605\u5DF2\u505C\u6B62");
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
      applyQuestion(readQuestion(doc));
      watchDocument(doc);
    }
    function applyQuestion(question) {
      if (!question) return;
      if (currentQuestion?.questionId === question.questionId && currentQuestion.images.length === question.images.length) return;
      currentQuestion = question;
      lastResult = null;
      panel.setQuestion(question);
      panel.setSubtitle(`\u5DF2\u8BFB\u53D6\u9898\u53F7 ${question.questionId}`);
      panel.clearError();
    }
    function watchDocument(doc) {
      observer?.disconnect();
      if (!doc.body) return;
      observer = new MutationObserver(() => {
        window.clearTimeout(observerTimer);
        observerTimer = window.setTimeout(() => applyQuestion(readQuestion(doc)), 600);
      });
      observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
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
    await detect();
  }
  void bootstrap().catch((error) => {
    console.warn("[\u667A\u9605\u6279\u6539\u52A9\u624B] \u542F\u52A8\u5931\u8D25", error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF");
  });
