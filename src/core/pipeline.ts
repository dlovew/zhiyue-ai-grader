// src/core/pipeline.ts
function configured(service) {
  return Boolean(service.endpoint.trim() && service.model.trim());
}
async function runGrade(service, question, maxScore, prompt, images, config, rateLimiter, imageOptions) {
  const detail = imageOptions?.detail || "high";
  const content = [
    { type: "text", text: prompt },
    ...images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl, detail } }))
  ];
  const messages = [
    { role: "system", content: "\u4F60\u662F\u4E25\u683C\u4F46\u516C\u6B63\u7684\u9605\u5377\u52A9\u624B\uFF0C\u53EA\u8F93\u51FA JSON\u3002" },
    { role: "user", content }
  ];
  // 输出档位决定基础预算；思考模式会额外消耗输出预算，开启时放宽，避免 JSON 被截断。
  const mode = normalizeOutputMode(config.pipeline?.outputMode);
  const thinking = normalizeThinkingMode(service.thinkingMode);
  const baseTokens = OUTPUT_MODES[mode]?.maxTokens || 800;
  const maxTokens = thinking === "off" ? baseTokens : Math.round(baseTokens * 1.8);
  let usage = null;
  const raw = await chatCompletion(service, messages, {
    rateLimiter,
    timeoutMs: config.pipeline.timeoutMs,
    jsonMode: true,
    maxTokens,
    estimatedTokens: estimateTokens(prompt, images.length),
    onUsage: (value) => {
      if (value) usage = value;
    }
  });
  if (!raw.trim()) throw new Error("\u6A21\u578B\u8FD4\u56DE\u4E3A\u7A7A");
  const grade = parseGrade(raw, maxScore, question.subQuestions);
  grade.usage = usage;
  grade.outputMode = mode;
  return grade;
}
async function gradeQuestion(options) {
  const { config, question, cache, rateLimiter } = options;
  const wanted = normalizeThinkingMode(config.pipeline.thinkingMode !== void 0 ? config.pipeline.thinkingMode : config.pipeline.disableThinking);
  // 各平台档位不同：不在该平台列表里的档位收敛到平台首项（默认关闭）。
  config.pipeline.vlm.thinkingMode = clampThinkingLevel(config.pipeline.vlm.platform, wanted);
  const startedAt = Date.now();
  const stage = (name, detail) => options.events?.onStage?.(name, detail);
  const reviewReasons = [];
  const maxScore = config.context.maxScore > 0 ? config.context.maxScore : question.maxScore;
  const gradeService = config.pipeline.vlm;
  if (!configured(gradeService)) throw new Error("\u6279\u6539\u670D\u52A1\u672A\u914D\u7F6E\u5B8C\u6574\uFF0C\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u586B\u5199\u591A\u6A21\u6001\u670D\u52A1\u7684\u63A5\u53E3\u5730\u5740\u4E0E\u6A21\u578B");
  stage("\u51C6\u5907\u4F5C\u7B54\u56FE\u7247");
  // 学科策略优先于手动尺寸；未选学科时完全按手动参数。
  const imageOptions = resolveImageOptions(config);
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
    throw new Error("\u672A\u83B7\u53D6\u5230\u53EF\u7528\u4F5C\u7B54\u56FE\u7247\uFF0C\u8BF7\u7B49\u5F85\u9605\u5377\u9875\u56FE\u7247\u52A0\u8F7D\u5B8C\u6210\u540E\u91CD\u8BD5");
  }
  const payloadImages = await mergePreparedImages(usable, imageOptions);
  const outputMode = normalizeOutputMode(config.pipeline?.outputMode);
  const prompt = buildGradingPrompt(question, config.context, {
    outputMode,
    removedImages: removed.length
  });
  const cacheKey = makeGradeCacheKey({
    question,
    context: config.context,
    model: gradeService.model,
    image: imageOptions,
    thinkingMode: config.pipeline.thinkingMode,
    outputMode,
    promptVersion: PROMPT_VERSION
  });
  const cached = cache.get(cacheKey);
  if (cached) {
    stage("\u8BC4\u5206\u7F13\u5B58\u547D\u4E2D");
    recordUsage({ graded: true, localHit: true });
    return { ...cached, cacheHit: true, elapsedMs: Date.now() - startedAt, cacheKey, usage: null };
  }
  stage("\u6A21\u578B\u8BC4\u5206", gradeService.model);
  const grade = await runGrade(gradeService, question, maxScore, prompt, payloadImages, config, rateLimiter, imageOptions);
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
  recordUsage({
    graded: true,
    request: true,
    prompt: grade.usage?.prompt || 0,
    cached: grade.usage?.cached || 0,
    completion: grade.usage?.completion || 0
  });
  return result;
}
