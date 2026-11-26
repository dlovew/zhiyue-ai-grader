  // src/config.ts
  var DEFAULT_CONFIG = {
    version: 1,
    pipeline: {
      vlm: { endpoint: "", apiKey: "", model: "", platform: "custom", compat: {} },
      thinkingMode: "off",
      outputMode: "standard",
      maxConcurrent: 2,
      maxRpm: 60,
      maxTpm: 6e4,
      timeoutMs: 12e4
    },
    context: {
      question: "",
      answer: "",
      rubric: "",
      maxScore: 0,
      subject: ""
    },
    image: {
      // 图片只做等比缩小：裁切、切条重排、多图合并都会改变版面或牺牲单页分辨率。
      maxEdge: 1600,
      quality: 0.82,
      detail: "high",
      autoBySubject: true
    },
    promptVersion: "zygr-prompt-v2",
    historyLimit: 500,
    // 连续批阅份数上限：无人看管时也不至于一路跑到底。
    continuousLimit: 20,
    cacheTtlDays: 30,
    cacheMaxEntries: 2000
  };
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function merge(base, patch) {
    if (!isRecord(patch) || !isRecord(base)) return base;
    const result = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in result)) continue;
      const current = result[key];
      result[key] = isRecord(current) && isRecord(value) ? merge(current, value) : value;
    }
    return result;
  }
  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }
  // 校验并规整导出的配置备份；格式不符时返回 null。
  function parseConfigBackup(text) {
    try {
      const data = JSON.parse(String(text || ""));
      if (!isRecord(data) || data.app !== "zygr" || !isRecord(data.config)) return null;
      return {
        config: data.config,
        presets: Array.isArray(data.presets) ? data.presets : [],
        keys: isRecord(data.keys) ? data.keys : {},
        models: isRecord(data.models) ? data.models : {},
        thinkingModes: isRecord(data.thinkingModes) ? data.thinkingModes : {}
      };
    } catch {
      return null;
    }
  }
  function loadConfig() {
    const raw = readJson(STORAGE_KEYS.config, {});
    if (!isRecord(raw) || raw.version !== 1) return clone(DEFAULT_CONFIG);
    // merge 只接受默认配置里存在的键，旧版本遗留的裁切/切条/合并开关会被自动丢弃。
    const config = merge(DEFAULT_CONFIG, raw);
    const oldPipeline = isRecord(raw.pipeline) ? raw.pipeline : {};
    if (Object.prototype.hasOwnProperty.call(oldPipeline, "disableThinking") && !Object.prototype.hasOwnProperty.call(oldPipeline, "thinkingMode")) {
      config.pipeline.thinkingMode = normalizeThinkingMode(oldPipeline.disableThinking);
    }
    return config;
  }
  function saveConfig(config) {
    return writeJson(STORAGE_KEYS.config, config);
  }
  function validateConfig(config) {
    const errors = [];
    const { pipeline, context } = config;
    const requireService = (name, service, needKey = true) => {
      if (!service.endpoint.trim()) errors.push(`${name}\uFF1A\u8BF7\u586B\u5199\u63A5\u53E3\u5730\u5740`);
      if (!service.model.trim()) errors.push(`${name}\uFF1A\u8BF7\u586B\u5199\u6A21\u578B\u540D\u79F0`);
      if (needKey && !service.apiKey.trim()) errors.push(`${name}\uFF1A\u8BF7\u586B\u5199 API Key`);
    };
    requireService("\u591A\u6A21\u6001\u670D\u52A1", pipeline.vlm);
    if (!context.answer.trim()) errors.push("\u6279\u6539\u4E0A\u4E0B\u6587\uFF1A\u8BF7\u586B\u5199\u53C2\u8003\u7B54\u6848");
    if (!context.rubric.trim()) errors.push("\u6279\u6539\u4E0A\u4E0B\u6587\uFF1A\u8BF7\u586B\u5199\u8BC4\u5206\u6807\u51C6");
    if (!(context.maxScore > 0)) errors.push("\u6279\u6539\u4E0A\u4E0B\u6587\uFF1A\u8BF7\u586B\u5199\u672C\u65B9\u6848\u6EE1\u5206");
    if (pipeline.maxConcurrent < 1 || pipeline.maxConcurrent > 8) errors.push("\u5E76\u53D1\u4E0A\u9650\u9700\u5728 1\u20138 \u4E4B\u95F4");
    if (pipeline.maxRpm < 1) errors.push("RPM \u9884\u7B97\u9700\u5927\u4E8E 0");
    if (pipeline.maxTpm < 1e3) errors.push("TPM \u9884\u7B97\u9700\u4E0D\u5C0F\u4E8E 1000");
    return errors;
  }
  function resetConfig() {
    saveConfig(DEFAULT_CONFIG);
  }
  function clearAllData() {
    removeKey(STORAGE_KEYS.config);
    removeKey(STORAGE_KEYS.history);
    removeKey(STORAGE_KEYS.cache);
    removeKey(STORAGE_KEYS.stats);
    removeKey(STORAGE_KEYS.thinkingForced);
    removeKey(PRESET_STORAGE_KEY);
    removeKey(PLATFORM_KEYS_KEY);
    removeKey(PLATFORM_MODELS_KEY);
    removeKey(PLATFORM_THINKING_KEY);
    removeKey("zygr.submit.skipConfirm.v1");
  }

