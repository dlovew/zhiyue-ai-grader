  // src/infra/platforms.ts
  var PRESET_STORAGE_KEY = "zygr.presets.v1";
  var PLATFORM_KEYS_KEY = "zygr.platform.keys.v1";
  var PLATFORM_MODELS_KEY = "zygr.platform.models.v1";

  // 内置预设只提供建议端点/模型与协议档案；用户已填写的 endpoint / model / apiKey 始终优先。
  // authHeader: bearer | api-key | none；全部请求统一为 Chat Completions。
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
      id: "openai",
      label: "OpenAI 官方",
      endpoint: "https://api.openai.com/v1/chat/completions",
      models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
      authHeader: "bearer",
      disableThinkingKey: null,
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "azure-openai",
      label: "Azure OpenAI",
      endpoint: "https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT/chat/completions?api-version=2024-10-21",
      models: ["gpt-4o"],
      authHeader: "api-key",
      disableThinkingKey: null,
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      endpoint: "https://api.deepseek.com/chat/completions",
      models: ["deepseek-chat", "deepseek-reasoner"],
      authHeader: "bearer",
      disableThinkingKey: "thinking",
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
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "moonshot",
      label: "Kimi / Moonshot",
      endpoint: "https://api.moonshot.cn/v1/chat/completions",
      models: ["moonshot-v1-8k-vision-preview", "moonshot-v1-32k", "moonshot-v1-128k"],
      authHeader: "bearer",
      disableThinkingKey: null,
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "dashscope",
      label: "通义千问 / DashScope",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      models: ["qwen-vl-max", "qwen-vl-plus", "qwen-plus"],
      authHeader: "bearer",
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
      disableThinkingKey: "thinking",
      // glm-5.x 始终思考，只接受 low/high/max；关闭仅对 glm-4.x 有效。
      thinkingValues: { low: "low", high: "high", max: "max" },
      jsonModeKey: "response_format",
      stream: false
    },
    {
      id: "volcengine-chat",
      label: "火山方舟（Chat）",
      endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
      models: ["doubao-seed-2-1-lite-260915", "doubao-seed-2-1-turbo-260628"],
      authHeader: "bearer",
      disableThinkingKey: "thinking",
      jsonModeKey: "response_format",
      stream: false
    },
  ];

  function normalizeThinkingValues(value) {
    if (!isRecord(value)) return {};
    const result = {};
    for (const mode of ["off", "low", "high", "max"]) {
      if (Object.prototype.hasOwnProperty.call(value, mode)) result[mode] = value[mode];
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
      jsonModeKey: item.jsonModeKey === null ? null : "response_format",
      stream: Boolean(item.stream)
    }));
  }

  function saveCustomPresets(list) {
    return writeJson(PRESET_STORAGE_KEY, Array.isArray(list) ? list : []);
  }

  function listPlatformPresets() {
    return BUILTIN_PLATFORM_PRESETS.concat(loadCustomPresets());
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
      jsonModeKey: "response_format",
      stream: false
    };
  }

  // 把平台预设与服务上的手动覆盖合并成统一的请求档案。
  // 显式字段（service.endpoint / service.model）优先，预设只在其为空时提供建议值。
  function resolveProfile(service) {
    const src = isRecord(service) ? service : {};
    const preset = getPlatformPreset(src.platform) || getPlatformPreset("custom") || {};
    const compat = isRecord(src.compat) ? src.compat : {};
    const authHeader = ["bearer", "api-key", "none"].includes(compat.authHeader) ? compat.authHeader : (preset.authHeader || "bearer");
    const suggestedModel = Array.isArray(preset.models) && preset.models.length ? preset.models[0] : "";
    return {
      id: preset.id || "custom",
      label: preset.label || "自定义",
      endpoint: normalizeEndpoint(String(src.endpoint || preset.endpoint || "")),
      model: String(src.model || suggestedModel || ""),
      apiKey: String(src.apiKey || ""),
      authHeader,
      authHeaderName: authHeader === "api-key" ? "api-key" : "Authorization",
      disableThinkingKey: Object.prototype.hasOwnProperty.call(compat, "disableThinkingKey") ? compat.disableThinkingKey : (preset.disableThinkingKey ?? null),
      thinkingValues: Object.prototype.hasOwnProperty.call(compat, "thinkingValues") ? normalizeThinkingValues(compat.thinkingValues) : normalizeThinkingValues(preset.thinkingValues),
      jsonModeKey: Object.prototype.hasOwnProperty.call(compat, "jsonModeKey") ? compat.jsonModeKey : (preset.jsonModeKey ?? "response_format"),
      stream: typeof compat.stream === "boolean" ? compat.stream : Boolean(preset.stream)
    };
  }
