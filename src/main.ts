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
    let busy = false;
    // 提交互斥与冷却：连续批阅与手动点击可能同时触发提交，必须串行化。
    let submitting = false;
    let lastSubmitAt = 0;
    const SUBMIT_COOLDOWN = 1500;
    const forcedNotified = new Set();
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
        return probeThinking(draft.pipeline.vlm);
      },
      onImport: (data) => {
        config = merge(DEFAULT_CONFIG, data.config);
        saveConfig(config);
        if (Array.isArray(data.presets)) saveCustomPresets(data.presets);
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
      }
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
        const identity = observedIdentity && observedIdentity.scanRecordId
          ? { scanRecordId: observedIdentity.scanRecordId, topicNumStr: observedIdentity.topicNumStr || "" }
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
        lastHistoryId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        appendHistory({
          id: lastHistoryId,
          createdAt: Date.now(),
          question: historyQuestion(currentQuestion),
          result,
          submitted: false
        }, config.historyLimit);
        historyPanel.refresh(loadHistory());
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
      if (!lastResult || !markingDoc) {
        panel.showError("\u8BF7\u5148\u5B8C\u6210\u6279\u6539\u5E76\u8FDB\u5165\u9605\u5377\u9875\u9762");
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
        const inputs = getScoreInputs(markingDoc);
        const scores = inputs.length > 1 && lastResult.subScores.length === inputs.length ? lastResult.subScores.map((item) => item.score) : [Math.round(lastResult.score * 10) / 10];
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
        const verdict = judgeSubmit(observed, signal);
        if (!verdict.ok) {
          panel.showError(verdict.reason);
          return { ok: false, oldIdentity };
        }
        const history = loadHistory().map((entry) => entry.id === lastHistoryId ? { ...entry, result: lastResult, submitted: true, submitConfirmed: verdict.confirmed } : entry);
        writeJson(STORAGE_KEYS.history, history);
        historyPanel.refresh(history);
        // 把人工改过的分数回写缓存：双评换第二个账号时命中缓存拿到的是最终分，而不是模型原始分。
        if (cache && lastResult.cacheKey) cache.set(lastResult.cacheKey, lastResult);
        lastResult = null;
        updateProgress();
        panel.setSubtitle(options.silent ? "\u8FDE\u7EED\u6279\u9605\u4E2D" : "\u5DF2\u63D0\u4EA4\uFF0C\u7B49\u5F85\u4E0B\u4E00\u4EFD");
        if (options.silent) {
          panel.setStage("\u5DF2\u63D0\u4EA4\uFF0C\u7B49\u5F85\u6362\u5377");
        } else {
          panel.toast(verdict.confirmed ? "\u5DF2\u63D0\u4EA4\uFF08\u5E73\u53F0\u5DF2\u786E\u8BA4\uFF09" : "\u5DF2\u63D0\u4EA4");
          void waitForNextPaper(oldIdentity, oldScan).then((changed) => {
            if (changed) void detect();
            else panel.setSubtitle("\u672A\u68C0\u6D4B\u5230\u6362\u5377\uFF0C\u53EF\u7EE7\u7EED\u4EBA\u5DE5\u64CD\u4F5C");
          });
        }
        return { ok: true, oldIdentity, oldScan };
      } finally {
        submitting = false;
      }
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
    function applyQuestion(question) {
      if (!question) return;
      if (currentQuestion?.questionId === question.questionId
        && currentQuestion.scanRecordId === question.scanRecordId
        && currentQuestion.images.length === question.images.length) return;
      currentQuestion = question;
      lastResult = null;
      panel.setQuestion(question);
      panel.setSubtitle(`\u5DF2\u8BFB\u53D6\u9898\u53F7 ${question.questionId}`);
      panel.clearError();
    }
    // 进度条：页面文本「初评已阅量/任务量」优先，接口计数兜底。
    function updateProgress() {
      const progress = readProgress(markingDoc);
      panel.setProgress(progress ? `\u5DF2\u6279 ${progress.marked} / \u4EFB\u52A1 ${progress.todo}` : "");
    }
    function watchDocument(doc) {
      observer?.disconnect();
      if (!doc.body) return;
      observer = new MutationObserver(() => {
        window.clearTimeout(observerTimer);
        observerTimer = window.setTimeout(() => {
          applyQuestion(readQuestion(doc));
          updateProgress();
        }, 600);
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
    // 缓存写入是合并批量的，页面关闭前补一次落盘，避免丢最后几份结果。
    window.addEventListener("pagehide", () => cache?.flush?.());
    await detect();
  }
  void bootstrap().catch((error) => {
    console.warn("[\u667A\u9605\u6279\u6539\u52A9\u624B] \u542F\u52A8\u5931\u8D25", error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF");
  });
