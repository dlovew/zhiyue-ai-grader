import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function loadModules(queue = []) {
  const store = new Map();
  const calls = [];
  const responses = [...queue];
  const context = {
    console: { log() {}, warn() {}, error() {} },
    window: {
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(Number(ms) || 0, 1)),
      clearTimeout: (id) => clearTimeout(id)
    },
    GM_getValue: (key) => (store.has(key) ? store.get(key) : undefined),
    GM_setValue: (key, value) => store.set(key, value),
    GM_xmlhttpRequest: (details) => {
      calls.push(details);
      const next = responses.shift() || { status: 200, responseText: '{"choices":[{"message":{"content":"ok"}}]}' };
      setTimeout(() => details.onload(next), 0);
      return { abort() {} };
    }
  };
  context.globalThis = context;
  const files = ['src/infra/storage.ts', 'src/config.ts', 'src/infra/platforms.ts', 'src/infra/api.ts'];
  const code = files.map((rel) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')).join('\n');
  vm.createContext(context);
  vm.runInContext(`${code}\n;globalThis.__exposed = { normalizeEndpoint, modelsEndpoint, fetchModels, detectReasoning, probeThinking, resolveProfile, createApiError, parseProviderError, statusHint, isRetryableError, chatCompletion, listPlatformPresets, getPlatformPreset, upsertPlatformPreset, deletePlatformPreset, getPlatformKey, setPlatformKey, syncKeysFromConfig, getPlatformModel, setPlatformModel, syncModelsFromConfig, parseConfigBackup, DEFAULT_CONFIG };`, context);
  return { api: context.__exposed, calls, store };
}

test('批改结果分数可编辑且提交前应用手动改分', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.match(built, /zygr-score-input/);
  assert.match(built, /getScoreEdits\(\)/);
  assert.match(built, /applyScoreEdits\(\)/);
  assert.match(built, /result: lastResult, submitted: true/);
});

test('面板按钮为紧凑自适应布局', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.match(built, /display: flex; flex-wrap: wrap/);
  assert.match(built, /min-height: 28px/);
  assert.match(built, /font-size: 11px/);
});

test('手动提交的一次提交勾选框已接入确认跳过逻辑', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.match(built, /data-opt="skip-submit-confirm"/);
  assert.match(built, /options\.skipConfirm/);
  assert.match(built, /onSubmit: \(skipConfirm\)/);
});

test('评分标准生成覆盖九大学科且题型提示包含得分点与档次要求', () => {
  const code = readFileSync(join(root, 'src/core/rubric-generator.ts'), 'utf8');
  const context = { console: { log() {}, warn() {}, error() {} } };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${code}\n;globalThis.__gen = { RUBRIC_SUBJECTS, buildRubricPrompt, cleanRubricText, rubricScoringMode };`, context);
  const subjects = Object.keys(context.__gen.RUBRIC_SUBJECTS);
  assert.equal(subjects.length, 9);
  for (const name of ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '政治', '地理']) {
    assert.ok(subjects.includes(name));
  }
  const prompt = context.__gen.buildRubricPrompt({
    subject: '语文', questionType: '作文', question: '以春天为题', answerText: '略', hasImages: false
  });
  assert.match(prompt, /得分点/);
  assert.match(prompt, /扣分规则/);
  assert.match(prompt, /档次划分/);
  assert.equal(context.__gen.cleanRubricText('```text\n一、得分点\n```'), '一、得分点');
});

test('地理综合题按点给分，提示词禁止倒扣并纳入满分', () => {
  const code = readFileSync(join(root, 'src/core/rubric-generator.ts'), 'utf8');
  const context = { console: { log() {}, warn() {}, error() {} } };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${code}\n;globalThis.__gen = { buildRubricPrompt, rubricScoringMode };`, context);
  assert.equal(context.__gen.rubricScoringMode('综合题'), 'point');
  assert.equal(context.__gen.rubricScoringMode('作文'), 'tier');
  const prompt = context.__gen.buildRubricPrompt({
    subject: '地理', questionType: '综合题', question: '分析某地气候成因', answerText: '纬度、海陆、地形', maxScore: 16, hasImages: false
  });
  assert.match(prompt, /\[满分\] 16分/);
  assert.match(prompt, /按点给分，不倒扣/);
  assert.match(prompt, /不得写成倒扣、扣分或负分/);
  assert.match(prompt, /各得分点分值之和必须等于满分 16 分/);
  assert.match(prompt, /按得分点累计给分，不设档次/);
});

test('构建产物包含全部模块边界且顺序正确', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  const markers = [...built.matchAll(/^\s*\/\/ (src\/[^\r\n]+\.ts)$/gm)].map((m) => m[1]);
  assert.equal(markers.length, 18);
  assert.equal(markers[0], 'src/adapters/zhixue.ts');
  assert.equal(markers[5], 'src/infra/platforms.ts');
  assert.equal(markers[6], 'src/infra/api.ts');
  assert.ok(markers.includes('src/core/rubric-generator.ts'));
  assert.equal(markers[markers.length - 1], 'src/main.ts');
});

