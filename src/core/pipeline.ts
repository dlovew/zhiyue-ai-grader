  // src/core/pipeline.ts
  function configured(service) {
    return Boolean(service.endpoint.trim() && service.model.trim());
  }
  async function runGrade(service, question, maxScore, prompt, images, config, rateLimiter) {
    const content = [
      { type: "text", text: prompt },
      ...images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl, detail: "high" } }))
    ];
    const messages = [
      { role: "system", content: "\u4F60\u662F\u4E25\u683C\u4F46\u516C\u6B63\u7684\u9605\u5377\u52A9\u624B\uFF0C\u53EA\u8F93\u51FA JSON\u3002" },
      { role: "user", content }
    ];
    const raw = await chatCompletion(service, messages, {
      rateLimiter,
      timeoutMs: config.pipeline.timeoutMs,
      jsonMode: true,
      estimatedTokens: estimateTokens(prompt, images.length)
    });
    if (!raw.trim()) throw new Error("\u6A21\u578B\u8FD4\u56DE\u4E3A\u7A7A");
    return parseGrade(raw, maxScore, question.subQuestions);
  }
  async function gradeQuestion(options) {
    const { config, question, cache, rateLimiter } = options;
    config.pipeline.vlm.disableThinking = config.pipeline.disableThinking !== false;
    const startedAt = Date.now();
    const stage = (name, detail) => options.events?.onStage?.(name, detail);
    const reviewReasons = [];
    const maxScore = config.context.maxScore > 0 ? config.context.maxScore : question.maxScore;
    const gradeService = config.pipeline.vlm;
    if (!configured(gradeService)) throw new Error("\u6279\u6539\u670D\u52A1\u672A\u914D\u7F6E\u5B8C\u6574\uFF0C\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u586B\u5199\u591A\u6A21\u6001\u670D\u52A1\u7684\u63A5\u53E3\u5730\u5740\u4E0E\u6A21\u578B");
    stage("\u51C6\u5907\u4F5C\u7B54\u56FE\u7247");
    const preparedList = (await Promise.all(
      question.images.map((src) => prepareImage(src, config.image).catch(() => null))
    )).filter((item) => item !== null);
    const prepared = dedupePrepared(preparedList);
    const removed = prepared.filter((image) => isBlankImage(image) || isWasteImage(image));
    const usable = prepared.filter((image) => !isBlankImage(image) && !isWasteImage(image));
    if (removed.length > 0) reviewReasons.push(`\u5DF2\u5254\u9664 ${removed.length} \u5F20\u5E9F\u56FE`);
    if (usable.length === 0) {
      throw new Error("\u672A\u83B7\u53D6\u5230\u53EF\u7528\u4F5C\u7B54\u56FE\u7247\uFF0C\u8BF7\u7B49\u5F85\u9605\u5377\u9875\u56FE\u7247\u52A0\u8F7D\u5B8C\u6210\u540E\u91CD\u8BD5");
    }
    const prompt = buildGradingPrompt(question, config.context, {
      profile: config.image.profile,
      removedImages: removed.length
    });
    const cacheKey = makeGradeCacheKey({
      question,
      context: config.context,
      model: gradeService.model,
      promptVersion: PROMPT_VERSION
    });
    const cached = cache.get(cacheKey);
    if (cached) {
      stage("\u8BC4\u5206\u7F13\u5B58\u547D\u4E2D");
      return { ...cached, cacheHit: true, elapsedMs: Date.now() - startedAt, cacheKey };
    }
    stage("\u6A21\u578B\u8BC4\u5206", gradeService.model);
    const grade = await runGrade(gradeService, question, maxScore, prompt, usable, config, rateLimiter);
    if (grade.status === "blank" && grade.score > 0) {
      reviewReasons.push("\u8BC6\u522B\u4E3A\u672A\u4F5C\u7B54\u4F46\u7ED9\u51FA\u4E86\u6B63\u5206\uFF0C\u8BF7\u4EBA\u5DE5\u6838\u67E5");
    }
    if (grade.confidence < 0.5) reviewReasons.push("\u6A21\u578B\u7F6E\u4FE1\u5EA6\u8F83\u4F4E\uFF0C\u5EFA\u8BAE\u4EBA\u5DE5\u590D\u6838");
    const result = {
      ...grade,
      maxScore,
      pipeline: "vlm",
      needsReview: reviewReasons.length > 0,
      reviewReasons,
      cacheHit: false,
      cacheKey,
      elapsedMs: Date.now() - startedAt,
      model: gradeService.model,
      createdAt: Date.now()
    };
    cache.set(cacheKey, result);
    return result;
  }
