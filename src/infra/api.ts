  // src/infra/api.ts
  var sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function parseProviderError(text) {
    const value = String(text || "").trim();
    if (!value) return "";
    try {
      const body = JSON.parse(value);
      if (typeof body?.error === "string") return body.error;
      if (typeof body?.error?.message === "string") return body.error.message;
      if (typeof body?.message === "string") return body.message;
      if (typeof body?.detail === "string") return body.detail;
    } catch { /* 非 JSON，继续按文本/HTML 处理 */ }
    if (/<html|<!doctype/i.test(value)) {
      const title = value.match(/<title>([^<]+)<\/title>/i);
      return title ? title[1].trim() : "";
    }
    return value.length <= 400 ? value : "";
  }

  function statusHint(status) {
    if (status === 400) return "\u8BF7\u6C42\u53C2\u6570\u6216\u63D0\u793A\u8BCD\u683C\u5F0F\u53EF\u80FD\u4E0D\u88AB\u8BE5\u6A21\u578B\u652F\u6301";
    if (status === 401 || status === 403) return "\u9274\u6743\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5 API Key \u4E0E\u9274\u6743\u65B9\u5F0F";
    if (status === 404) return "\u63A5\u53E3\u5730\u5740\u6216\u6A21\u578B\u540D\u79F0\u4E0D\u5339\u914D\uFF0C\u8BF7\u6838\u5BF9\u5B8C\u6574\u8DEF\u5F84";
    if (status === 429) return "\u8BF7\u6C42\u8FC7\u9891\u6216\u514D\u8D39\u989D\u5EA6\u5DF2\u7528\u5C3D\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3001\u964D\u4F4E\u5E76\u53D1\u6216\u66F4\u6362\u6A21\u578B";
    if (status >= 500) return "\u670D\u52A1\u7AEF\u5F02\u5E38\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5";
    return "\u8BF7\u68C0\u67E5\u63A5\u53E3\u914D\u7F6E";
  }

  function sampleText(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value) return "";
    return value.length > 500 ? `${value.slice(0, 500)}\u2026` : value;
  }

  function parseRetryAfter(headers) {
    const raw = typeof headers === "string" ? headers : "";
    const match = raw.match(/retry-after\s*:\s*(\d+)/i);
    return match ? Math.min(Math.max(Number(match[1]), 0), 30) * 1000 : 0;
  }

  function createApiError(status, rawText, response) {
    const providerMessage = parseProviderError(rawText);
    const bodySample = sampleText(rawText);
    const message = `\u63A5\u53E3\u8FD4\u56DE HTTP ${status}\uFF08${statusHint(status)}\uFF09${providerMessage ? `\uFF1A${providerMessage}` : ""}${bodySample && bodySample !== providerMessage ? `\n\u54CD\u5E94\u7247\u6BB5\uFF1A${bodySample}` : ""}`;
    const error = new Error(message);
    error.status = status;
    error.providerMessage = providerMessage;
    error.bodySample = bodySample;
    error.retryAfter = parseRetryAfter(response?.headers);
    return error;
  }

  function isRetryableError(error) {
    const status = error?.status;
    if (status === 429 || (status >= 500 && status < 600)) return true;
    const message = String(error?.message || "");
    return message.includes("\u8D85\u65F6") || message.includes("\u7F51\u7EDC\u9519\u8BEF");
  }

  function gmRequest(details) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = 0;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) window.clearTimeout(timer);
        fn(value);
      };
      const request = GM_xmlhttpRequest({
        ...details,
        onload: (response) => {
          // 少数油猴实现会在异常路径下不传 response，这里兜底避免 "reading 'status'" 之类报错。
          const status = Number(response?.status || 0);
          if (status >= 200 && status < 300) return finish(resolve, response);
          finish(reject, createApiError(status, response?.responseText || "", response));
        },
        onerror: (response) => {
          const detail = response?.error ? `\uFF1A${response.error}` : "";
          finish(reject, new Error(`\u7F51\u7EDC\u9519\u8BEF\uFF08HTTP ${response?.status || 0}\uFF09${detail}`));
        },
        ontimeout: () => finish(reject, new Error("\u8BF7\u6C42\u8D85\u65F6"))
      });
      // 本地硬超时兜底：油猴少数实现不回调 ontimeout 时，仍保证 promise 结束、按钮不卡在"测试中"。
      const limit = Number(details.timeout) || 12e4;
      timer = window.setTimeout(() => {
        finish(reject, new Error("\u8BF7\u6C42\u8D85\u65F6\uFF08\u672C\u5730\u4FDD\u62A4\uFF09"));
        try { request?.abort?.(); } catch { /* 忽略中止失败 */ }
      }, limit + 2e3);
    });
  }

  function estimateTokens(text, imageCount = 0) {
    return Math.ceil(text.length / 2) + imageCount * 1e3;
  }

  // 纯文本 token 估算：中日韩汉字、全角标点按 1 token，其余按 4 字符 1 token。
  // 只给「缓存门槛」提示用，不参与限流预算，避免改变既有发送节奏。
  function estimateTextTokens(text) {
    const value = String(text || "");
    let wide = 0;
    let narrow = 0;
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      const isWide = (code >= 0x3000 && code <= 0x303f) || (code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef);
      if (isWide) wide += 1;
      else narrow += 1;
    }
    return Math.ceil(wide + narrow / 4);
  }

  // OpenAI 兼容服务：基础地址自动补全为 chat/completions；带查询串的完整地址原样保留。
  function normalizeEndpoint(endpoint) {
    const value = String(endpoint || "").trim().replace(/\/+$/, "");
    if (!value) return value;
    if (/\/chat\/completions$/i.test(value) || /\/messages$/i.test(value)) return value;
    if (value.includes("?")) return value;
    if (/\/api\/v3$/i.test(value) || /\/v1$/i.test(value) || /^https?:\/\/[^/]+$/i.test(value)) {
      return `${value}/chat/completions`;
    }
    return value;
  }

  var THINKING_MODES = ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"];
  // 兼容旧布尔字段：true=关闭，false=不干预；其余按模式枚举原样保留。
  function normalizeThinkingMode(value) {
    if (value === true || value === "true" || value === "disabled" || value === "close") return "off";
    if (value === false || value === "false" || value === "none" || value === "") return "auto";
    const mode = String(value || "").trim().toLowerCase();
    return THINKING_MODES.indexOf(mode) >= 0 ? mode : "auto";
  }

  // 按思考模式注入字段：off 为关闭，low/high/max 为强度，auto 不干预。
  // 优先用 thinkingFields 展开多个字段（如智谱 thinking.type=enabled + reasoning_effort=low）；
  // 其次用 thinkingValues 单字段映射；都未命中时按字段名给出通用值。
  function thinkingControl(payload, profile, mode) {
    const injected = [];
    const normalized = normalizeThinkingMode(mode);
    if (normalized === "auto") return injected;
    const fields = profile.thinkingFields || {};
    if (Object.prototype.hasOwnProperty.call(fields, normalized)) {
      for (const [fieldKey, fieldValue] of Object.entries(fields[normalized] || {})) {
        payload[fieldKey] = fieldValue;
        injected.push(fieldKey);
      }
      return injected;
    }
    const key = profile.disableThinkingKey;
    if (!key) return injected;
    const values = profile.thinkingValues || {};
    let value;
    if (Object.prototype.hasOwnProperty.call(values, normalized)) {
      value = values[normalized];
    } else if (normalized === "off") {
      if (key === "thinking") value = { type: "disabled" };
      else if (key === "reasoning") value = { effort: "none" };
      else value = false;
    } else if (key === "thinking") {
      value = { type: normalized };
    } else if (key === "reasoning") {
      value = { effort: normalized };
    } else {
      value = normalized;
    }
    payload[key] = value;
    injected.push(key);
    return injected;
  }

  function parseJsonResponse(text) {
    const raw = String(text ?? "").trim();
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }

  function extractContent(body) {
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((part) => String(part?.text ?? "")).join("");
    return "";
  }

  // 读取响应里的用量：DeepSeek 用 prompt_cache_hit_tokens，
  // 其他 OpenAI 兼容平台用 prompt_tokens_details.cached_tokens。无 usage 时返回 null。
  function extractUsage(body) {
    const usage = body?.usage || {};
    const details = usage.prompt_tokens_details || {};
    const prompt = Number(usage.prompt_tokens ?? 0) || 0;
    const completion = Number(usage.completion_tokens ?? 0) || 0;
    const cached = Number(usage.prompt_cache_hit_tokens ?? details.cached_tokens ?? 0) || 0;
    const reasoning = Number(usage.completion_tokens_details?.reasoning_tokens ?? 0) || 0;
    if (!prompt && !completion && !cached) return null;
    return { prompt, completion, cached, reasoning };
  }
  async function chatCompletion(service, messages, options = {}) {
    // 所有请求统一为 Chat Completions：平台档案只影响鉴权头、思考字段与 JSON 模式字段。
    const profile = resolveProfile(service);
    const endpoint = profile.endpoint;
    const payload = { model: profile.model, messages, stream: profile.stream };
    const thinkingMode = normalizeThinkingMode(
      options.thinkingMode !== void 0 ? options.thinkingMode
        : (options.disableThinking !== void 0 ? options.disableThinking
          : (service.thinkingMode !== void 0 ? service.thinkingMode : service.disableThinking))
    );
    const thinkingKeys = thinkingControl(payload, profile, thinkingMode);
    const temperature = options.temperature === void 0 ? 0.2 : options.temperature;
    if (temperature !== null) payload.temperature = temperature;
    // 输出 token 按更高单价计费，限制上限可挡住模型絮叨产生的长尾。
    if (options.maxTokens > 0) payload.max_tokens = Math.round(options.maxTokens);
    let jsonInjectedKey = null;
    if (options.jsonMode && profile.jsonModeKey === "response_format") {
      payload.response_format = { type: "json_object" };
      jsonInjectedKey = "response_format";
    }
    const headers = { "Content-Type": "application/json" };
    if (profile.authHeader === "api-key") headers["api-key"] = profile.apiKey;
    else if (profile.authHeader === "bearer") headers.Authorization = `Bearer ${profile.apiKey}`;
    const retries = options.retries ?? 1;
    let lastError = new Error("\u672A\u77E5\u9519\u8BEF");
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const execute = async () => gmRequest({
        method: "POST",
        url: endpoint,
        headers,
        data: JSON.stringify(payload),
        timeout: options.timeoutMs ?? 12e4
      });
      try {
        const response = options.rateLimiter ? await options.rateLimiter.run(execute, options.estimatedTokens ?? 0) : await execute();
        const body = parseJsonResponse(response.responseText);
        // 有些网关用 HTTP 200 返回错误体，必须显式识别，否则会被误报成「缺少文本内容」。
        if (body?.error && !extractContent(body)) {
          const detail = parseProviderError(response.responseText) || body.error?.message || "\u672A\u77E5\u9519\u8BEF";
          const error = new Error(`\u63A5\u53E3\u8FD4\u56DE HTTP 200 \u4F46\u5E26\u9519\u8BEF\uFF1A${detail}`);
          error.status = 200;
          error.providerMessage = String(detail);
          throw error;
        }
        const content = extractContent(body);
        // usage 是响应自带字段，读取它不会产生任何额外 token。
        if (typeof options.onUsage === "function") {
          try {
            options.onUsage(extractUsage(body));
          } catch { /* 回调异常不影响批改 */ }
        }
        // 思考占满输出预算时正文会被截断：有正文就交给上层「按已产出内容捞分 + 强制人工复核」，
        // 只有连正文都没有（思考独占了全部预算）才在这里作废，绝不把空正文当零分。
        if (body?.choices?.[0]?.finish_reason === "length" && !(typeof content === "string" && content.trim())) {
          const truncated = new Error("\u6A21\u578B\u8F93\u51FA\u88AB\u957F\u5EA6\u4E0A\u9650\u622A\u65AD\uFF08finish_reason=length\uFF09\u4E14\u6CA1\u6709\u53EF\u89E3\u6790\u7684\u6B63\u6587\uFF0C\u672C\u6B21\u7ED3\u679C\u4F5C\u5E9F\uFF1A\u8BF7\u5173\u95ED\u601D\u8003\u6216\u7F29\u77ED\u8BC4\u5206\u6807\u51C6");
          truncated.code = "truncated";
          throw truncated;
        }
        if (typeof content === "string" && content) {
          if (body?.choices?.[0]?.finish_reason === "length" && typeof options.onTruncated === "function") {
            try { options.onTruncated(); } catch { /* 回调异常不影响批改 */ }
          }
          return content;
        }
        throw new Error("\u63A5\u53E3\u54CD\u5E94\u7F3A\u5C11\u6587\u672C\u5185\u5BB9");
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (lastError.status === 400 || lastError.status === 422) {
          let relaxed = false;
          if (jsonInjectedKey) {
            delete payload[jsonInjectedKey];
            jsonInjectedKey = null;
            relaxed = true;
          }
          // 仅「关闭」模式可降级重试；low/high/max 是用户明确选择，降级会静默改变意图。
          if (thinkingKeys.length && thinkingMode === "off") {
            // 仅当报错像是"该模型不支持关闭思考"时才记下模型能力，
            // 避免把其它 400（如参数拼写）误记成强制思考。
            if (/thinking|reasoning|思考|1210/i.test(lastError.message || "")) {
              try {
                options.onThinkingForced?.(profile.model);
              } catch { /* 记忆失败不影响重试 */ }
            }
            for (const key of thinkingKeys) delete payload[key];
            thinkingKeys.length = 0;
            relaxed = true;
          }
          if (relaxed && attempt < retries) continue;
        }
        if (!isRetryableError(lastError) || attempt === retries) break;
        const wait = lastError.retryAfter || Math.min(600 * 2 ** attempt + Math.floor(Math.random() * 200), 5000);
        await sleep(wait);
      }
    }
    lastError.configSummary = `${profile.id} | ${endpoint} | ${profile.authHeaderName} | model=${profile.model || "(空)"} | key=${profile.apiKey ? `…${profile.apiKey.slice(-4)}` : "(空)"}`;
    throw lastError;
  }

  // 从 chat/completions 地址推导同平台的 /models 列表地址。
  function modelsEndpoint(endpoint) {
    const normalized = normalizeEndpoint(endpoint);
    if (!normalized) return "";
    return normalized.replace(/\/chat\/completions$/i, "/models").replace(/\/messages$/i, "/models");
  }

  // 拉取平台可用模型列表；返回模型 ID 字符串数组。
  // 平台没有 /models 端点（GET 返回 405 等）或返回空列表时不做预设回退：
  // 返回空数组并带 manual 标记与提示文案，由界面提示用户手动填写模型名称。
  var MODELS_UNSUPPORTED_MESSAGE = "\u8BE5\u5E73\u53F0\u4E0D\u652F\u6301\u5728\u7EBF\u83B7\u53D6\u6A21\u578B\u5217\u8868\uFF0C\u8BF7\u624B\u52A8\u586B\u5199\u6A21\u578B\u540D\u79F0";
  async function fetchModels(service, timeoutMs = 15e3) {
    const profile = resolveProfile(service);
    // 有些平台（如商汤日日新）的模型列表在独立主机上，预设可覆盖。
    const url = String(profile.modelsUrl || "").trim() || modelsEndpoint(profile.endpoint);
    if (!url) throw new Error("\u8BF7\u5148\u586B\u5199\u63A5\u53E3\u5730\u5740");
    const headers = { "Content-Type": "application/json" };
    if (profile.authHeader === "api-key") headers["api-key"] = profile.apiKey;
    else if (profile.authHeader === "bearer") headers.Authorization = `Bearer ${profile.apiKey}`;
    const manualOnly = (message) => {
      const result = [];
      result.manual = true;
      result.message = message;
      return result;
    };
    let response;
    try {
      response = await gmRequest({ method: "GET", url, headers, timeout: timeoutMs });
    } catch (error) {
      if (error?.status === 405 || error?.status === 404 || error?.status === 400) return manualOnly(MODELS_UNSUPPORTED_MESSAGE);
      throw error;
    }
    const body = parseJsonResponse(response.responseText);
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body?.result) ? body.result : [];
    // 支持图片输入的模型排前面（阅卷必须用视觉模型），其余保持平台返回顺序。
    const entries = list.map((item) => {
      if (typeof item === "string") return { id: item, vision: false };
      const modalities = Array.isArray(item?.input_modalities) ? item.input_modalities : [];
      return { id: item?.id, vision: modalities.includes("image") };
    }).filter((entry) => typeof entry.id === "string" && entry.id.trim());
    entries.sort((a, b) => Number(b.vision) - Number(a.vision));
    const ids = entries.map((entry) => entry.id);
    if (!ids.length) return manualOnly("\u63A5\u53E3\u672A\u8FD4\u56DE\u53EF\u7528\u6A21\u578B\u5217\u8868\uFF0C\u8BF7\u624B\u52A8\u586B\u5199\u6A21\u578B\u540D\u79F0");
    return ids;
  }

  // 检查响应体中是否携带推理/思考内容：字段本身或 reasoning_tokens 计数。
  function detectReasoning(body) {
    const fields = [];
    const choice = body?.choices?.[0] || {};
    const message = choice.message || choice.delta || {};
    for (const key of ["reasoning_content", "reasoning", "thinking", "reasoning_text"]) {
      const value = message[key];
      if (typeof value === "string" && value.trim()) fields.push(key);
      else if (Array.isArray(value) && value.length) fields.push(key);
    }
    const usage = body?.usage || {};
    const details = usage.completion_tokens_details || usage.reasoning_tokens_details || {};
    const tokens = Number(details.reasoning_tokens ?? details.reasoning ?? usage.reasoning_tokens ?? 0) || 0;
    return { fields, tokens };
  }

  // 探测关闭思考是否真正生效：按当前配置发一个需要多步推理的问题，检查响应是否仍含推理内容。
  async function probeThinking(service, rateLimiter) {
    const profile = resolveProfile(service);
    if (!profile.endpoint) throw new Error("\u8BF7\u5148\u586B\u5199\u63A5\u53E3\u5730\u5740");
    const payload = {
      model: profile.model,
      messages: [{ role: "user", content: "\u7B3C\u5B50\u91CC\u6709\u9E21\u548C\u5154\u5171 35 \u4E2A\u5934\u300194 \u53EA\u811A\u3002\u8BF7\u7ED9\u51FA\u63A8\u7406\u8FC7\u7A0B\u548C\u6700\u7EC8\u7B54\u6848\uFF1A\u9E21\u548C\u5154\u5404\u591A\u5C11\u53EA\uFF1F" }],
      stream: false
    };
    const wantedMode = normalizeThinkingMode(service.thinkingMode !== void 0 ? service.thinkingMode : service.disableThinking);
    // 强制思考的模型（如 glm-5.3 系列）直接按默认走，避免关闭参数触发 1210/400。
    const forcedByModel = wantedMode === "off" && isForcedThinkingModel(service.platform || profile.id, profile.model);
    const thinkingMode = forcedByModel ? "auto" : wantedMode;
    const thinkingKeys = thinkingControl(payload, profile, thinkingMode);
    const headers = { "Content-Type": "application/json" };
    if (profile.authHeader === "api-key") headers["api-key"] = profile.apiKey;
    else if (profile.authHeader === "bearer") headers.Authorization = `Bearer ${profile.apiKey}`;
    // 推理模型（如 Qwen3.5-27B）默认长链思考需要时间，但不跟随可能设得很大的批改超时：
    // 测试走独立固定超时（最多 60 秒），且不经过限流器（限流 acquire 在低 TPM 预算下会无限等待，卡住按钮）。
    const probeTimeout = 6e4;
    const response = await gmRequest({ method: "POST", url: profile.endpoint, headers, data: JSON.stringify(payload), timeout: probeTimeout });
    const body = parseJsonResponse(response.responseText);
    const reasoning = detectReasoning(body);
    const hasThinking = reasoning.fields.length > 0 || reasoning.tokens > 0;
    const injected = thinkingKeys.length ? thinkingKeys.join(" / ") : "";
    let verdict;
    let ok;
    if (thinkingMode === "auto") {
      ok = true;
      verdict = forcedByModel
        ? "该模型强制思考、不支持关闭，已按模型默认运行"
        : "未干预思考模式，将使用模型默认设置";
    } else if (thinkingMode === "off") {
      ok = !hasThinking;
      if (!injected) {
        verdict = hasThinking
          ? "该平台未配置关闭字段，无法关闭思考，且响应中检测到思考内容"
          : "未配置关闭字段，响应中也未检测到思考内容（模型可能本身无思考模式）";
      } else {
        verdict = hasThinking
          ? `已发送关闭参数（${injected}），但响应中仍检测到思考内容，可能未生效`
          : `已发送关闭参数（${injected}），响应中未检测到思考内容，关闭生效`;
      }
    } else {
      ok = Boolean(injected);
      verdict = injected
        ? `已发送 ${thinkingMode} 思考强度参数（${injected}），请求被接受；该模式下响应含思考内容属正常现象`
        : `当前平台未配置思考强度字段，无法设置 ${thinkingMode} 模式`;
    }
    const detail = reasoning.fields.length ? `\u68C0\u6D4B\u5B57\u6BB5\uFF1A${reasoning.fields.join(", ")}` : reasoning.tokens > 0 ? `\u63A8\u7406 Token\uFF1A${reasoning.tokens}` : "";
    return {
      ok,
      verdict,
      detail,
      injected,
      mode: thinkingMode,
      bodySample: sampleText(response.responseText)
    };
  }

  // 视觉校验图：白底黑字的大号 4 位随机数字。文本模型看不到数字，只能拒答或瞎猜。
  // 用 canvas 现场生成 PNG，避免依赖外链，也不会被平台的图片域名校验挡住。
  function visionProbeImage() {
    if (typeof document === "undefined" || !document.createElement) return null;
    try {
      const code = Array.from({ length: 4 }, () => Math.floor(Math.random() * 10)).join("");
      const canvas = document.createElement("canvas");
      canvas.width = 480;
      canvas.height = 160;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#111111";
      context.font = '700 96px "PingFang SC", "Microsoft YaHei", Arial, sans-serif';
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(code, canvas.width / 2, canvas.height / 2 + 4);
      const dataUrl = canvas.toDataURL("image/png");
      if (!dataUrl.startsWith("data:image/png")) return null;
      return { code, dataUrl };
    } catch {
      return null;
    }
  }

  // 真·多模态测试：必须能把图里的随机数字读回来，纯文本模型在这一步就会被挡住。
  async function probeVision(service, rateLimiter) {
    const probe = visionProbeImage();
    if (!probe) {
      return { ok: true, skipped: true, verdict: "\u5F53\u524D\u73AF\u5883\u65E0\u6CD5\u751F\u6210\u6D4B\u8BD5\u56FE\u7247\uFF0C\u5DF2\u8DF3\u8FC7\u89C6\u89C9\u6821\u9A8C" };
    }
    const text = await chatCompletion(
      service,
      [{
        role: "user",
        content: [
          { type: "text", text: "\u53EA\u56DE\u590D\u56FE\u7247\u4E2D\u7684 4 \u4F4D\u6570\u5B57\uFF0C\u4E0D\u8981\u89E3\u91CA\u3002" },
          { type: "image_url", image_url: { url: probe.dataUrl, detail: "high" } }
        ]
      }],
      { rateLimiter, timeoutMs: 3e4, retries: 1, maxTokens: 800, estimatedTokens: 300 }
    );
    const digits = String(text || "").replace(/[^0-9]/g, "");
    if (digits.includes(probe.code)) {
      return { ok: true, verdict: "\u56FE\u7247\u8BFB\u53D6\u6B63\u5E38" };
    }
    return {
      ok: false,
      verdict: `\u6A21\u578B\u300C${service.model}\u300D\u672A\u80FD\u8BFB\u53D6\u6D4B\u8BD5\u56FE\u7247\uFF08\u56DE\u590D\uFF1A${sampleText(text) || "\u7A7A"}\uFF09\uFF0C\u53EF\u80FD\u4E0D\u662F\u591A\u6A21\u6001\u6A21\u578B`
    };
  }

  async function testConnection(service, rateLimiter) {
    const result = await probeVision(service, rateLimiter);
    if (!result.ok) throw new Error(result.verdict);
    return true;
  }
