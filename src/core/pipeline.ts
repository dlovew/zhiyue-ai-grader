// src/core/pipeline.ts
function configured(service) {
  return Boolean(service.endpoint.trim() && service.model.trim());
}
async function runGrade(service, question, maxScore, prompt, images, config, rateLimiter, imageOptions, forcedByModel) {
  const detail = imageOptions?.detail || "high";
  const content = [
    { type: "text", text: prompt },
    ...images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl, detail } }))
  ];
  const messages = [
    { role: "system", content: "\u4F60\u662F\u4E25\u683C\u4F46\u516C\u6B63\u7684\u9605\u5377\u52A9\u624B\uFF0C\u53EA\u8F93\u51FA JSON\u3002" },
    { role: "user", content }
  ];
  // 输出档位决定基础预算；思考与正文共享输出预算，强制思考的模型按 3 倍放宽。
  // 上限只是天花板：模型不用就不计费，所以放宽本身不产生额外费用。
  const mode = normalizeOutputMode(config.pipeline?.outputMode);
  const thinking = normalizeThinkingMode(service.thinkingMode);
  const baseTokens = OUTPUT_MODES[mode]?.maxTokens || 800;
  const maxTokens = thinking === "off" ? baseTokens : Math.round(baseTokens * 3);
  let usage = null;
  let forcedDetected = false;
  let truncated = false;
  const raw = await chatCompletion(service, messages, {
    rateLimiter,
    timeoutMs: config.pipeline.timeoutMs,
    jsonMode: true,
    maxTokens,
    estimatedTokens: estimateTokens(prompt, images.length),
    onUsage: (value) => {
      if (value) usage = value;
    },
    // 运行期才发现"该模型不支持关闭思考"：记住它，下次不再浪费一次失败请求。
    onThinkingForced: () => {
      forcedDetected = true;
      markForcedThinking(service.platform, service.model);
    },
    // 正文被截断：先尝试按已产出内容捞分，捞不出确定分数才作废。
    onTruncated: () => {
      truncated = true;
    }
  });
  if (!raw.trim()) throw new Error("\u6A21\u578B\u8FD4\u56DE\u4E3A\u7A7A");
  const grade = parseGrade(raw, maxScore, question.subQuestions);
  if (truncated && grade.scoreUncertain) {
    throw new Error("\u6A21\u578B\u8F93\u51FA\u88AB\u957F\u5EA6\u4E0A\u9650\u622A\u65AD\uFF08finish_reason=length\uFF09\uFF0C\u4E14\u6CA1\u80FD\u4ECE\u5DF2\u4EA7\u51FA\u5185\u5BB9\u4E2D\u89E3\u6790\u51FA\u786E\u5B9A\u5206\u6570\uFF0C\u672C\u6B21\u7ED3\u679C\u4F5C\u5E9F\uFF1A\u8BF7\u5173\u95ED\u601D\u8003\u6216\u7F29\u77ED\u8BC4\u5206\u6807\u51C6");
  }
  if (truncated) grade.truncated = true;
  grade.usage = usage;
  grade.outputMode = mode;
  grade.thinkingForced = forcedDetected || Boolean(forcedByModel);
  return grade;
}
async function gradeQuestion(options) {
  const { config, question, cache, rateLimiter } = options;
  const wanted = normalizeThinkingMode(config.pipeline.thinkingMode !== void 0 ? config.pipeline.thinkingMode : config.pipeline.disableThinking);
  const forcedByModel = wanted === "off" && isForcedThinkingModel(config.pipeline.vlm.platform, config.pipeline.vlm.model);
  // 已知强制思考的模型直接按「模型默认」走，省掉一次注定失败的 400 请求。
  config.pipeline.vlm.thinkingMode = forcedByModel ? "auto" : clampThinkingLevel(config.pipeline.vlm.platform, wanted);
  const startedAt = Date.now();
  const stage = (name, detail) => options.events?.onStage?.(name, detail);
  const reviewReasons = [];
  const maxScore = config.context.maxScore > 0 ? config.context.maxScore : question.maxScore;
  const gradeService = config.pipeline.vlm;
  if (!configured(gradeService)) throw new Error("\u6279\u6539\u670D\u52A1\u672A\u914D\u7F6E\u5B8C\u6574\uFF0C\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u586B\u5199\u591A\u6A21\u6001\u670D\u52A1\u7684\u63A5\u53E3\u5730\u5740\u4E0E\u6A21\u578B");
  // 学科策略优先于手动尺寸；未选学科时完全按手动参数。
  const imageOptions = resolveImageOptions(config);
  const outputMode = normalizeOutputMode(config.pipeline?.outputMode);
  // 缓存键只依赖原始作答图地址与批改参数，与图片预处理结果无关。
  // 先查缓存能在命中时跳过下载与缩放：双评第二遍几乎不用等图。
  const cacheKey = makeGradeCacheKey({
    question,
    context: config.context,
    model: gradeService.model,
    image: imageOptions,
    thinkingMode: gradeService.thinkingMode,
    outputMode,
    // 接口身份（scanRecordId + 题号）优先，跨账号一致；没有时缓存键退回图片地址归一化。
    identity: question.identity || null,
    promptVersion: PROMPT_VERSION
  });
  const cached = cache.get(cacheKey);
  if (cached) {
    stage("\u8BC4\u5206\u7F13\u5B58\u547D\u4E2D");
    recordUsage({ graded: true, localHit: true });
    return { ...cached, cacheHit: true, elapsedMs: Date.now() - startedAt, cacheKey, usage: null };
  }
  stage("\u51C6\u5907\u4F5C\u7B54\u56FE\u7247");
  const preparedList = (await Promise.all(
    question.images.map((src) => prepareImage(src, imageOptions).catch(() => null))
  )).filter((item) => item !== null);
  const prepared = dedupePrepared(preparedList);
  const removed = prepared.filter((image) => isBlankImage(image) || isWasteImage(image));
  const usable = prepared.filter((image) => !isBlankImage(image) && !isWasteImage(image));
  if (removed.length > 0) reviewReasons.push(`\u5DF2\u5254\u9664 ${removed.length} \u5F20\u5E9F\u56FE`);
  const lowResCount = usable.filter((image) => image.lowRes).length;
  if (lowResCount > 0) reviewReasons.push(`\u6709 ${lowResCount} \u5F20\u56FE\u7247\u5206\u8FA8\u7387\u504F\u4F4E\uFF0C\u624B\u5199\u5C0F\u5B57\u53EF\u80FD\u8BC6\u522B\u4E0D\u51C6`);
  if (imageOptions.detail === "low") reviewReasons.push("\u56FE\u7247\u4F7F\u7528\u4F4E\u7CBE\u5EA6\u6A21\u5F0F\uFF0C\u5206\u6570\u5EFA\u8BAE\u4EBA\u5DE5\u590D\u6838");
  if (usable.length === 0) {
    throw new Error("\u672A\u83B7\u53D6\u5230\u53EF\u7528\u4F5C\u7B54\u56FE\u7247\uFF1A\u56FE\u7247\u94FE\u63A5\u53EF\u80FD\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u6309\u6D4F\u89C8\u5668 F5 \u5237\u65B0\u5F53\u524D\u9605\u5377\u9875\uFF0C\u6216\u9000\u51FA\u540E\u91CD\u65B0\u8FDB\u5165\u9605\u5377\u4EFB\u52A1\u518D\u8BD5");
  }
  const payloadImages = usable;
  const prompt = buildGradingPrompt(question, config.context, {
    outputMode,
    removedImages: removed.length
  });
  stage("\u6A21\u578B\u8BC4\u5206", gradeService.model);
  const grade = await runGrade(gradeService, question, maxScore, prompt, payloadImages, config, rateLimiter, imageOptions, forcedByModel);
  // 同一道题连续多份都拿不到前缀命中时，在结果里留一个可点击的排查入口。
  // 只读响应里的 usage，不改变请求参数，也不额外发请求。
  const probeUsage = grade.usage;
  if (probeUsage && Number(probeUsage.prompt) > 0) {
    const probe = noteCacheProbe({
      platform: gradeService.platform,
      model: gradeService.model,
      questionKey: question.questionId || question.topicNumStr || "当前题目",
      prefixHash: hashString(prompt),
      cached: probeUsage.cached,
      promptTokens: probeUsage.prompt,
      textTokens: estimateTextTokens(prompt)
    });
    if (probe.streak >= 3) {
      grade.cacheMiss = {
        streak: probe.streak,
        driftCount: probe.driftCount,
        textTokens: probe.textTokens,
        promptTokens: probe.promptTokens,
        imageCount: payloadImages.length,
        platform: gradeService.platform || "custom",
        model: gradeService.model,
        modelEverHit: modelCacheEverHit(gradeService.platform, gradeService.model)
      };
    }
  }
  if (grade.status === "blank" && grade.score > 0) {
    reviewReasons.push("\u8BC6\u522B\u4E3A\u672A\u4F5C\u7B54\u4F46\u7ED9\u51FA\u4E86\u6B63\u5206\uFF0C\u8BF7\u4EBA\u5DE5\u6838\u67E5");
  }
  // 无法辨认却给了分：多半是模型凭印象打分，必须人工确认。
  if (grade.status === "illegible" && grade.score > 0) {
    reviewReasons.push("\u8BC6\u522B\u4E3A\u65E0\u6CD5\u8FA8\u8BA4\u5374\u7ED9\u4E86\u6B63\u5206\uFF0C\u8BF7\u4EBA\u5DE5\u6838\u5B9E");
  }
  if (grade.scoreUncertain) reviewReasons.push("\u672A\u80FD\u4ECE\u6A21\u578B\u8F93\u51FA\u4E2D\u786E\u5B9A\u5206\u6570\uFF0C\u8BF7\u4EBA\u5DE5\u6838\u5B9A");
  // 截断捞回的结果：总分可用但明细/评语可能不全，必须人工复核，不允许直接提交。
  if (grade.truncated) reviewReasons.push("\u6A21\u578B\u8F93\u51FA\u88AB\u622A\u65AD\uFF0C\u5DF2\u6309\u5DF2\u4EA7\u51FA\u5185\u5BB9\u89E3\u6790\uFF0C\u8BF7\u4EBA\u5DE5\u590D\u6838");
  if (grade.scoreAdjusted) reviewReasons.push("\u603B\u5206\u4E0E\u5C0F\u9898\u5408\u8BA1\u4E0D\u4E00\u81F4\uFF0C\u5DF2\u6309\u5C0F\u9898\u91CD\u7B97");
  const missingSubs = question.subQuestions.length - grade.subScores.length;
  if (question.subQuestions.length > 0 && missingSubs > 0) {
    reviewReasons.push(`\u6709 ${missingSubs} \u4E2A\u5C0F\u9898\u672A\u8FD4\u56DE\u5206\u6570\uFF0C\u8BF7\u6838\u5BF9`);
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
  recordUsage({
    graded: true,
    request: true,
    prompt: grade.usage?.prompt || 0,
    cached: grade.usage?.cached || 0,
    completion: grade.usage?.completion || 0,
    reasoning: grade.usage?.reasoning || 0
  });
  return result;
}