test('端点归一化覆盖 opencode.ai 基础地址与 Azure 完整地址', () => {
  const { api } = loadModules();
  assert.equal(
    api.normalizeEndpoint('https://opencode.ai/inference/openai/v1'),
    'https://opencode.ai/inference/openai/v1/chat/completions'
  );
  assert.equal(
    api.normalizeEndpoint('https://opencode.ai/inference/openai/v1/chat/completions'),
    'https://opencode.ai/inference/openai/v1/chat/completions'
  );
  const azure = 'https://demo.openai.azure.com/openai/deployments/gpt4/chat/completions?api-version=2024-10-21';
  assert.equal(api.normalizeEndpoint(azure), azure);
});

test('平台档案：opencode.ai 不注入思考字段、Azure 使用 api-key 头', () => {
  const { api } = loadModules();
  const opencode = api.resolveProfile({ platform: 'opencode-ai', endpoint: '', model: '', apiKey: 'k1' });
  assert.equal(opencode.endpoint, 'https://opencode.ai/inference/openai/v1/chat/completions');
  assert.equal(opencode.model, 'hy4-flash-free');
  assert.equal(opencode.disableThinkingKey, null);
  assert.equal(opencode.authHeaderName, 'Authorization');

  const azure = api.resolveProfile({ platform: 'azure-openai', endpoint: '', model: '', apiKey: 'k2' });
  assert.equal(azure.authHeaderName, 'api-key');
  assert.equal(azure.authHeader, 'api-key');
});

test('平台档案：用户显式填写的端点与模型优先于预设建议', () => {
  const { api } = loadModules();
  const profile = api.resolveProfile({
    platform: 'opencode-ai',
    endpoint: 'https://my-proxy.example/v1/chat/completions',
    model: 'my-model',
    apiKey: 'k'
  });
  assert.equal(profile.endpoint, 'https://my-proxy.example/v1/chat/completions');
  assert.equal(profile.model, 'my-model');
});

test('思考模式探测识别响应中的推理内容字段与 token 计数', () => {
  const { api } = loadModules();
  const withField = api.detectReasoning({ choices: [{ message: { content: "answer", reasoning_content: "let me think..." } }] });
  assert.equal(withField.fields.join(','), 'reasoning_content');
  assert.equal(withField.tokens, 0);
  const withTokens = api.detectReasoning({ choices: [{ message: { content: "answer" } }], usage: { completion_tokens_details: { reasoning_tokens: 42 } } });
  assert.equal(withTokens.tokens, 42);
  const clean = api.detectReasoning({ choices: [{ message: { content: "answer" } }] });
  assert.equal(clean.fields.length, 0);
  assert.equal(clean.tokens, 0);
});

test('关闭思考生效时探测返回 ok', async () => {
  const { api, calls } = loadModules([{
    status: 200,
    responseText: JSON.stringify({ choices: [{ message: { content: "鸡23只，兔12只" } }] })
  }]);
  const result = await api.probeThinking({ platform: 'siliconflow', endpoint: '', model: '', apiKey: 'k', disableThinking: true });
  assert.equal(result.ok, true);
  assert.match(result.verdict, /关闭生效/);
  assert.match(result.injected, /enable_thinking/);
  const payload = JSON.parse(calls[0].data);
  assert.equal(payload.enable_thinking, false);
});

test('响应仍含推理内容时探测判定未生效', async () => {
  const { api } = loadModules([{
    status: 200,
    responseText: JSON.stringify({ choices: [{ message: { content: "答案", reasoning_content: "step1 step2" } }] })
  }]);
  const result = await api.probeThinking({ platform: 'custom', endpoint: 'https://example.com/v1/chat/completions', apiKey: 'k', disableThinking: true });
  assert.equal(result.ok, false);
  assert.match(result.verdict, /检测到思考内容/);
});

test('429 错误展示服务商真实原因，不再误报为地址或模型不匹配', () => {
  const { api } = loadModules();
  const error = api.createApiError(429, '{"error":{"message":"rate limit exceeded for free tier"}}');
  assert.equal(error.status, 429);
  assert.equal(error.providerMessage, 'rate limit exceeded for free tier');
  assert.match(error.message, /rate limit exceeded for free tier/);
  assert.doesNotMatch(error.message, /请检查接口地址与模型名称是否匹配/);
  assert.match(error.message, /请求过频/);
});

