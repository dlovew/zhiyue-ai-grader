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
      GM_xmlhttpRequest({
        ...details,
        onload: (response) => {
          if (response.status >= 200 && response.status < 300) return resolve(response);
          reject(createApiError(response.status, response.responseText, response));
        },
        onerror: (response) => reject(new Error(`\u7F51\u7EDC\u9519\u8BEF\uFF08HTTP ${response.status || 0}\uFF09`)),
        ontimeout: () => reject(new Error("\u8BF7\u6C42\u8D85\u65F6"))
      });
    });
  }

  function estimateTokens(text, imageCount = 0) {
    return Math.ceil(text.length / 2) + imageCount * 1e3;
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

  var THINKING_MODES = ["off", "low", "high", "max", "auto"];
  // 兼容旧布尔字段：true=关闭，false=不干预；其余按模式枚举原样保留。
  function normalizeThinkingMode(value) {
    if (value === true || value === "true" || value === "disabled" || value === "close") return "off";
    if (value === false || value === "false" || value === "none" || value === "") return "auto";
    const mode = String(value || "").trim().toLowerCase();
    return THINKING_MODES.indexOf(mode) >= 0 ? mode : "auto";
  }

  // 按思考模式注入字段：off 为关闭，low/high/max 为强度，auto 不干预。
  // 具体值优先取平台预设的 thinkingValues 映射，未映射时按字段名给出通用值。
  function thinkingControl(payload, profile, mode) {
    const injected = [];
    const normalized = normalizeThinkingMode(mode);
    if (normalized === "auto") return injected;
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
        const content = extractContent(parseJsonResponse(response.responseText));
        if (typeof content === "string" && content) return content;
        throw new Error("\u63A5\u53E3\u54CD\u5E94\u7F3A\u5C11\u6587\u672C\u5185\u5BB9");
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (lastError.status === 400) {
          let relaxed = false;
          if (jsonInjectedKey) {
            delete payload[jsonInjectedKey];
            jsonInjectedKey = null;
            relaxed = true;
          }
          // 仅「关闭」模式可降级重试；low/high/max 是用户明确选择，降级会静默改变意图。
          if (thinkingKeys.length && thinkingMode === "off") {
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
  async function fetchModels(service, timeoutMs = 15e3) {
    const profile = resolveProfile(service);
    const url = modelsEndpoint(profile.endpoint);
    if (!url) throw new Error("\u8BF7\u5148\u586B\u5199\u63A5\u53E3\u5730\u5740");
    const headers = { "Content-Type": "application/json" };
    if (profile.authHeader === "api-key") headers["api-key"] = profile.apiKey;
    else if (profile.authHeader === "bearer") headers.Authorization = `Bearer ${profile.apiKey}`;
    const response = await gmRequest({ method: "GET", url, headers, timeout: timeoutMs });
    const body = parseJsonResponse(response.responseText);
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
    const ids = list.map((item) => (typeof item === "string" ? item : item?.id)).filter((id) => typeof id === "string" && id.trim());
    if (!ids.length) throw new Error("\u63A5\u53E3\u672A\u8FD4\u56DE\u53EF\u7528\u6A21\u578B\u5217\u8868");
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
    const thinkingMode = normalizeThinkingMode(service.thinkingMode !== void 0 ? service.thinkingMode : service.disableThinking);
    const thinkingKeys = thinkingControl(payload, profile, thinkingMode);
    const headers = { "Content-Type": "application/json" };
    if (profile.authHeader === "api-key") headers["api-key"] = profile.apiKey;
    else if (profile.authHeader === "bearer") headers.Authorization = `Bearer ${profile.apiKey}`;
    const execute = () => gmRequest({ method: "POST", url: profile.endpoint, headers, data: JSON.stringify(payload), timeout: 2e4 });
    const response = rateLimiter ? await rateLimiter.run(execute, 120) : await execute();
    const body = parseJsonResponse(response.responseText);
    const reasoning = detectReasoning(body);
    const hasThinking = reasoning.fields.length > 0 || reasoning.tokens > 0;
    const injected = thinkingKeys.length ? thinkingKeys.join(" / ") : "";
    let verdict;
    let ok;
    if (thinkingMode === "auto") {
      ok = true;
      verdict = "未干预思考模式，将使用模型默认设置";
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

  async function testConnection(service, rateLimiter) {
    const text = await chatCompletion(
      service,
      [{ role: "user", content: "\u8BF7\u53EA\u56DE\u590D\uFF1Aok" }],
      { rateLimiter, timeoutMs: 15e3, retries: 0, estimatedTokens: 20 }
    );
    return text.trim().length > 0;
  }
