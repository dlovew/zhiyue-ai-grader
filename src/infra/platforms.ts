  // src/infra/platforms.ts
  var PRESET_STORAGE_KEY = "zygr.presets.v1";
  var PLATFORM_KEYS_KEY = "zygr.platform.keys.v1";
  var PLATFORM_MODELS_KEY = "zygr.platform.models.v1";
  var PLATFORM_THINKING_KEY = "zygr.platform.thinking.v1";

  // 思考强度档位名称：各平台可选项不同，统一取这套标签。
  var THINKING_LEVEL_LABELS = {
    off: "\u5173\u95ED\u601D\u8003",
    auto: "\u6A21\u578B\u9ED8\u8BA4\uFF08\u4E0D\u4F20\u5F3A\u5EA6\u53C2\u6570\uFF09",
    minimal: "minimal \u6700\u4F4E",
    low: "low \u4F4E",
    medium: "medium \u4E2D",
    high: "high \u9AD8",
    xhigh: "xhigh \u6781\u9AD8",
    max: "max \u6700\u9AD8"
  };

  // 内置预设只提供建议端点/模型与协议档案；用户已填写的 endpoint / model / apiKey 始终优先。
  // authHeader: bearer | api-key | none；全部请求统一为 Chat Completions。
  // 思考只暴露「关闭 / 模型默认」两档；thinkingFields 是各平台强度到请求字段的映射。
  // disableThinkingKey / jsonModeKey 为 null 表示不向该平台注入对应字段。
  var BUILTIN_PLATFORM_PRESETS = [
    {
      id: "custom",
      label: "自定义（手动填写）",
      endpoint: "",
      models: [],
      authHeader: "bearer",
      disableThinkingKey: null,
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "opencode-ai",
      label: "opencode.ai（OpenAI 兼容）",
      endpoint: "https://opencode.ai/inference/openai/v1/chat/completions",
      models: ["hy4-flash-free"],
      authHeader: "bearer",
      disableThinkingKey: null,
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      endpoint: "https://api.deepseek.com/chat/completions",
      models: ["deepseek-flash", "deepseek-v4-pro"],
      authHeader: "bearer",
      // 官方文档（2026）：thinking.type 控制开关，reasoning_effort 取 none|low|high|max，
      // 省略即"模型默认"（默认开启思考）；minimal→low、medium/xhigh→high。
      thinkingFields: {
        off: { reasoning_effort: "none" },
        low: { reasoning_effort: "low" },
        high: { reasoning_effort: "high" },
        max: { reasoning_effort: "max" }
      },
      disableThinkingKey: "thinking",
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "sensenova",
      label: "商汤日日新（SenseNova）",
      // 官方示例：POST https://token.sensenova.cn/v1/chat/completions，Bearer 鉴权。
      endpoint: "https://token.sensenova.cn/v1/chat/completions",
      models: ["sensenova-6.8-flash"],
      authHeader: "bearer",
      // 模型列表与推理同域：GET https://token.sensenova.cn/v1/models。
      modelsEndpoint: "https://token.sensenova.cn/v1/models",
      // 官方文档只给出 minimal / low / medium / high / xhigh / max 六档，没有关闭字段；
      // 因此「关闭」不注入任何参数（等同模型默认），强度映射保留在 thinkingFields 里。
      thinkingFields: {
        minimal: { reasoning_effort: "minimal" },
        low: { reasoning_effort: "low" },
        medium: { reasoning_effort: "medium" },
        high: { reasoning_effort: "high" },
        xhigh: { reasoning_effort: "xhigh" },
        max: { reasoning_effort: "max" }
      },
      disableThinkingKey: null,
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "siliconflow",
      label: "硅基流动",
      endpoint: "https://api.siliconflow.cn/v1/chat/completions",
      models: ["Qwen/Qwen2.5-VL-72B-Instruct", "Qwen/Qwen2.5-VL-32B-Instruct", "Qwen/Qwen2.5-VL-7B-Instruct"],
      authHeader: "bearer",
      disableThinkingKey: "enable_thinking",
      // 硅基流动 enable_thinking 只接受布尔值；强度用顶层 reasoning_effort。
      // 官方文档：枚举 high|max，其中 low/medium 会被服务端映射为 high。
      thinkingFields: {
        off: { enable_thinking: false },
        low: { reasoning_effort: "high" },
        high: { reasoning_effort: "high" },
        max: { reasoning_effort: "max" }
      },
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "moonshot",
      label: "Kimi / Moonshot",
      endpoint: "https://api.moonshot.cn/v1/chat/completions",
      models: ["moonshot-v1-8k-vision-preview", "moonshot-v1-32k", "moonshot-v1-128k"],
      authHeader: "bearer",
      thinkingFields: { off: { thinking: { type: "disabled" } } },
      disableThinkingKey: "thinking",
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "dashscope",
      label: "通义千问 / DashScope",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      models: ["qwen-vl-max", "qwen-vl-plus", "qwen-plus"],
      authHeader: "bearer",
      thinkingFields: { off: { enable_thinking: false } },
      disableThinkingKey: "enable_thinking",
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "zhipu",
      label: "智谱 GLM",
      endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      models: ["glm-4v-flash", "glm-4-plus", "glm-4-air", "glm-5.3-flash"],
      authHeader: "bearer",
      // 智谱官方格式：thinking.type 只接受 enabled（glm-5.x 强制思考），
      // 强度由独立的 reasoning_effort 字段控制（low/high/max，默认 max）。
      // 关闭写了 disabled 会触发错误码 1210「该模型始终思考，不支持关闭思考」，
      // 所以该平台的「关闭」不注入参数（等同模型默认），避免 400 重试。
      disableThinkingKey: null,
      thinkingFields: {
        low: { thinking: { type: "enabled" }, reasoning_effort: "low" },
        high: { thinking: { type: "enabled" }, reasoning_effort: "high" },
        max: { thinking: { type: "enabled" }, reasoning_effort: "max" }
      },
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "volcengine-chat",
      label: "火山方舟（Chat）",
      endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
      models: ["doubao-seed-2-1-lite-260915", "doubao-seed-2-1-turbo-260628"],
      authHeader: "bearer",
      thinkingFields: { off: { thinking: { type: "disabled" } } },
      disableThinkingKey: "thinking",
      jsonModeKey: "response_format",
      stream: false
    },
  ];

  // 同一平台的不同模型支持的强度档位并不一致，因此界面统一只给「关闭」与「模型默认」两档；
  // thinkingFields 里保留各平台的强度映射，供底层与将来扩展使用。
  var THINKING_LEVELS = ["off", "auto"];
  function getPlatformThinkingLevels() {
    return THINKING_LEVELS.slice();
  }

  function thinkingLevelLabel(level) {
    return THINKING_LEVEL_LABELS[level] || String(level);
  }

  // 只允许两档：关闭(off) 与 不指定强度(auto)；历史配置里的 low/high/max 一律收敛为 auto。
  function clampThinkingLevel(id, value) {
    const mode = String(value || "").trim().toLowerCase();
    return THINKING_LEVELS.indexOf(mode) >= 0 ? mode : "auto";
  }

  function normalizeThinkingValues(value) {
    if (!isRecord(value)) return {};
    const result = {};
    // 覆盖所有平台可能出现的档位，否则 minimal/medium/xhigh 会被丢掉。
    for (const mode of ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      if (Object.prototype.hasOwnProperty.call(value, mode) && isRecord(value[mode])) result[mode] = value[mode];
    }
    return result;
  }

  function loadCustomPresets() {
    const raw = readJson(PRESET_STORAGE_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter((item) => isRecord(item) && typeof item.id === "string" && item.id.trim()).map((item) => ({
      id: item.id,
      label: String(item.label || item.id),
      endpoint: String(item.endpoint || ""),
      models: Array.isArray(item.models) ? item.models.filter((m) => typeof m === "string" && m.trim()) : [],
      authHeader: ["bearer", "api-key", "none"].includes(item.authHeader) ? item.authHeader : "bearer",
      disableThinkingKey: typeof item.disableThinkingKey === "string" && item.disableThinkingKey ? item.disableThinkingKey : null,
      thinkingValues: normalizeThinkingValues(item.thinkingValues),
      thinkingFields: normalizeThinkingValues(item.thinkingFields),
      jsonModeKey: item.jsonModeKey === null ? null : "response_format",
      stream: Boolean(item.stream)
    }));
  }

  function saveCustomPresets(list) {
    return writeJson(PRESET_STORAGE_KEY, Array.isArray(list) ? list : []);
  }

  function listPlatformPresets() {
    return BUILTIN_PLATFORM_PRESETS.slice();
  }

  function getPlatformPreset(id) {
    return listPlatformPresets().find((preset) => preset.id === id) || null;
  }

  function isBuiltinPreset(id) {
    return BUILTIN_PLATFORM_PRESETS.some((preset) => preset.id === id);
  }

  function upsertPlatformPreset(preset) {
    if (!isRecord(preset) || typeof preset.id !== "string" || !preset.id.trim() || isBuiltinPreset(preset.id)) return false;
    const list = loadCustomPresets();
    const normalized = {
      id: preset.id.trim(),
      label: String(preset.label || preset.id).trim(),
      endpoint: String(preset.endpoint || "").trim(),
      models: Array.isArray(preset.models) ? preset.models.filter((m) => String(m).trim()) : [],
      authHeader: ["bearer", "api-key", "none"].includes(preset.authHeader) ? preset.authHeader : "bearer",
      disableThinkingKey: typeof preset.disableThinkingKey === "string" && preset.disableThinkingKey.trim() ? preset.disableThinkingKey.trim() : null,
      thinkingValues: normalizeThinkingValues(preset.thinkingValues),
      thinkingFields: normalizeThinkingValues(preset.thinkingFields),
      jsonModeKey: preset.jsonModeKey === null ? null : "response_format",
      stream: Boolean(preset.stream)
    };
    const index = list.findIndex((item) => item.id === normalized.id);
    if (index >= 0) list[index] = normalized;
    else list.push(normalized);
    return saveCustomPresets(list);
  }

  function deletePlatformPreset(id) {
    if (isBuiltinPreset(id)) return false;
    const list = loadCustomPresets();
    const next = list.filter((item) => item.id !== id);
    if (next.length === list.length) return false;
    return saveCustomPresets(next);
  }

  function loadPlatformKeys() {
    const raw = readJson(PLATFORM_KEYS_KEY, {});
    return isRecord(raw) ? raw : {};
  }

  function savePlatformKeys(map) {
    return writeJson(PLATFORM_KEYS_KEY, isRecord(map) ? map : {});
  }

  function getPlatformKey(id) {
    if (!id) return "";
    const value = loadPlatformKeys()[id];
    return typeof value === "string" ? value : "";
  }

  // 空串表示清除该平台已记忆的密钥，便于切换后"留空"。
  function setPlatformKey(id, key) {
    if (!id) return false;
    const map = loadPlatformKeys();
    const value = String(key || "");
    if (value) map[id] = value;
    else delete map[id];
    return savePlatformKeys(map);
  }

  // 保存配置时把 VLM 服务当前的密钥按平台归集，供下次切换自动带出。
  function syncKeysFromConfig(config) {
    const pipeline = isRecord(config?.pipeline) ? config.pipeline : {};
    const services = [pipeline.vlm];
    const map = loadPlatformKeys();
    let changed = false;
    for (const service of services) {
      if (!isRecord(service) || !service.platform) continue;
      const key = String(service.apiKey || "");
      const previous = map[service.platform];
      if (key && previous !== key) {
        map[service.platform] = key;
        changed = true;
      }
    }
    return changed ? savePlatformKeys(map) : true;
  }

  function loadPlatformModels() {
    const raw = readJson(PLATFORM_MODELS_KEY, {});
    return isRecord(raw) ? raw : {};
  }

  function savePlatformModels(map) {
    return writeJson(PLATFORM_MODELS_KEY, isRecord(map) ? map : {});
  }

  function getPlatformModel(id) {
    if (!id) return "";
    const value = loadPlatformModels()[id];
    return typeof value === "string" ? value : "";
  }

  // 空串表示清除该平台已记忆的模型，切换时回落到预设推荐模型。
  function setPlatformModel(id, model) {
    if (!id) return false;
    const map = loadPlatformModels();
    const value = String(model || "");
    if (value) map[id] = value;
    else delete map[id];
    return savePlatformModels(map);
  }

  // 保存配置时把 VLM 服务当前模型按平台归集，供下次切换自动带出。
  function syncModelsFromConfig(config) {
    const service = isRecord(config?.pipeline) ? config.pipeline.vlm : null;
    if (!isRecord(service) || !service.platform) return true;
    const model = String(service.model || "");
    const previous = getPlatformModel(service.platform);
    if (!model || previous === model) return true;
    return setPlatformModel(service.platform, model);
  }

  function loadPlatformThinkingModes() {
    const raw = readJson(PLATFORM_THINKING_KEY, {});
    return isRecord(raw) ? raw : {};
  }

  function savePlatformThinkingModes(map) {
    return writeJson(PLATFORM_THINKING_KEY, isRecord(map) ? map : {});
  }

  function getPlatformThinkingMode(id) {
    if (!id) return "";
    const value = loadPlatformThinkingModes()[id];
    return typeof value === "string" ? value : "";
  }

  // 空串表示清除记忆，切换时回落到预设默认值（off）。
  function setPlatformThinkingMode(id, mode) {
    if (!id) return false;
    const map = loadPlatformThinkingModes();
    const value = String(mode || "");
    if (value) map[id] = value;
    else delete map[id];
    return writeJson(PLATFORM_THINKING_KEY, map);
  }

  function syncThinkingModesFromConfig(config) {
    const pipeline = isRecord(config?.pipeline) ? config.pipeline : null;
    const service = pipeline && isRecord(pipeline.vlm) ? pipeline.vlm : null;
    if (!service || !service.platform) return true;
    const mode = String(pipeline.thinkingMode || "off");
    if (getPlatformThinkingMode(service.platform) === mode) return true;
    return setPlatformThinkingMode(service.platform, mode);
  }

  // 从某个服务的当前配置生成一个可复用预设（用于"存为预设"）。
  function presetFromService(service, id, label) {
    return {
      id: String(id || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
      label: String(label || id || "自定义预设").trim(),
      endpoint: String(service?.endpoint || "").trim(),
      models: String(service?.model || "").trim() ? [String(service.model).trim()] : [],
      authHeader: "bearer",
      disableThinkingKey: null,
      thinkingValues: {},
      thinkingFields: {},
      jsonModeKey: "response_format",
      stream: false
    };
  }

  // 已下线的内置平台：预设条目已删除，这里只保留鉴权方式，避免历史配置静默退回 bearer 而失效。
  var LEGACY_PLATFORM_AUTH = { "azure-openai": "api-key" };

  // 把平台预设与服务上的手动覆盖合并成统一的请求档案。
  // 显式字段（service.endpoint / service.model）优先，预设只在其为空时提供建议值。
  function resolveProfile(service) {
    const src = isRecord(service) ? service : {};
    const preset = getPlatformPreset(src.platform) || getPlatformPreset("custom") || {};
    const compat = isRecord(src.compat) ? src.compat : {};
    const legacyAuth = LEGACY_PLATFORM_AUTH[String(src.platform || "")];
    const authHeader = ["bearer", "api-key", "none"].includes(compat.authHeader) ? compat.authHeader : (legacyAuth || preset.authHeader || "bearer");
    return {
      id: preset.id || "custom",
      label: preset.label || "自定义",
      endpoint: normalizeEndpoint(String(src.endpoint || preset.endpoint || "")),
      model: String(src.model || ""),
      models: Array.isArray(preset.models) ? preset.models : [],
      // 个别平台的模型列表接口与推理接口不同域，预设可单独指定。
      modelsUrl: String(preset.modelsEndpoint || "").trim(),
      thinkingLevels: getPlatformThinkingLevels(preset.id),
      apiKey: String(src.apiKey || ""),
      authHeader,
      authHeaderName: authHeader === "api-key" ? "api-key" : "Authorization",
      disableThinkingKey: Object.prototype.hasOwnProperty.call(compat, "disableThinkingKey") ? compat.disableThinkingKey : (preset.disableThinkingKey ?? null),
      thinkingValues: Object.prototype.hasOwnProperty.call(compat, "thinkingValues") ? normalizeThinkingValues(compat.thinkingValues) : normalizeThinkingValues(preset.thinkingValues),
      thinkingFields: Object.prototype.hasOwnProperty.call(compat, "thinkingFields") ? normalizeThinkingValues(compat.thinkingFields) : normalizeThinkingValues(preset.thinkingFields),
      jsonModeKey: Object.prototype.hasOwnProperty.call(compat, "jsonModeKey")
        ? compat.jsonModeKey
        : (Object.prototype.hasOwnProperty.call(preset, "jsonModeKey") ? preset.jsonModeKey : "response_format"),
      stream: typeof compat.stream === "boolean" ? compat.stream : Boolean(preset.stream)
    };
  }