test('opencode.ai 请求不注入 enable_thinking，保留 Bearer 鉴权', async () => {
  const { api, calls } = loadModules([{
    status: 200,
    responseText: JSON.stringify({ choices: [{ message: { content: 'ok' } }] })
  }]);
  const text = await api.chatCompletion(
    { platform: 'opencode-ai', apiKey: 'test-key' },
    [{ role: 'user', content: 'hi' }],
    { disableThinking: true, retries: 0 }
  );
  assert.equal(text, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(calls[0].data);
  assert.equal(body.model, 'hy4-flash-free');
  assert.equal(Object.hasOwn(body, 'enable_thinking'), false);
});

test('硅基流动档案会注入 enable_thinking 关闭字段', async () => {
  const { api, calls } = loadModules([{
    status: 200,
    responseText: JSON.stringify({ choices: [{ message: { content: 'ok' } }] })
  }]);
  await api.chatCompletion(
    { platform: 'siliconflow', endpoint: '', model: '', apiKey: 'k' },
    [{ role: 'user', content: 'hi' }],
    { disableThinking: true, retries: 0 }
  );
  const body = JSON.parse(calls[0].data);
  assert.equal(body.enable_thinking, false);
});

test('429 只重试一次且错误含服务商原始信息', async () => {
  const rateLimited = {
    status: 429,
    responseText: '{"error":{"message":"free quota exhausted"}}',
    headers: 'retry-after: 0'
  };
  const { api, calls } = loadModules([rateLimited, rateLimited, rateLimited]);
  await assert.rejects(
    api.chatCompletion(
      { platform: 'opencode-ai', apiKey: 'k' },
      [{ role: 'user', content: 'hi' }],
      { retries: 1 }
    ),
    (error) => {
      assert.equal(error.status, 429);
      assert.match(error.message, /free quota exhausted/);
      assert.match(error.configSummary, /opencode-ai \| https:\/\/opencode\.ai\/inference\/openai\/v1\/chat\/completions \| Authorization \| model=hy4-flash-free \| key=…k/);
      return true;
    }
  );
  assert.equal(calls.length, 2);
});

test('模型列表地址由 chat/completions 正确推导', () => {
  const { api } = loadModules();
  assert.equal(
    api.modelsEndpoint('https://opencode.ai/inference/openai/v1/chat/completions'),
    'https://opencode.ai/inference/openai/v1/models'
  );
  assert.equal(api.modelsEndpoint('https://api.siliconflow.cn/v1'), 'https://api.siliconflow.cn/v1/models');
});

test('获取模型列表解析 data 数组中的模型 ID', async () => {
  const { api } = loadModules([{
    status: 200,
    responseText: JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] })
  }]);
  const models = await api.fetchModels({ platform: 'custom', endpoint: 'https://example.com/v1/chat/completions', apiKey: 'k' });
  assert.equal(models.length, 2);
  assert.equal(Array.from(models).join(','), 'model-a,model-b');
});

test('平台模型可记忆并随配置归集', () => {
  const { api } = loadModules();
  assert.equal(api.getPlatformModel('opencode-ai'), '');
  assert.equal(api.setPlatformModel('opencode-ai', 'hy4-flash-free'), true);
  assert.equal(api.getPlatformModel('opencode-ai'), 'hy4-flash-free');
  assert.equal(api.syncModelsFromConfig({ pipeline: { vlm: { platform: 'siliconflow', model: 'Qwen/Qwen2.5-VL-72B-Instruct' } } }), true);
  assert.equal(api.getPlatformModel('siliconflow'), 'Qwen/Qwen2.5-VL-72B-Instruct');
});

test('平台密钥可记忆、覆盖与清空', () => {
  const { api } = loadModules();
  assert.equal(api.getPlatformKey('opencode-ai'), '');
  assert.equal(api.setPlatformKey('opencode-ai', 'sk-1234'), true);
  assert.equal(api.getPlatformKey('opencode-ai'), 'sk-1234');
  assert.equal(api.setPlatformKey('opencode-ai', ''), true);
  assert.equal(api.getPlatformKey('opencode-ai'), '');
});

test('保存配置时按平台归集各服务密钥', () => {
  const { api } = loadModules();
  const config = {
    pipeline: {
      vlm: { platform: 'opencode-ai', apiKey: 'key-a' }
    }
  };
  assert.equal(api.syncKeysFromConfig(config), true);
  assert.equal(api.getPlatformKey('opencode-ai'), 'key-a');
});

test('配置备份校验接受合法结构并拒绝错误格式', () => {
  const { api } = loadModules();
  const backup = JSON.stringify({
    app: 'zygr',
    version: 1,
    config: api.DEFAULT_CONFIG,
    presets: [],
    keys: { 'opencode-ai': 'k' }
  });
  const parsed = api.parseConfigBackup(backup);
  assert.ok(parsed);
  assert.equal(parsed.keys['opencode-ai'], 'k');
  assert.equal(api.parseConfigBackup('{"app":"other"}'), null);
  assert.equal(api.parseConfigBackup('not json'), null);
});

test('自定义预设可新增、更新与删除，内置预设不可覆盖', () => {
  const { api } = loadModules();
  const preset = {
    id: 'my-proxy',
    label: '我的中转',
    endpoint: 'https://proxy.example/v1/chat/completions',
    models: ['model-a'],
    authHeader: 'api-key',
    disableThinkingKey: null,
    jsonModeKey: 'response_format',
    stream: false
  };
  assert.equal(api.upsertPlatformPreset(preset), true);
  assert.equal(api.getPlatformPreset('my-proxy').label, '我的中转');
  assert.equal(api.upsertPlatformPreset({ ...preset, label: '内置覆盖测试', id: 'opencode-ai' }), false);
  assert.equal(api.deletePlatformPreset('opencode-ai'), false);
  assert.equal(api.deletePlatformPreset('my-proxy'), true);
  assert.equal(api.getPlatformPreset('my-proxy'), null);
});
