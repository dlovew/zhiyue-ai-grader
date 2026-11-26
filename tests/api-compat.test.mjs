import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { MODULES, VERSION } from '../build.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// 断言打在源文件上：改一个模块不该牵连一堆「打包产物里有没有这句话」的脆弱用例。
function readSource(rel) {
  return readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
}

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
  const files = ['src/infra/storage.ts', 'src/config.ts', 'src/infra/platforms.ts', 'src/infra/api.ts', 'src/infra/rate-limit.ts', 'src/core/prompt.ts', 'src/core/parse.ts', 'src/core/pipeline.ts'];
  const code = files.map((rel) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')).join('\n');
  vm.createContext(context);
  vm.runInContext(`${code}\n;globalThis.__exposed = { normalizeEndpoint, modelsEndpoint, fetchModels, detectReasoning, probeThinking, resolveProfile, createApiError, parseProviderError, statusHint, isRetryableError, chatCompletion, normalizeThinkingMode, thinkingControl, listPlatformPresets, getPlatformPreset, getPlatformKey, setPlatformKey, syncKeysFromConfig, getPlatformModel, setPlatformModel, syncModelsFromConfig, getPlatformThinkingMode, setPlatformThinkingMode, syncThinkingModesFromConfig, loadPlatformThinkingModes, savePlatformThinkingModes, parseConfigBackup, DEFAULT_CONFIG, getPlatformThinkingLevels, thinkingLevelLabel, clampThinkingLevel, THINKING_LEVEL_LABELS, isForcedThinkingModel, markForcedThinking, loadForcedThinking, runGrade, RateLimiter };`, context);
  return { api: context.__exposed, calls, store };
}

// 解析/缓存/提示词模块单独装载：不依赖 DOM 与网络。
function loadCore() {
  const store = new Map();
  const context = {
    console: { log() {}, warn() {}, error() {} },
    window: {
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(Number(ms) || 0, 1)),
      clearTimeout: (id) => clearTimeout(id)
    },
    GM_getValue: (key) => (store.has(key) ? store.get(key) : undefined),
    GM_setValue: (key, value) => store.set(key, value),
    URL
  };
  context.globalThis = context;
  const files = [
    'src/infra/storage.ts',
    'src/config.ts',
    'src/infra/image.ts',
    'src/core/cache.ts',
    'src/core/submit.ts',
    'src/core/export.ts',
    'src/core/prompt.ts',
    'src/core/parse.ts'
  ];
  const code = files.map((rel) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')).join('\n');
  vm.createContext(context);
  vm.runInContext(`${code}\n;globalThis.__core = { CacheStore, makeGradeCacheKey, compactCacheResult, stableImageKey, parseGrade, buildGradingPrompt, PROMPT_VERSION, OUTPUT_MODES, normalizeOutputMode, resolveImageOptions, SUBJECT_IMAGE_PROFILES, loadConfig, loadUsageStats, recordUsage, DEFAULT_CONFIG, STORAGE_KEYS, toCsv, toHtml, summarizeEntries, summaryText, entryUsage, entryElapsed, entryHitText, judgeSubmit };`, context);
  return { core: context.__core, store };
}

// 导出用的最小历史样本：一条命中缓存、一条带思考 token 的真实请求。
function exportSample() {
  return [
    {
      id: 'h1',
      createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
      submitted: true,
      question: { questionId: 'Q1', subQuestions: [{ label: '第1问', maxScore: 2 }] },
      result: {
        pipeline: 'vlm',
        model: 'glm-4v-flash',
        status: 'legible',
        score: 4,
        maxScore: 5,
        subScores: [{ label: '第1问', score: 2, maxScore: 2, reason: '' }],
        reason: '依据基本正确',
        needsReview: false,
        reviewReasons: [],
        cacheHit: true,
        elapsedMs: 12,
        usage: null
      }
    },
    {
      id: 'h2',
      createdAt: Date.UTC(2026, 0, 2, 3, 5, 6),
      submitted: false,
      reviewedAt: Date.UTC(2026, 0, 2, 4, 0, 0),
      confirmedScore: 2.5,
      reviewNote: '已核对',
      question: {
        questionId: 'Q2,含逗号"引号',
        topicNumStr: '43,1',
        subQuestions: [{ label: '第1问', maxScore: 2 }],
        identity: { scanRecordId: 'S1', userCode: 'U100', topicNumStr: '43,1' }
      },
      result: {
        pipeline: 'vlm',
        model: 'qwen-vl-max',
        status: 'legible',
        score: 3,
        maxScore: 5,
        subScores: [{ label: '第1问', score: 1, maxScore: 2, reason: '依据不符' }],
        reason: '部分扣分',
        needsReview: true,
        reviewReasons: ['模型置信度较低，建议人工复核'],
        cacheHit: false,
        elapsedMs: 2400,
        usage: { prompt: 1000, cached: 800, completion: 180, reasoning: 60 }
      }
    }
  ];
}

// 按 CSV 引号规则切分单行，避免逗号/引号出现在字段里导致列数误判。
function splitCsvLine(line) {
  return line.match(/"(?:[^"]|"")*"/g) || [];
}

test('批改结果分数可编辑且提交前应用手动改分', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.match(built, /zygr-score-input/);
  assert.match(built, /getScoreEdits\(\)/);
  assert.match(built, /applyScoreEdits\(\)/);
  // 提交等待回执期间页面可能换卷、lastResult 会被清空，写历史必须用先抓下来的局部快照
  assert.match(built, /const submittedResult = lastResult;/);
  assert.match(built, /result: submittedResult, submitted: true/);
});

test('双评第二遍先查缓存再取图，命中后不再下载图片', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  const start = built.indexOf('async function gradeQuestion(');
  assert.ok(start > 0);
  const body = built.slice(start, start + 5000);
  const cacheIndex = body.indexOf('cache.get(cacheKey)');
  assert.ok(cacheIndex > 0, '批改流程里应有缓存查询');
  assert.ok(cacheIndex < body.indexOf('prepareImage(src, imageOptions)'), '缓存查询应在图片下载之前');
  assert.ok(cacheIndex < body.indexOf('buildGradingPrompt(question'), '缓存查询应在构建提示词之前');
});

test('提交后把人工改过的分数回写缓存，供双评第二账号命中', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.match(built, /if \(cache && submittedResult\?\.cacheKey\) cache\.set\(submittedResult\.cacheKey, submittedResult\)/);
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
  // 期望值直接取构建清单：新增模块只需要改 build.mjs 一处，不会再因为「20 变 21」而挂。
  assert.deepEqual(markers, MODULES);
  assert.equal(markers[0], 'src/adapters/zhixue.ts');
  assert.equal(markers[markers.length - 1], 'src/main.ts');
});

test('版本号只有 version.json 一个来源', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  const banner = built.match(/\/\/ @version\s+(\S+)/);
  assert.ok(banner, 'banner 里必须有 @version');
  assert.equal(banner[1], VERSION);
  assert.match(built, new RegExp(`var ZYGR_VERSION = ${JSON.stringify(VERSION)};`));
  assert.match(built, /id="zygr-version"/);
  const panel = readSource('src/ui/panel.ts');
  assert.match(panel, /typeof ZYGR_VERSION === "string"/);
  const readme = readSource('README.md');
  assert.match(readme, new RegExp(`- 版本：\`${VERSION.replace(/\./g, '\\.')}\``));
  assert.match(readme, new RegExp(`面板标题右侧.*v${VERSION.replace(/\./g, '\\.')}`));
});

function loadZhixue({ visibility = 'visible', imageSrc = 'https://img.example/a.png', imageReady = true } = {}) {
  const image = {
    src: imageSrc,
    currentSrc: imageSrc,
    complete: imageReady,
    naturalWidth: imageReady ? 800 : 0,
    naturalHeight: imageReady ? 600 : 0,
    getClientRects: () => (visibility === 'hidden' ? [] : [{ width: 100, height: 100 }]),
    ownerDocument: null
  };
  const view = { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) };
  image.ownerDocument = { visibilityState: visibility, defaultView: view };
  const docRoot = { querySelectorAll: (sel) => (sel.includes('topicImg') || sel.includes('enhance-definition') ? [image] : []) };
  const mainDocument = { visibilityState: visibility, querySelectorAll: () => [], ownerDocument: null };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    window: { setTimeout: (fn) => setTimeout(fn, 0), location: { href: 'https://www.zhixue.com/', hostname: 'www.zhixue.com', search: '' } },
    document: mainDocument,
    URL,
    URLSearchParams,
    MutationObserver: class { observe() {} disconnect() {} },
    unsafeWindow: { document: mainDocument }
  };
  context.globalThis = context;
  const code = readFileSync(join(root, 'src', 'adapters', 'zhixue.ts'), 'utf8').replace(/\r\n/g, '\n');
  vm.createContext(context);
  vm.runInContext(`${code}\n;globalThis.__api = { visible, snapshotFrom, answerSnapshot };`, context);
  return { api: context.__api, image, docRoot, mainDocument };
}

// 接口观察器单独装载：适配器 + hook，只测解析与身份，不碰真实 XHR。
function loadHook() {
  const emptyDoc = { visibilityState: 'visible', querySelector: () => null, querySelectorAll: () => [] };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    window: { setTimeout: (fn) => setTimeout(fn, 0) },
    document: emptyDoc,
    unsafeWindow: { document: emptyDoc },
    URL
  };
  context.globalThis = context;
  const code = ['src/adapters/zhixue.ts', 'src/adapters/zhixue-hook.ts']
    .map((rel) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n'))
    .join('\n');
  vm.createContext(context);
  vm.runInContext(`${code}\n;globalThis.__hook = { handleHookResponse, hookField, hookIdentity, hookUrlsFrom, freshAnswerImages, currentHookIdentity, nextHookIdentity, hookState, hookActive, commitFeed, pushCommitSignal, resetCommitSignal, waitCommitSignal, resolveMaxScore, checkMaxScore, currentScanRecordId, hookProgress, readProgress };`, context);
  return context.__hook;
}

// 2026-11 真机取样（字段已裁剪，结构一致）
const REAL_DETAIL = {
  code: 200,
  msg: '操作成功',
  data: {
    topicNum: '43,1',
    topicInfo: {
      detail: {
        scanRecordId: '91118d7a-ef5d-4d15-9a1e-e03cd5df23f7',
        userCode: '14801889',
        topicNums: [43],
        topicImageIds: ['https://zhixue-sc.oss-cn-hangzhou.aliyuncs.com/a.jpg?Expires=1795682628&Signature=x&x-oss-process=image%2Fcrop%2Cx_91%2Cy_941%2Cw_913%2Ch_67'],
        paperImgIds: ['scDV2dv_marking/scanFile/a.jpg']
      },
      item: { subTopicScore: 2 },
      topicNumStr: '43,1',
      topicNum: [43, 1]
    },
    hasPrev: true,
    hasNext: false,
    markingCount: 533,
    teacherTopic: [
      { topicNumStr: '43,1', teacherTodo: 147, teacherMarked: 533 },
      { topicNumStr: '43,2', teacherTodo: 147, teacherMarked: 0 }
    ],
    cutBlock: { subTopicScore: 2, topicNumStr: '43,1', dispTopic: '43(1)' }
  }
};
const REAL_NEXT = {
  code: 200,
  data: {
    topicNum: null,
    topicInfo: null,
    nextTopicInfo: {
      detail: {
        scanRecordId: '0dcc94c0-2cf6-4d6a-b599-ba4585f6e503',
        userCode: '14801978',
        topicImageIds: ['https://zhixue-sc.oss-cn-hangzhou.aliyuncs.com/b.jpg?Expires=1795682629&Signature=y']
      },
      topicNumStr: '43,1'
    },
    hasPrev: true,
    hasNext: false,
    markingCount: 533
  }
};

test('后台标签页（visibility=hidden）图片虽无 getClientRects 仍判定可见', () => {
  const { api, image } = loadZhixue({ visibility: 'hidden' });
  assert.equal(api.visible(image), true);
});

test('换卷 identity 在图片未加载完成时仍可计算（ready=false 但有 identity）', () => {
  const { api, docRoot } = loadZhixue({ visibility: 'visible', imageSrc: 'https://img.example/old.png', imageReady: false });
  const snap = api.snapshotFrom(docRoot);
  assert.ok(snap.identity);
  assert.equal(snap.ready, false);
});

test('换卷等待在后台暂停计时的源码逻辑存在', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.match(built, /visibilityState === "hidden"/);
  assert.match(built, /if \(!hidden\) remaining -= now - lastTick/);
  assert.match(built, /snapshot\.identity && snapshot\.identity !== oldIdentity/);
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

test('平台档案：opencode.ai 不注入思考字段、旧 Azure 配置仍用 api-key 头', () => {
  const { api } = loadModules();
  const opencode = api.resolveProfile({ platform: 'opencode-ai', endpoint: '', model: '', apiKey: 'k1' });
  assert.equal(opencode.endpoint, 'https://opencode.ai/inference/openai/v1/chat/completions');
  assert.equal(opencode.model, '');
  assert.equal(opencode.disableThinkingKey, null);
  assert.equal(opencode.authHeaderName, 'Authorization');

  // 内置的 OpenAI 官方 / Azure OpenAI 预设已移除，历史配置只保留鉴权兼容。
  assert.equal(api.getPlatformPreset('openai'), null);
  assert.equal(api.getPlatformPreset('azure-openai'), null);
  const azure = api.resolveProfile({ platform: 'azure-openai', endpoint: '', model: '', apiKey: 'k2' });
  assert.equal(azure.authHeaderName, 'api-key');
  assert.equal(azure.authHeader, 'api-key');
});

test('硅基流动强度模式用 reasoning_effort，关闭仍用布尔 enable_thinking', async () => {
  const { api, calls } = loadModules([{
    status: 200,
    responseText: JSON.stringify({ choices: [{ message: { content: 'ok' } }] })
  }, {
    status: 200,
    responseText: JSON.stringify({ choices: [{ message: { content: 'ok' } }] })
  }, {
    status: 200,
    responseText: JSON.stringify({ choices: [{ message: { content: 'ok' } }] })
  }]);
  const service = { platform: 'siliconflow', endpoint: '', model: 'Qwen/Qwen2.5-VL-7B-Instruct', apiKey: 'k' };
  await api.chatCompletion({ ...service, thinkingMode: 'low' }, [{ role: 'user', content: 'hi' }], { retries: 0 });
  await api.chatCompletion({ ...service, thinkingMode: 'max' }, [{ role: 'user', content: 'hi' }], { retries: 0 });
  await api.chatCompletion({ ...service, thinkingMode: 'off' }, [{ role: 'user', content: 'hi' }], { retries: 0 });
  const low = JSON.parse(calls[0].data);
  const max = JSON.parse(calls[1].data);
  const off = JSON.parse(calls[2].data);
  assert.equal(low.reasoning_effort, 'high');
  assert.equal(Object.hasOwn(low, 'enable_thinking'), false);
  assert.equal(max.reasoning_effort, 'max');
  assert.equal(off.enable_thinking, false);
  assert.equal(Object.hasOwn(off, 'reasoning_effort'), false);
});

test('思考模式按平台记忆：写入、读取、清除与配置同步', () => {
  const { api } = loadModules();
  assert.equal(api.setPlatformThinkingMode('zhipu', 'low'), true);
  assert.equal(api.getPlatformThinkingMode('zhipu'), 'low');
  assert.equal(api.getPlatformThinkingMode('dashscope'), '');
  assert.equal(api.setPlatformThinkingMode('zhipu', ''), true);
  assert.equal(api.getPlatformThinkingMode('zhipu'), '');
  assert.equal(api.syncThinkingModesFromConfig({ pipeline: { vlm: { platform: 'siliconflow' }, thinkingMode: 'max' } }), true);
  assert.equal(api.getPlatformThinkingMode('siliconflow'), 'max');
  const backup = api.parseConfigBackup(JSON.stringify({ app: 'zygr', config: {}, thinkingModes: { moonshot: 'high' } }));
  assert.equal(backup.thinkingModes.moonshot, 'high');
});

test('思考模式探测用固定 60 秒超时且绕开限流器，不会被大配置超时拖住', async () => {
  const { api, calls } = loadModules([{
    status: 200,
    responseText: JSON.stringify({ choices: [{ message: { content: '鸡 23 兔 12' } }] })
  }]);
  const result = await api.probeThinking({ platform: 'siliconflow', endpoint: 'https://api.siliconflow.cn/v1/chat/completions', model: 'Qwen/Qwen3.5-27B', apiKey: 'k', thinkingMode: 'auto', timeoutMs: 3e5 });
  assert.equal(result.ok, true);
  assert.equal(calls[0].timeout, 6e4);
});

test('gmRequest 有本地硬超时兜底，油猴不回调时按钮不永久挂起', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.match(built, /settled/);
  assert.match(built, /\\u672C\\u5730\\u4FDD\\u62A4/);
  assert.match(built, /request\?\.abort\?\.\(\)/);
});

test('思考模式测试按钮显示进行秒数', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.match(built, /setInterval\(\(\) =>/);
  assert.match(built, /Math\.round\(\(Date\.now\(\) - startedAt\) \/ 1000\)/);
  assert.match(built, /clearInterval\(ticker\)/);
});

test('一次提交勾选状态记忆：构造恢复与变更持久化', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.match(built, /zygr\.submit\.skipConfirm\.v1/);
  assert.match(built, /readJson\(SKIP_CONFIRM_KEY, false\) === true/);
  assert.match(built, /writeJson\(SKIP_CONFIRM_KEY, Boolean\(target\.checked\)\)/);
  assert.match(built, /removeKey\("zygr\.submit\.skipConfirm\.v1"\)/);
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
    { platform: 'opencode-ai', apiKey: 'test-key', model: 'hy4-flash-free' },
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
      { platform: 'opencode-ai', apiKey: 'k', model: 'hy4-flash-free' },
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

test('平台不支持在线列表时只提示手动填写，不回退预设模型', async () => {
  const { api } = loadModules([{ status: 405, responseText: '' }]);
  const models = await api.fetchModels({ platform: 'siliconflow', endpoint: 'https://api.siliconflow.cn/v1/chat/completions', apiKey: 'k' });
  assert.equal(models.length, 0);
  assert.equal(models.manual, true);
  assert.match(models.message, /不支持在线获取模型列表，请手动填写模型名称/);

  const empty = loadModules([{ status: 200, responseText: JSON.stringify({ data: [] }) }]);
  const none = await empty.api.fetchModels({ platform: 'siliconflow', endpoint: 'https://api.siliconflow.cn/v1/chat/completions', apiKey: 'k' });
  assert.equal(none.length, 0);
  assert.equal(none.manual, true);
  assert.match(none.message, /请手动填写模型名称/);
});

test('runGrade 必须返回完整评分对象（回归：曾漏 return 导致 status 崩溃）', async () => {
  const { api } = loadModules([{
    status: 200,
    responseText: JSON.stringify({ choices: [{ message: { content: '{"s":"l","sc":3,"c":0.9,"r":"ok","sub":[]}' } }] })
  }]);
  const config = { pipeline: { timeoutMs: 5000, outputMode: 'standard' } };
  const service = {
    platform: 'custom',
    endpoint: 'https://example.com/v1/chat/completions',
    model: 'm',
    apiKey: 'k',
    thinkingMode: 'off'
  };
  const result = await api.runGrade(service, { subQuestions: [] }, 5, 'p', [], config, null, { detail: 'high' }, false);
  assert.ok(result, 'runGrade 不能返回 undefined');
  assert.equal(result.status, 'legible');
  assert.equal(result.score, 3);
  assert.equal(result.outputMode, 'standard');
  assert.equal(result.thinkingForced, false);
});

test('批改请求带上 max_tokens 上限以限制输出长尾', async () => {
  const { api, calls } = loadModules([{ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }]);
  await api.chatCompletion(
    { platform: 'custom', endpoint: 'https://example.com/v1/chat/completions', model: 'm', apiKey: 'k' },
    [{ role: 'user', content: 'hi' }],
    { jsonMode: true, maxTokens: 800 }
  );
  assert.equal(JSON.parse(calls[0].data).max_tokens, 800);
  await api.chatCompletion(
    { platform: 'custom', endpoint: 'https://example.com/v1/chat/completions', model: 'm', apiKey: 'k' },
    [{ role: 'user', content: 'hi' }],
    {}
  );
  assert.equal(JSON.parse(calls[1].data).max_tokens, undefined);
});

test('紧凑输出协议按索引映射小题名称与满分', () => {
  const { core } = loadCore();
  const subs = [{ label: '第1小问', maxScore: 3 }, { label: '第2小问', maxScore: 2 }];
  const grade = core.parseGrade('{"s":"p","sc":4,"c":0.8,"r":"第2问漏步骤","sub":[{"i":0,"sc":1.5},{"i":1,"sc":2}]}', 5, subs);
  assert.equal(grade.status, 'partial');
  // 模型自报 4 分，但小题合计 3.5：以小题为准并标记重算
  assert.equal(grade.score, 3.5);
  assert.equal(grade.scoreAdjusted, true);
  assert.equal(grade.confidence, 0.8);
  assert.equal(grade.reason, '第2问漏步骤');
  assert.equal(grade.subScores.length, 2);
  assert.equal(grade.subScores[0].label, '第1小问');
  assert.equal(grade.subScores[0].maxScore, 3);
  assert.equal(grade.subScores[1].label, '第2小问');
  assert.equal(grade.subScores[1].score, 2);
});

test('小题索引按 1 开始编号时自动左移，避免错位', () => {
  const { core } = loadCore();
  const subs = [{ label: '第1空', maxScore: 2 }, { label: '第2空', maxScore: 3 }];
  const grade = core.parseGrade('{"s":"l","sc":4,"c":0.9,"r":"ok","sub":[{"i":1,"sc":2},{"i":2,"sc":2,"r":"依据不符"}]}', 5, subs);
  assert.equal(grade.subScores.length, 2);
  assert.equal(grade.subScores[0].label, '第1空');
  assert.equal(grade.subScores[0].maxScore, 2);
  assert.equal(grade.subScores[1].label, '第2空');
  assert.equal(grade.subScores[1].reason, '依据不符');
});

test('接口优先同步满分与题号，未装观察器退回 DOM', () => {
  const hook = loadHook();
  // 没有接口数据、DOM 也为空：满分 0，不误判
  assert.equal(hook.resolveMaxScore(null), 0);
  hook.handleHookResponse('/api/personal/scanrecorddetail/', JSON.stringify(REAL_DETAIL));
  assert.equal(hook.resolveMaxScore(null), 2);
  const check = hook.checkMaxScore(5, null);
  assert.equal(check.maxScore, 2);
  assert.equal(check.mismatch, true);
  assert.equal(hook.checkMaxScore(2, null).mismatch, false);
  assert.equal(hook.currentScanRecordId(), '91118d7a-ef5d-4d15-9a1e-e03cd5df23f7');
});

test('限流不死等：单次超预算直接拒绝，等待超时有上限', async () => {
  const { api } = loadModules();
  const limiter = new api.RateLimiter({ maxConcurrent: 1, maxRpm: 60, maxTpm: 1000 });
  await assert.rejects(() => limiter.acquire(5000, 50), /超过 TPM 预算/);
  const busy = new api.RateLimiter({ maxConcurrent: 1, maxRpm: 60, maxTpm: 1e5 });
  busy.active = 1;
  await assert.rejects(() => busy.acquire(10, 60), /等待限流配额超时/);
});

test('finish_reason=length 有正文时交给上层捞分，空正文才作废', async () => {
  const { api } = loadModules([{
    status: 200,
    responseText: JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"s":"l","sc":2' } }] })
  }]);
  let truncated = false;
  const text = await api.chatCompletion(
    { platform: 'custom', endpoint: 'https://example.com/v1/chat/completions', model: 'm', apiKey: 'k' },
    [{ role: 'user', content: 'hi' }],
    { onTruncated: () => { truncated = true; } }
  );
  assert.equal(truncated, true);
  assert.match(text, /"sc":2/);

  const empty = loadModules([{
    status: 200,
    responseText: JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }] })
  }]);
  await assert.rejects(
    () => empty.api.chatCompletion(
      { platform: 'custom', endpoint: 'https://example.com/v1/chat/completions', model: 'm', apiKey: 'k' },
      [{ role: 'user', content: 'hi' }],
      {}
    ),
    /finish_reason=length/
  );
});

test('截断的 JSON 能修复出分数，无确定分数时才作废', async () => {
  const { core } = loadCore();
  // 修复：截断在评语字符串中间
  const salvage = core.parseGrade('{"s":"l","sc":2,"c":0.9,"r":"第一空答对', 2, []);
  assert.equal(salvage.score, 2);
  assert.equal(salvage.status, 'legible');
  assert.equal(salvage.scoreUncertain, false);
  // 修复：截断在小题数组中间，保留完整条目、丢弃半条
  const subs = [{ label: '第1问', maxScore: 2 }, { label: '第2问', maxScore: 3 }];
  const partial = core.parseGrade('{"s":"l","sc":4,"c":0.8,"r":"","sub":[{"i":0,"sc":2,"r":"对"},{"i":1,"sc":', 5, subs);
  assert.equal(partial.score, 4);
  assert.equal(partial.subScores.length, 1);
  // 作废：截断太早，连 sc 都没写出来
  const unusable = core.parseGrade('{"s":"l","sc":', 2, []);
  assert.equal(unusable.scoreUncertain, true);
});

test('runGrade 截断时给出分数并标记复核；无确定分数时报错', async () => {
  const service = { platform: 'custom', endpoint: 'https://example.com/v1/chat/completions', model: 'm', apiKey: 'k', thinkingMode: 'off' };
  const config = { pipeline: { outputMode: 'standard', timeoutMs: 30000 } };
  const question = { topicNumStr: '43,1', questionId: '43,1', subQuestions: [], identity: {}, images: [] };
  const salvaged = loadModules([{
    status: 200,
    responseText: JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"s":"l","sc":2,"c":0.9,"r":"第一空答对' } }] })
  }]);
  const grade = await salvaged.api.runGrade(service, question, 2, 'prompt', [], config, null, { detail: 'high' }, false);
  assert.equal(grade.score, 2);
  assert.equal(grade.truncated, true);
  assert.equal(grade.thinkingForced, false);

  const unusable = loadModules([{
    status: 200,
    responseText: JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"s":"l","sc":' } }] })
  }]);
  await assert.rejects(
    () => unusable.api.runGrade(service, question, 2, 'prompt', [], config, null, { detail: 'high' }, false),
    /没能从已产出内容中解析出确定分数|\\u6CA1\\u80FD/
  );
});

test('思考未关闭时输出预算放宽到 3 倍', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.match(built, /Math\.round\(baseTokens \* 3\)/);
  assert.doesNotMatch(built, /baseTokens \* 1\.8/);
});

test('回评接口与钩子回调已接线，题号靠 scanRecordId 判重', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.match(built, /markingBack\|markingNext/);
  assert.match(built, /function onHookUpdate/);
  assert.match(built, /onHookUpdate\(\(\) => \{/);
  assert.match(built, /scanRecordId: String\(hookCurrentField\("scanRecordId"\)/);
  // 判重从「三个字段必须相等」改成 samePaper：scanRecordId 一边为空（观察器还没跟上）时不算换卷
  assert.match(built, /function samePaper\(a, b\)/);
  assert.match(built, /a\.scanRecordId !== b\.scanRecordId/);
});

test('进度显示与复核留痕已接线', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  // 进度：页面 .progress 文本优先，接口计数兜底
  assert.match(built, /SELECTORS\.progress/);
  assert.match(built, /readProgress\(markingDoc\)/);
  assert.match(built, /id="zygr-progress"/);
  assert.match(built, /setProgress\(progress \?/);
  // 复核留痕：历史回调 + 两个按钮
  assert.match(built, /onReview: \(id, patch\) =>/);
  assert.match(built, /reviewedAt: Date\.now\(\), reviewNote/);
  assert.match(built, /confirmedScore: Math\.min\(Math\.max\(value, 0\), max\)/);
});

test('连续批阅有份数上限，避免无人看管跑到没配额', () => {
  const { core } = loadCore();
  assert.equal(core.loadConfig().continuousLimit, 20);
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.match(built, /Number\(config\.continuousLimit\) \|\| 20/);
  assert.match(built, /count >= limit/);
  // 份数上限已移到主面板，和连续批阅按钮放在一起；设置页不再保留重复入口。
  assert.match(built, /data-opt='continuous-limit'/);
  assert.match(built, /zygr-continuous-cell/);
  assert.match(built, /onContinuousLimitChange/);
  assert.match(built, /\\u4E0D\\u662F\\u5FC5\\u987B\\u6279\\u6EE1\\u7684\\u4EFD\\u6570/);
  assert.match(built, /var CONTINUOUS_LIMIT_MAX = 5000;/);
  assert.match(built, /Math\.min\(CONTINUOUS_LIMIT_MAX, Number\(config\.continuousLimit\)/);
  assert.match(built, /max="\$\{CONTINUOUS_LIMIT_MAX\}"/);
  assert.doesNotMatch(built, /field\([^)]*"continuousLimit"/);
});

test('输出档位移到主面板，设置页不再保留重复入口', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.match(built, /data-opt='output-mode'/);
  assert.match(built, /onOutputModeChange/);
  assert.match(built, /setOutputMode\(config\.pipeline\.outputMode\)/);
  assert.match(built, /var OUTPUT_MODE_SHORT = /);
  // 面板用的是短标签，完整说明放 title 提示里
  assert.match(built, /OUTPUT_MODE_SHORT\[key\] \|\| key/);
  assert.doesNotMatch(built, /select\([^)]*"pipeline\.outputMode"/);
});

test('请求不再附带 prompt_cache_key；自定义平台填火山地址时按火山规则发送思考字段', async () => {
  const { api, calls } = loadModules([{ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }]);
  const service = { platform: 'volcengine-chat', endpoint: '', model: 'deepseek-v4-1-flash-261017', apiKey: 'k', thinkingMode: 'off' };
  // 真机实测：火山隐式缓存在图片不同时不会复用前缀，路由亲和键对真实阅卷没有帮助，已移除。
  await api.chatCompletion(service, [{ role: 'user', content: 'hi' }], { promptCacheKey: 'zygr|should-not-be-sent' });
  assert.equal(JSON.parse(calls[0].data).prompt_cache_key, undefined);

  // 用户手填火山地址但平台选了「自定义」时，仍要按火山规则关闭思考，避免输出被截断。
  const customVolc = api.resolveProfile({
    platform: 'custom',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    model: 'm',
    apiKey: 'k'
  });
  assert.equal(customVolc.disableThinkingKey, 'thinking');
  assert.equal(customVolc.thinkingFields.off.thinking.type, 'disabled');
  await api.chatCompletion(
    { platform: 'custom', endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', model: 'm', apiKey: 'k', thinkingMode: 'off' },
    [{ role: 'user', content: 'hi' }]
  );
  const customVolcPayload = JSON.parse(calls[1].data);
  assert.equal(customVolcPayload.prompt_cache_key, undefined);
  assert.deepEqual(customVolcPayload.thinking, { type: 'disabled' });
});

test('缓存命中数为 0 时也明确显示，避免用户误以为没读到字段', () => {
  const panel = readSource('src/ui/panel.ts');
  const history = readSource('src/ui/history.ts');
  assert.match(panel, /Number\(usage\.cached\) \|\| 0/);
  assert.match(panel, /\\u524D\\u7F00\\u547D\\u4E2D \$\{Number\(usage\.cached\) \|\| 0\}/);
  assert.match(history, /\\u8F93\\u5165 \$\{usage\.prompt\}\\uFF08\\u524D\\u7F00\\u547D\\u4E2D \$\{usage\.cached\}\\uFF09/);
});

test('作答图过期提示指向浏览器刷新，不再要求点页面刷新按钮', () => {
  const pipeline = readSource('src/core/pipeline.ts');
  assert.match(pipeline, /\\u6309\\u6D4F\\u89C8\\u5668 F5 \\u5237\\u65B0\\u5F53\\u524D\\u9605\\u5377\\u9875/);
  assert.doesNotMatch(pipeline, /\\u70B9\\u9605\\u5377\\u9875\\u300C\\u5237\\u65B0\\u300D/);
  const jump = readSource('src/adapters/zhixue-jump.ts');
  assert.match(jump, /请按浏览器 F5 刷新当前页面后重试/);
  assert.doesNotMatch(jump, /请刷新阅卷页后重试/);
});

test('HTTP 200 但响应体是 error 时显式报错', async () => {
  const { api } = loadModules([{
    status: 200,
    responseText: JSON.stringify({ error: { message: 'invalid api key' } })
  }]);
  await assert.rejects(
    () => api.chatCompletion(
      { platform: 'custom', endpoint: 'https://example.com/v1/chat/completions', model: 'm', apiKey: 'k' },
      [{ role: 'user', content: 'hi' }],
      {}
    ),
    /HTTP 200 但带错误.*invalid api key/
  );
});

test('预设下拉用 DOM 构造 option，不再拼 innerHTML', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.doesNotMatch(built, /element\.innerHTML = options/);
  assert.match(built, /document\.createDocumentFragment\(\)/);
  assert.match(built, /option\.textContent = preset\.label/);
});

test('P1 判分质量接线：满分同步、换卷主判据、截断作废', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.match(built, /checkMaxScore\(config\.context\.maxScore, markingDoc\)/);
  assert.match(built, /config\.context\.maxScore = scoreCheck\.maxScore/);
  assert.match(built, /const scanWindow = 8e3/);
  assert.match(built, /nextScan !== oldScan/);
  assert.match(built, /await waitForNextPaper\(submitted\.oldIdentity, submitted\.oldScan\)/);
  assert.match(built, /finish_reason === "length"/);
  assert.match(built, /scoreAdjusted|scoreUncertain/);
});

test('小题不全时不重算总分，并标记需要复核', () => {
  const { core } = loadCore();
  const subs = [{ label: '第1问', maxScore: 2 }, { label: '第2问', maxScore: 3 }];
  // 只回了 1 个小题：不能把自报总分抹掉
  const partial = core.parseGrade('{"s":"p","sc":3,"sub":[{"i":0,"sc":2}]}', 5, subs);
  assert.equal(partial.score, 3);
  assert.equal(partial.scoreAdjusted, false);
  assert.equal(partial.subScores.length, 1);
});

test('分数解析：优先【得分】x/y 的分子，无法确定时不猜', () => {
  const { core } = loadCore();
  const labeled = core.parseGrade('【作答状态】可辨认\n【得分】3/5\n【理由】步骤对', 5, []);
  assert.equal(labeled.score, 3);
  assert.equal(labeled.scoreUncertain, false);
  const tagged = core.parseGrade('作答状态：可辨认\n得分：4\n理由：ok', 5, []);
  assert.equal(tagged.score, 4);
  const single = core.parseGrade('【作答状态】可辨认\n【理由】扣 1 分', 5, []);
  assert.equal(single.scoreUncertain, false);
  const ambiguous = core.parseGrade('【作答状态】可辨认\n【理由】第1步 2 分，第2步 3 分', 5, []);
  assert.equal(ambiguous.scoreUncertain, true);
  assert.equal(ambiguous.score, 0);
});

test('旧版 JSON 协议仍然可以解析', () => {
  const { core } = loadCore();
  const grade = core.parseGrade(
    '{"status":"legible","score":3,"subScores":[{"label":"X","score":3,"maxScore":3,"reason":"满分"}],"reason":"ok","confidence":0.9}',
    5
  );
  assert.equal(grade.status, 'legible');
  assert.equal(grade.score, 3);
  assert.equal(grade.subScores[0].label, 'X');
  assert.equal(grade.subScores[0].reason, '满分');
});

test('提示词固定段不含动态内容，同题不同废图数完全一致', () => {
  const { core } = loadCore();
  const question = { questionText: '题干', subQuestions: [{ label: '第1问', maxScore: 2 }] };
  const context = { question: '', answer: '答案', rubric: '标准', maxScore: 5 };
  const a = core.buildGradingPrompt(question, context, { removedImages: 0 });
  const b = core.buildGradingPrompt(question, context, { removedImages: 3 });
  assert.equal(a, b);
  assert.match(a, /字段（务必精简）/);
  assert.match(a, /已剔除空白或重复图片/);
  assert.doesNotMatch(a, /已剔除 \d+ 张废图/);
});

test('学科图片策略优先于手动尺寸，未选学科时保持手动值', () => {
  const { core } = loadCore();
  const manual = core.resolveImageOptions({ image: { maxEdge: 1600, detail: 'high' }, context: { subject: '' } });
  assert.equal(manual.maxEdge, 1600);
  assert.equal(manual.subject, undefined);
  // 裁切、切块重排、多图合并已下线，只保留等比缩小
  assert.equal('cropToAnswer' in manual, false);
  assert.equal('splitWideStrip' in manual, false);
  assert.equal('mergeImages' in manual, false);
  const legacy = core.resolveImageOptions({ image: { cropToAnswer: true, splitWideStrip: true, mergeImages: true } });
  assert.equal('cropToAnswer' in legacy, false);
  assert.equal('splitWideStrip' in legacy, false);
  assert.equal('mergeImages' in legacy, false);

  const math = core.resolveImageOptions({ image: { maxEdge: 1024, detail: 'low' }, context: { subject: '数学' } });
  assert.equal(math.maxEdge, 1600);
  assert.equal(math.detail, 'high');
  assert.equal(math.subject, '数学');

  const geography = core.resolveImageOptions({ image: { maxEdge: 1600 }, context: { subject: '地理' } });
  assert.equal(geography.maxEdge, 1280);

  const disabled = core.resolveImageOptions({ image: { maxEdge: 1024, autoBySubject: false }, context: { subject: '数学' } });
  assert.equal(disabled.maxEdge, 1024);
  assert.equal(disabled.subject, undefined);

  assert.equal(Object.keys(core.SUBJECT_IMAGE_PROFILES).length, 9);
});

test('旧配置里遗留的裁切/重排开关在加载时被丢弃', () => {
  const { core, store } = loadCore();
  store.set('zygr.config.v1', JSON.stringify({
    version: 1,
    image: { cropToAnswer: true, splitWideStrip: true, mergeImages: true, policyVersion: 1 }
  }));
  const config = core.loadConfig();
  assert.equal('cropToAnswer' in config.image, false);
  assert.equal('splitWideStrip' in config.image, false);
  assert.equal('mergeImages' in config.image, false);
  assert.equal('policyVersion' in config.image, false);
  // 其他字段保持默认，不受旧配置影响
  assert.equal(config.image.maxEdge, 1600);
  assert.equal(config.pipeline.thinkingMode, 'off');
});

test('输出档位越详细，要求写的理由越多', () => {
  const { core } = loadCore();
  const question = { questionText: '题干', subQuestions: [{ label: '第1问', maxScore: 2 }] };
  const context = { question: '', answer: '答案', rubric: '标准', maxScore: 5 };
  const brief = core.buildGradingPrompt(question, context, { outputMode: 'brief' });
  const standard = core.buildGradingPrompt(question, context, { outputMode: 'standard' });
  const detailed = core.buildGradingPrompt(question, context, { outputMode: 'detailed' });
  assert.match(brief, /不要输出任何理由/);
  assert.doesNotMatch(brief, /30 字/);
  assert.match(standard, /不超过 30 字/);
  assert.match(detailed, /不超过 60 字/);
  assert.match(detailed, /不超过 40 字/);
  assert.notEqual(brief, standard);
  assert.notEqual(standard, detailed);
  // 未知档位回落到标准
  assert.equal(core.normalizeOutputMode('unknown'), 'standard');
  assert.equal(core.OUTPUT_MODES.brief.maxTokens < core.OUTPUT_MODES.detailed.maxTokens, true);
});

test('累计用量只做本地累加，不触发请求', () => {
  const { core, store } = loadCore();
  assert.equal(core.loadUsageStats().graded, 0);
  core.recordUsage({ graded: true, request: true, prompt: 1000, cached: 800, completion: 120 });
  core.recordUsage({ graded: true, localHit: true });
  const stats = core.loadUsageStats();
  assert.equal(stats.graded, 2);
  assert.equal(stats.localHits, 1);
  assert.equal(stats.requests, 1);
  assert.equal(stats.promptTokens, 1000);
  assert.equal(stats.cachedTokens, 800);
  assert.equal(stats.completionTokens, 120);
  assert.ok(store.has('zygr.stats.v1'));
});

test('缓存批量写入并剔除模型原文', () => {
  const { core, store } = loadCore();
  const cache = new core.CacheStore(30, 2000);
  cache.set('k1', {
    status: 'legible',
    score: 3,
    subScores: [{ label: '第1问', score: 3, maxScore: 3, reason: '' }],
    reason: 'ok',
    cacheKey: 'k1',
    raw: 'x'.repeat(2000),
    createdAt: 1
  });
  // 未到批量写入时机前不落盘
  assert.equal(store.has('zygr.cache.v1'), false);
  assert.equal(cache.size(), 1);
  assert.equal(cache.get('k1').score, 3);
  assert.equal(cache.flush(), true);
  const saved = JSON.parse(store.get('zygr.cache.v1'));
  assert.equal(saved.k1.data.raw, undefined);
  assert.equal(saved.k1.data.cacheKey, undefined);
  assert.equal(saved.k1.data.subScores[0].label, '第1问');
});

test('缓存超过上限只分批淘汰，不会整表清空', () => {
  const { core } = loadCore();
  const cache = new core.CacheStore(30, 100);
  for (let index = 0; index < 130; index += 1) cache.set(`k${index}`, { score: index });
  assert.ok(cache.size() <= 100, `size=${cache.size()}`);
  assert.ok(cache.size() >= 80, `size=${cache.size()}`);
  assert.equal(cache.get('k129').score, 129);
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

test('平台列表只含内置预设，且内置预设不再提供默认模型', () => {
  const { api } = loadModules();
  const presets = api.listPlatformPresets();
  assert.ok(presets.length >= 8);
  assert.ok(presets.some((p) => p.id === 'custom'));
  assert.equal(presets.some((p) => p.id === 'cloudflare-workers-ai'), false);
  assert.equal(presets.some((p) => p.id === 'openai'), false);
  assert.equal(presets.some((p) => p.id === 'azure-openai'), false);
  // 用户未填模型时档案的 model 为空，不再回落到预设推荐值
  const profile = api.resolveProfile({ platform: 'siliconflow', endpoint: '', model: '', apiKey: 'k' });
  assert.equal(profile.model, '');
  assert.ok(profile.models.length > 0);
});

test('界面已移除管理自定义预设入口', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.doesNotMatch(built, /data-act="preset-toggle"/);
  assert.doesNotMatch(built, /data-preset-editor/);
  assert.doesNotMatch(built, /collectPresetForm\(\)/);
});

test('构建产物包含缓存扩容、输出上限与纯缩放图片策略', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.match(built, /cacheMaxEntries/);
  assert.match(built, /max_tokens/);
  assert.match(built, /"image\.detail"/);
  assert.match(built, /resolveImageOptions/);
  assert.match(built, /"context\.subject"/);
  assert.match(built, /data-field="image\.autoBySubject"/);
  // 只缩不放：缩放系数被 1 夹住
  assert.match(built, /Math\.min\(1, config\.maxEdge/);
  // 裁切、切条重排、多图合并的整条链路已下线
  assert.doesNotMatch(built, /cropToAnswer/);
  assert.doesNotMatch(built, /splitWideStrip/);
  assert.doesNotMatch(built, /stripLayout/);
  assert.doesNotMatch(built, /mergeImages/);
  assert.doesNotMatch(built, /mergePreparedImages/);
  assert.doesNotMatch(built, /restructured/);
});

test('提交结果判定：有回执看回执，没观察器退回旧行为', () => {
  const { core } = loadCore();
  // 没有观察器：维持「点过即提交」，不阻断流程
  const legacy = core.judgeSubmit(false, null);
  assert.equal(legacy.ok, true);
  assert.equal(legacy.confirmed, false);
  // 有观察器但没等到 commitTopic 回执：不写已提交
  const missing = core.judgeSubmit(true, null);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /未收到平台提交回执/);
  // 平台明确返回成功
  const ok = core.judgeSubmit(true, { ok: true, result: 'success' });
  assert.equal(ok.ok, true);
  assert.equal(ok.confirmed, true);
  // 平台明确拒绝：把原因带出来，不写已提交
  const rejected = core.judgeSubmit(true, { ok: false, result: 'topicLocked' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /topicLocked/);
  // 回执丢了但卷子确实换了：按「已提交、未确认」记，避免老师重复提交
  const inferred = core.judgeSubmit(true, null, true);
  assert.equal(inferred.ok, true);
  assert.equal(inferred.confirmed, false);
  assert.equal(inferred.inferred, true);
  // 平台明确拒绝时不能被换卷掩盖（换卷可能是老师自己点的回评）
  const rejectedWithChange = core.judgeSubmit(true, { ok: false, result: 'topicLocked' }, true);
  assert.equal(rejectedWithChange.ok, false);
});

test('提交链路有互斥、冷却与填分回读', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.match(built, /let submitting = false/);
  assert.match(built, /const SUBMIT_COOLDOWN = 1500/);
  assert.match(built, /if \(submitting\) return \{ ok: false, oldIdentity: null \}/);
  // 填分后回读，不一致就中止
  assert.match(built, /Number\(input\.value\) !== target/);
  // 回读不一致时带出输入框序号与期望值（dist 里是 \uXXXX 转义原文）
  assert.match(built, /\\u56DE\\u8BFB\\u4E0D\\u4E00\\u81F4/);
  assert.match(built, /\$\{filled\.error\}/);
  // 提交回执：重置 → 等待 → 没回执再看换卷 → 判定
  assert.match(built, /resetCommitSignal\(\)/);
  assert.match(built, /await waitCommitSignal\(2500\)/);
  assert.match(built, /await waitPaperChanged\(oldIdentity, oldScan, 3e3\)/);
  assert.match(built, /judgeSubmit\(observed, signal, changed\)/);
  // 永不点击判满分/零分/问题卷/休卷
  assert.match(built, /FORBIDDEN_BUTTON/);
});

test('阅卷控件按打分框+提交按钮选帧，不认第一个 iframe', () => {
  const source = readSource('src/adapters/zhixue.ts');
  assert.doesNotMatch(source, /const iframe = mainDoc\(\)\.querySelector\("iframe"\)/);
  assert.match(source, /mainDoc\(\)\.querySelectorAll\("iframe"\)/);
  assert.match(source, /if \(hasScoreInput\(doc\) && hasSubmitButton\(doc\)\)/);
  assert.match(source, /frameAlive\(lastMarkingDoc\)/);
  // 没有指定文档时优先用阅卷控件快照，避免拿到别的 frame 里的旧卷
  assert.match(source, /const primary = getIframeDoc\(\);/);
});

test('空白率在缩放后的画布上采样，不整幅读像素', () => {
  const source = readSource('src/infra/image.ts');
  assert.match(source, /blankRatio\(outputCtx, output\.width, output\.height\)/);
  assert.doesNotMatch(source, /blankRatio\(workCtx/);
});

test('DOM 监听收窄到题号/作答图/进度容器', () => {
  const source = readSource('src/main.ts');
  assert.doesNotMatch(source, /observer\.observe\(doc\.body, \{/);
  assert.match(source, /#topicImgContent, #currentTopicIndex, #containter_topicTxt, \.progress/);
  // 路由整段替换后要能重新挂上
  assert.match(source, /watchTimer = window\.setInterval\(/);
});

test('换卷判定容忍 scanRecordId 晚到', () => {
  const main = readSource('src/main.ts');
  // 一边为空时不能判换卷，否则批改结果会被后补的接口身份清掉
  assert.match(main, /if \(a\.scanRecordId && b\.scanRecordId && a\.scanRecordId !== b\.scanRecordId\) return false;/);
  // 作答图按去签名后的 key 比对，不靠张数
  assert.match(main, /const key = \(url\) => resourceKey\(url\) \|\| url;/);
  assert.match(main, /if \(samePaper\(currentQuestion, question\)\) return;/);
  // 提交失败原因分开说
  assert.match(main, /\\u8FD8\\u6CA1\\u6709\\u6279\\u6539\\u7ED3\\u679C/);
  // 观察器晚到时要回填身份，否则首份卷的历史永远定位不了
  assert.match(main, /void backfillIdentity\(lastHistoryId, gradedKeys\)/);
  assert.match(main, /if \(nowKeys !== imageKeys\) return;/);
});

test('不存在 currentHookField 这种手误引用', () => {
  // 这个手误只会被 catch 吞掉，真机上表现为「提交后没有提示、定位不可用」，很难查
  for (const rel of ['src/main.ts', 'src/adapters/zhixue-jump.ts', 'src/adapters/zhixue.ts']) {
    assert.doesNotMatch(readSource(rel), /[^\w.]currentHookField\(/, rel);
  }
});

test('题号口径双向可转：DOM 的 43(1) 与接口的 43,1', () => {
  const source = readSource('src/adapters/zhixue-jump.ts');
  assert.match(source, /function jumpApiTopicNum\(value\)/);
  assert.match(source, /const match = text\.match\(\/\^\(\\d\+\)\\s\*\[（\(\]\\s\*\(\\d\+\)\\s\*\[\)）\]\$\//);
  // 检索接口与记录 id 解析都必须用接口口径
  assert.match(source, /const topicNumStr = jumpApiTopicNum\(identity\.topicNumStr \|\| question\.topicNumStr \|\| ""\)/);
  assert.match(source, /const topicNumStr = jumpApiTopicNum\(identity\?\.topicNumStr \|\| ""\)/);
  // 观察器没抓到 origin 时问平台路由，别逼用户刷新页面
  assert.match(source, /async function jumpResolveOrigin\(win, markingPaperId\)/);
  assert.match(source, /getHostByBusinessId\?businessType=markingPaper/);
  assert.match(source, /const origin = await jumpResolveOrigin\(win, markingPaperId\)/);
  // 别把 hookCurrentField 写成 currentHookField：这个手误会被 catch 吞掉，真机上表现为「定位没反应」
  assert.match(source, /hookCurrentField\("markingPaperId"\)/);
  assert.doesNotMatch(source, /[^\w.]currentHookField\(/);
});

test('复核闭环：提交即标记已复核 + 定位后对账分数', () => {
  const main = readSource('src/main.ts');
  assert.match(main, /patch\.reviewedAt = Date\.now\(\);/);
  assert.match(main, /readFilledScores\(doc\)/);
  // 源文件里中文是 \uXXXX 转义，按转义形式断言
  assert.match(main, /\\u53EF\\u80FD\\u5DF2\\u88AB\\u4ED6\\u4EBA\\u6539\\u5206/);
  const history = readSource('src/ui/history.ts');
  assert.match(history, /data-act="next-review"/);
  assert.match(history, /nextReviewEntry\(\)/);
  // 填分数量对不上时给人话，而不是「第 N 个分数不是有效数字」
  const adapter = readSource('src/adapters/zhixue.ts');
  assert.match(adapter, /\\u8BF7\\u5148\\u8865\\u9F50\\u5C0F\\u9898\\u5206/);
});

test('面板输入框统一拦截 Enter，且填分不用键盘事件', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.match(built, /function guardEnter\(root\)/);
  assert.match(built, /event\.stopPropagation\(\)/);
  // 三个面板都要挂上
  assert.equal((built.match(/guardEnter\(this\.shadow\)/g) || []).length, 3);
  assert.doesNotMatch(built, /new KeyboardEvent/);
});

test('构建产物与 buildOutput() 逐字一致', async () => {
  const { buildOutput } = await import(pathToFileURL(join(root, 'build.mjs')).href);
  assert.equal(buildOutput(), readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8'));
});

test('接口观察器按真机结构解析 scanrecorddetail / preLoad / commitTopic', () => {
  const hook = loadHook();
  assert.equal(hook.hookActive(), false);
  hook.handleHookResponse('https://pt-ali-bj.zhixue.com/marking/marking/commitTopic/', '{"result":"success"}');
  assert.equal(hook.hookActive(), true);
  assert.equal(hook.commitFeed.last.ok, true);

  hook.handleHookResponse('https://pt-ali-bj.zhixue.com/marking/marking/personal/scanrecorddetail/', JSON.stringify(REAL_DETAIL));
  const current = hook.currentHookIdentity();
  assert.equal(current.scanRecordId, '91118d7a-ef5d-4d15-9a1e-e03cd5df23f7');
  assert.equal(current.topicNumStr, '43,1');
  assert.equal(current.userCode, '14801889');
  // 满分取 cutBlock.subTopicScore（当前小题），不是大题 standardScore
  assert.equal(current.subTopicScore, 2);
  assert.equal(hook.resolveMaxScore(null), 2);
  assert.equal(hook.freshAnswerImages().length, 1);
  assert.match(hook.freshAnswerImages()[0], /zhixue-sc\.oss/);
  // 进度来自 teacherMarked / teacherTodo
  assert.equal(hook.hookProgress().marked, 533);
  assert.equal(hook.hookProgress().todo, 147);

  // 「回评上一份」走 markingBack，结构与 scanrecorddetail 相同，必须同样接管
  const back = JSON.parse(JSON.stringify(REAL_DETAIL));
  back.data.topicInfo.detail.scanRecordId = 'back-1';
  back.data.cutBlock.subTopicScore = 2;
  hook.handleHookResponse('https://pt-ali-bj.zhixue.com/marking/marking/personal/markingBack/', JSON.stringify(back));
  assert.equal(hook.currentHookIdentity().scanRecordId, 'back-1');
  assert.equal(hook.hookProgress().marked, 533);

  // preLoad 只写 next，不能把 current 顶掉（否则换卷判定会错）
  hook.handleHookResponse('https://pt-ali-bj.zhixue.com/marking/marking/personal/preLoadScanrecorddetail/', JSON.stringify(REAL_NEXT));
  assert.equal(hook.currentHookIdentity().scanRecordId, 'back-1');
  assert.equal(hook.nextHookIdentity().scanRecordId, '0dcc94c0-2cf6-4d6a-b599-ba4585f6e503');
  assert.equal(hook.nextHookIdentity().subTopicScore, null);
});

test('提交回执非 success 时判为拒绝，早到的回执也能取到', async () => {
  const hook = loadHook();
  hook.handleHookResponse('/api/commitTopic/commit', '{"result":"fail"}');
  assert.equal(hook.commitFeed.last.ok, false);
  assert.equal(hook.commitFeed.last.result, 'fail');
  // 回执先于等待到达：以 reset 时刻为基线，不能漏
  hook.resetCommitSignal();
  hook.pushCommitSignal('success');
  const signal = await hook.waitCommitSignal(300);
  assert.ok(signal);
  assert.equal(signal.ok, true);
});

test('缓存键：签名不同的同一张图归一为同一个键', () => {
  const { core } = loadCore();
  const a = 'https://oss.example/answer/1.jpg?Expires=100&OSSAccessKeyId=K&Signature=AAA&x-oss-process=image/crop,0,0,100,100/resize,w_800';
  const b = 'https://oss.example/answer/1.jpg?Expires=999&OSSAccessKeyId=K&Signature=BBB&x-oss-process=image/crop,0,0,100,100/resize,w_800';
  assert.equal(core.stableImageKey(a), core.stableImageKey(b));
  // URL 序列化会把 crop 参数转义，只校验裁剪信息仍在、签名与过期时间已被剥掉
  assert.match(core.stableImageKey(a), /crop/);
  assert.doesNotMatch(core.stableImageKey(a), /Signature|Expires|resize/);
  // data URI 按内容哈希，内容不同则键不同
  const dataA = `data:image/png;base64,${'A'.repeat(20)}`;
  assert.equal(core.stableImageKey(dataA), core.stableImageKey(dataA));
  assert.notEqual(core.stableImageKey(dataA), core.stableImageKey(`data:image/png;base64,${'B'.repeat(20)}`));
});

test('有接口身份时缓存键只认 scanRecordId，与图片签名无关', () => {
  const { core } = loadCore();
  const base = {
    question: { questionText: '题干', images: ['https://oss.example/1.jpg?Signature=A&Expires=1'], subQuestions: [] },
    context: { question: '', answer: '答案', rubric: '标准', maxScore: 5 },
    model: 'qwen-vl-max',
    image: { maxEdge: 1600 },
    thinkingMode: 'off',
    outputMode: 'standard',
    identity: { scanRecordId: 'S1', topicNumStr: '43,1' },
    promptVersion: core.PROMPT_VERSION
  };
  const other = { ...base, question: { ...base.question, images: ['https://oss.example/1.jpg?Signature=B&Expires=9'] } };
  assert.equal(core.makeGradeCacheKey(base), core.makeGradeCacheKey(other));
  assert.match(core.makeGradeCacheKey(base), /^grade:v2:/);
  assert.notEqual(core.makeGradeCacheKey(base), core.makeGradeCacheKey({ ...base, identity: { scanRecordId: 'S2', topicNumStr: '43,1' } }));
});

test('观察器与取图/缓存/历史兜底已接线', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  // 只读包装：原 open/send 原样调用，不改请求
  assert.match(built, /__zygrHooked/);
  assert.match(built, /originalOpen\.call\(this, method, url, \.\.\.rest\)/);
  assert.match(built, /originalSend\.apply\(this, args\)/);
  // iframe 替换后校验、提交前再校验
  assert.match(built, /ensureZhixueHook\(doc\)/);
  assert.match(built, /ensureZhixueHook\(markingDoc\)/);
  // DOM 取不到时用接口新鲜地址兜底
  assert.match(built, /images = freshAnswerImages\(\)/);
  // 缓存键升级 + 历史瘦身
  assert.match(built, /grade:v2:/);
  assert.match(built, /historyQuestion\(currentQuestion\)/);
  // 历史写入用瘦身后的 question，不再把带签名的 images 原样存盘
  assert.match(built, /imageKeys: \(question\.images \|\| \[\]\)\.map\(stableImageKey\)/);
});

test('输出档位与思考模式都进缓存键，切档不会误命中', () => {
  const { core } = loadCore();
  const base = {
    question: { questionText: '题干', images: ['https://img/1.jpg'], subQuestions: [] },
    context: { question: '', answer: '答案', rubric: '标准', maxScore: 5 },
    model: 'qwen-vl-max',
    image: { maxEdge: 1600, quality: 0.82 },
    thinkingMode: 'off',
    outputMode: 'standard',
    promptVersion: core.PROMPT_VERSION
  };
  const key = core.makeGradeCacheKey(base);
  assert.equal(key, core.makeGradeCacheKey({ ...base }));
  assert.notEqual(key, core.makeGradeCacheKey({ ...base, outputMode: 'detailed' }));
  assert.notEqual(key, core.makeGradeCacheKey({ ...base, thinkingMode: 'auto' }));
  assert.notEqual(key, core.makeGradeCacheKey({ ...base, image: { maxEdge: 1440, quality: 0.82 } }));
});

test('CSV 导出每行列数与表头一致，汇总行只填合计列', () => {
  const { core } = loadCore();
  const lines = core.toCsv(exportSample()).replace(/^\uFEFF/, '').split('\r\n');
  const header = splitCsvLine(lines[0]);
  assert.equal(header.length, 23);
  assert.equal(header[17], '"输入 Token"');
  assert.equal(header[15], '"确认分"');
  assert.equal(header[16], '"复核状态"');
  // 表头、每条数据、汇总行都必须同宽，否则 Excel 里会错列
  for (const line of lines) assert.equal(splitCsvLine(line).length, header.length, line);
  const csv = lines.join('\n');
  // 平台定位字段随记录导出
  assert.match(csv, /"43,1"/);
  assert.match(csv, /"S1"/);
  assert.match(csv, /"U100"/);
  // 复核留痕随记录导出
  assert.match(csv, /"2\.5"/);
  assert.match(csv, /已复核/);
  const summary = splitCsvLine(lines[lines.length - 1]);
  assert.equal(summary[0], '"汇总"');
  assert.equal(summary[1], '"共 2 条"');
  assert.equal(summary[17], '"1000"');
  assert.equal(summary[18], '"800"');
  assert.equal(summary[19], '"180"');
  assert.equal(summary[20], '"60"');
  assert.match(summary[21], /本地命中 1 次（50%）/);
});

test('HTML 导出列数与表头一致，并带用量汇总条', () => {
  const { core } = loadCore();
  const html = core.toHtml(exportSample());
  assert.equal((html.match(/<th>/g) || []).length, 20);
  const body = html.split('<tbody>')[1].split('</tbody>')[0];
  const rows = body.split('</tr>').filter((row) => row.includes('<td>'));
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal((row.match(/<td>/g) || []).length, 20);
  assert.match(html, /class="zygr-summary"/);
  assert.match(html, /思考 Token/);
  assert.match(html, /耗时（秒）/);
  assert.match(body, /本地命中/);
  assert.match(body, /前缀命中/);
});

test('命中状态区分本地命中/前缀命中/未命中', () => {
  const { core } = loadCore();
  const [hit, prefix] = exportSample();
  assert.equal(core.entryHitText(hit), '本地命中');
  assert.equal(core.entryHitText(prefix), '前缀命中');
  assert.equal(core.entryHitText({ result: {} }), '未命中');
  assert.equal(core.entryElapsed(prefix), '2.4');
});

test('历史详情与累计统计都用同一套命中与用量口径', () => {
  const { core } = loadCore();
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.match(built, /entryHitText\(entry\)\} \/ \$\{entryElapsed\(entry\)\}s/);
  core.recordUsage({ graded: true, request: true, prompt: 1000, cached: 800, completion: 180, reasoning: 60 });
  assert.equal(core.loadUsageStats().reasoningTokens, 60);
});

test('思考模式归一化兼容旧布尔并支持 low/high/max', () => {
  const { api } = loadModules();
  assert.equal(api.normalizeThinkingMode(true), 'off');
  assert.equal(api.normalizeThinkingMode(false), 'auto');
  assert.equal(api.normalizeThinkingMode('off'), 'off');
  assert.equal(api.normalizeThinkingMode('low'), 'low');
  assert.equal(api.normalizeThinkingMode('HIGH'), 'high');
  assert.equal(api.normalizeThinkingMode('max'), 'max');
  assert.equal(api.normalizeThinkingMode('auto'), 'auto');
  assert.equal(api.normalizeThinkingMode('未知'), 'auto');
});

test('关闭模式仍注入 thinking.disabled 与 enable_thinking=false', () => {
  const { api } = loadModules();
  const offPayload = {};
  api.thinkingControl(offPayload, { disableThinkingKey: 'thinking', thinkingValues: { low: 'low' } }, 'off');
  assert.equal(offPayload.thinking.type, 'disabled');
  const sfPayload = {};
  api.thinkingControl(sfPayload, { disableThinkingKey: 'enable_thinking', thinkingValues: {} }, 'off');
  assert.equal(sfPayload.enable_thinking, false);
  const autoPayload = {};
  assert.equal(api.thinkingControl(autoPayload, { disableThinkingKey: 'thinking' }, 'auto').length, 0);
  assert.equal(Object.hasOwn(autoPayload, 'thinking'), false);
});

test('智谱 low 模式按官方格式发送 thinking.enabled + reasoning_effort=low', async () => {
  const { api, calls } = loadModules([{
    status: 200,
    responseText: JSON.stringify({ choices: [{ message: { content: 'ok' } }] })
  }]);
  await api.chatCompletion(
    { platform: 'zhipu', endpoint: '', model: 'glm-5.3-flash', apiKey: 'k', thinkingMode: 'low' },
    [{ role: 'user', content: 'hi' }],
    { retries: 0 }
  );
  const body = JSON.parse(calls[0].data);
  assert.equal(typeof body.thinking, 'object');
  assert.equal(body.thinking.type, 'enabled');
  assert.notEqual(body.thinking.type, 'disabled');
  assert.equal(body.reasoning_effort, 'low');
});

test('强度模式探测不因响应含思考内容而误判失败', async () => {
  const { api } = loadModules([{
    status: 200,
    responseText: JSON.stringify({ choices: [{ message: { content: '答案', reasoning_content: 'step1' } }] })
  }]);
  const result = await api.probeThinking({ platform: 'zhipu', endpoint: '', model: 'glm-5.3-flash', apiKey: 'k', thinkingMode: 'max' });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'max');
  assert.match(result.verdict, /max/);
  assert.match(result.verdict, /正常/);
});

test('强度模式遇到 400 不静默降级（保留用户选择如实报错）', async () => {
  const errorResponse = { status: 400, responseText: '{"error":{"code":"1210","message":"不支持"}}' };
  const { api, calls } = loadModules([errorResponse, errorResponse]);
  await assert.rejects(
    () => api.chatCompletion(
      { platform: 'zhipu', endpoint: '', model: 'glm-5.3-flash', apiKey: 'k', thinkingMode: 'high' },
      [{ role: 'user', content: 'hi' }],
      { retries: 1 }
    ),
    /HTTP 400/
  );
  // 400 不可重试：仅一次请求，且仍携带 high 强度（没有被删除降级重试）
  assert.equal(calls.length, 1);
  const first = JSON.parse(calls[0].data);
  assert.equal(first.thinking.type, 'enabled');
  assert.equal(first.reasoning_effort, 'high');
});

test('旧配置备份中的 disableThinking 自动迁移为 thinkingMode', () => {
  const { api } = loadModules();
  const store = api.DEFAULT_CONFIG;
  assert.equal(store.pipeline.thinkingMode, 'off');
  assert.equal(Object.hasOwn(store.pipeline, 'disableThinking'), false);
});

test('界面使用思考模式下拉菜单而非关闭勾选框', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  assert.match(built, /pipeline\.thinkingMode/);
  assert.match(built, /THINKING_LEVEL_LABELS/);
  assert.match(built, /getPlatformThinkingLevels/);
  assert.doesNotMatch(built, /data-field="pipeline\.disableThinking"/);
});

test('所有平台的思考只暴露两档：关闭 / 模型默认', () => {
  const { api } = loadModules();
  for (const platform of ['custom', 'opencode-ai', 'deepseek', 'sensenova', 'siliconflow', 'moonshot', 'dashscope', 'zhipu', 'volcengine-chat']) {
    assert.equal(Array.from(api.resolveProfile({ platform }).thinkingLevels).join(','), 'off,auto', platform);
  }
  assert.equal(api.getPlatformPreset('sensenova').endpoint, 'https://token.sensenova.cn/v1/chat/completions');
});

test('历史档位收敛为模型默认，关闭与默认保持原样', () => {
  const { api } = loadModules();
  assert.equal(api.clampThinkingLevel('deepseek', 'off'), 'off');
  assert.equal(api.clampThinkingLevel('deepseek', 'auto'), 'auto');
  assert.equal(api.clampThinkingLevel('sensenova', 'xhigh'), 'auto');
  assert.equal(api.clampThinkingLevel('zhipu', 'low'), 'auto');
  assert.equal(api.clampThinkingLevel('custom', 'max'), 'auto');
  assert.equal(api.clampThinkingLevel('custom', ''), 'auto');
});

test('智谱「关闭」不注入参数，商汤与 DeepSeek 用 reasoning_effort=none 关闭', () => {
  const { api } = loadModules();
  const zhipu = api.resolveProfile({ platform: 'zhipu', endpoint: 'https://example.com/v1/chat/completions', model: 'glm-4v-flash', apiKey: 'k' });
  const zhipuPayload = { model: 'm', messages: [] };
  assert.equal(api.thinkingControl(zhipuPayload, zhipu, 'off').length, 0);
  assert.equal(zhipuPayload.thinking, undefined);

  for (const platform of ['sensenova', 'deepseek']) {
    const profile = api.resolveProfile({ platform, endpoint: 'https://example.com/v1/chat/completions', model: 'm', apiKey: 'k' });
    const payload = { model: 'm', messages: [] };
    assert.equal(api.thinkingControl(payload, profile, 'off').join(','), 'reasoning_effort', platform);
    assert.equal(payload.reasoning_effort, 'none', platform);
  }
});

test('强制思考按模型判断：GLM-5.3 系列 + 运行时记忆', () => {
  const { api } = loadModules();
  assert.equal(api.isForcedThinkingModel('zhipu', 'glm-5.3'), true);
  assert.equal(api.isForcedThinkingModel('zhipu', 'GLM-5.3-FLASH'), true);
  assert.equal(api.isForcedThinkingModel('zhipu', 'glm-5.3-flash-2509'), true);
  assert.equal(api.isForcedThinkingModel('zhipu', 'glm-5.30'), false);
  assert.equal(api.isForcedThinkingModel('zhipu', 'glm-4v-flash'), false);
  assert.equal(api.isForcedThinkingModel('sensenova', 'sensenova-6.8-flash'), false);

  // 运行期学到的模型也要记住，且按平台+模型区分
  api.markForcedThinking('sensenova', 'sensenova-6.8-pro');
  assert.equal(api.isForcedThinkingModel('sensenova', 'sensenova-6.8-pro'), true);
  assert.equal(api.isForcedThinkingModel('zhipu', 'sensenova-6.8-pro'), false);
  assert.equal(Object.keys(api.loadForcedThinking()).length, 1);
});

test('400 提示不支持关闭思考时自动降级重试并记住模型', async () => {
  const { api, calls } = loadModules([
    { status: 400, responseText: JSON.stringify({ error: { message: '该模型始终思考，不支持关闭思考', code: 1210 } }) },
    { status: 200, responseText: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }
  ]);
  let forced = 0;
  const content = await api.chatCompletion(
    { platform: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash', apiKey: 'k', thinkingMode: 'off' },
    [{ role: 'user', content: 'hi' }],
    { onThinkingForced: () => { forced += 1; } }
  );
  assert.equal(content, 'ok');
  assert.equal(forced, 1);
  assert.equal(calls.length, 2);
  // 第一次带关闭参数，被拒后第二次去掉该参数重试
  assert.equal(JSON.parse(calls[0].data).reasoning_effort, 'none');
  assert.equal(JSON.parse(calls[1].data).reasoning_effort, undefined);
});

test('商汤日日新的强度参数按档位传递', async () => {
  const { api, calls } = loadModules([{ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }]);
  const service = { platform: 'sensenova', endpoint: 'https://token.sensenova.cn/v1/chat/completions', model: 'sensenova-6.8-flash', apiKey: 'k', thinkingMode: 'xhigh' };
  await api.chatCompletion(service, [{ role: 'user', content: 'hi' }], {});
  assert.equal(JSON.parse(calls[0].data).reasoning_effort, 'xhigh');
});

test('商汤日日新用 token.sensenova.cn 拉模型列表，视觉模型排前', async () => {
  const { api, calls } = loadModules([{
    status: 200,
    responseText: JSON.stringify({
      data: [
        { id: 'sensenova-text-1', input_modalities: ['text'] },
        { id: 'sensenova-6.8-flash', input_modalities: ['text', 'image'], context_length: 1048576 },
        { id: 'sensenova-6.8-pro', input_modalities: ['text', 'image'] }
      ]
    })
  }]);
  const models = await api.fetchModels({
    platform: 'sensenova',
    endpoint: 'https://token.sensenova.cn/v1/chat/completions',
    apiKey: 'k'
  });
  assert.equal(calls[0].url, 'https://token.sensenova.cn/v1/models');
  assert.equal(Array.from(models).join(','), 'sensenova-6.8-flash,sensenova-6.8-pro,sensenova-text-1');
  assert.equal(api.resolveProfile({ platform: 'sensenova' }).modelsUrl, 'https://token.sensenova.cn/v1/models');
  // 其他平台仍按接口地址推导 /models
  const other = loadModules([{ status: 200, responseText: JSON.stringify({ data: [] }) }]);
  await other.api.fetchModels({ platform: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', apiKey: 'k' }).catch(() => null);
  assert.equal(other.calls[0].url, 'https://api.deepseek.com/models');
});

test('响应里的 usage 会被回传，且不产生额外请求', async () => {
  const { api, calls } = loadModules([{
    status: 200,
    responseText: JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1200, completion_tokens: 180, prompt_cache_hit_tokens: 900 }
    })
  }]);
  let usage = null;
  await api.chatCompletion(
    { platform: 'custom', endpoint: 'https://example.com/v1/chat/completions', model: 'm', apiKey: 'k' },
    [{ role: 'user', content: 'hi' }],
    { onUsage: (value) => { usage = value; } }
  );
  assert.equal(calls.length, 1);
  assert.equal(usage.prompt, 1200);
  assert.equal(usage.completion, 180);
  assert.equal(usage.cached, 900);
});

test('历史记录定位复用平台阅卷记录链路', () => {
  const built = readFileSync(join(root, 'dist', '智阅批改助手.user.js'), 'utf8');
  // 观察器必须把「阅卷记录里跳卷」也算当前卷，否则跳转后 scanRecordId 不刷新，缓存与换卷判定全部错位
  assert.match(built, /var HOOK_LOAD = \/loadMarked\/i;/);
  assert.match(built, /HOOK_CURRENT\.test\(url\) \|\| HOOK_NAV\.test\(url\) \|\| HOOK_LOAD\.test\(url\)/);
  // 历史面板把「定位」接到主流程
  assert.match(built, /onJump: \(entry, fromQueue\) => \{/);
  assert.match(built, /jumpToMarkedRecord\(entry, \{/);
  // 回评走页面自己的组件方法，不自己拼接口
  assert.match(built, /returnMarkingPushToCherkItem\(record\.id, void 0, item\)/);
  // 学号是定位的钥匙，必须写进历史身份
  assert.match(built, /userCode: observedIdentity\.userCode \|\| ""/);
  assert.match(built, /markingPaperId: observedIdentity\.markingPaperId \|\| ""/);
});

test('历史里的坏记录不会让面板打不开', () => {
  const code = readSource('src/ui/history.ts');
  const context = { console: { log() {}, warn() {}, error() {} } };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${code}\n;globalThis.__normalize = normalizeHistoryEntries;`, context);
  const normalize = context.__normalize;
  const entries = [
    null,
    { id: 'a', question: { maxScore: 5 } },
    { id: 'b', question: { maxScore: 2 }, result: null },
    { id: 'c', question: { maxScore: 3 }, result: { score: 1, needsReview: false } }
  ];
  const fixed = normalize(entries);
  assert.equal(fixed.length, 3);
  assert.equal(fixed[0].id, 'a');
  assert.equal(fixed[0].result.needsReview, true);
  assert.equal(fixed[0].result.maxScore, 5);
  assert.equal(fixed[1].result.reviewReasons[0], '\u5206\u6570\u4E22\u5931');
  assert.equal(fixed[2].result.score, 1);
  assert.equal(fixed[2].result.needsReview, false);
  assert.equal(normalize(null).length, 0);
});

test('学科题型矩阵：每个题型都有专门口径，地理补上填空题', () => {
  const code = readFileSync(join(root, 'src/core/rubric-generator.ts'), 'utf8');
  const context = { console: { log() {}, warn() {}, error() {} } };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${code}\n;globalThis.__g = { RUBRIC_SUBJECTS, RUBRIC_TYPE_HINTS, rubricTypeHint, rubricRuleSummary };`, context);
  const gen = context.__g;
  const genericPrefix = '按点给分：逐条列出可判定的得分点';
  // 每个学科 × 题型都必须命中专门提示，不能悄悄退回通用那句（否则切换题型等于没切）
  for (const [subject, types] of Object.entries(gen.RUBRIC_SUBJECTS)) {
    for (const type of types) {
      assert.ok(gen.RUBRIC_TYPE_HINTS[type], `${subject}/${type} 缺少专门判分口径`);
      assert.ok(!gen.rubricTypeHint(subject, type).startsWith(genericPrefix), `${subject}/${type} 退回了通用提示`);
    }
  }
  assert.ok(gen.RUBRIC_SUBJECTS['地理'].includes('填空题'));
  assert.ok(gen.RUBRIC_SUBJECTS['数学'].includes('填空题'));
  // 同学科不同题型要写出不同口径，同题型跨学科也要有差异
  assert.match(gen.rubricTypeHint('地理', '读图题'), /图例/);
  assert.notEqual(gen.rubricTypeHint('地理', '读图题'), gen.rubricTypeHint('地理', '综合题'));
  assert.match(gen.rubricTypeHint('化学', '填空题'), /化学式/);
  assert.notEqual(gen.rubricTypeHint('化学', '填空题'), gen.rubricTypeHint('地理', '填空题'));
  assert.match(gen.rubricRuleSummary('地理', '填空题'), /^按点给分/);
  assert.match(gen.rubricRuleSummary('语文', '作文'), /^档次给分/);
});

test('评分标准库按「试卷 + 题号」存取，空内容不入库', () => {
  const files = ['src/infra/storage.ts', 'src/config.ts', 'src/core/rubric-library.ts'];
  const saved = new Map();
  let hookPaperId = '';
  const context = {
    console: { log() {}, warn() {}, error() {} },
    hookCurrentField: (key) => (key === 'markingPaperId' ? hookPaperId : ''),
    // 真实产物里这个函数在 zhixue-jump.ts，测试单独装载库模块时补一个同口径的桩。
    jumpApiTopicNum: (value) => {
      const text = String(value || '').trim();
      const match = text.match(/^(\d+)\s*[（(]\s*(\d+)\s*[)）]$/);
      return match ? `${match[1]},${match[2]}` : text;
    },
    GM_getValue: (key) => (saved.has(key) ? saved.get(key) : ''),
    GM_setValue: (key, value) => { saved.set(key, value); }
  };
  context.globalThis = context;
  vm.createContext(context);
  const code = files.map((rel) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')).join('\n');
  vm.runInContext(`${code}\n;globalThis.__lib = { rubricSlotKey, putRubricPreset, getRubricPreset, removeRubricPreset, countRubricPresets, rubricHasContent, sameRubricContext, rubricContextFields, loadRubricLibrary, normalizeRubricSlot };`, context);
  const lib = context.__lib;

  const question = { topicNumStr: '43,1', identity: { markingPaperId: 'paper-1' } };
  assert.equal(lib.rubricSlotKey(question), 'paper-1|43,1');
  // 没有试卷 ID 时退回纯题号，旧记录也能用
  assert.equal(lib.rubricSlotKey({ topicNumStr: '44', identity: {} }), 'paper|44');
  assert.equal(lib.rubricSlotKey(null), '');
  assert.equal(lib.normalizeRubricSlot('paper-1|43(1)'), 'paper-1|43,1');
  // 接口身份到位后，通用槽与真实试卷槽必须归一到同一个键。
  hookPaperId = 'paper-live';
  assert.equal(lib.rubricSlotKey({ topicNumStr: '43(1)', identity: {} }), 'paper-live|43,1');
  assert.equal(lib.normalizeRubricSlot('paper|43(1)'), 'paper-live|43,1');
  hookPaperId = '';

  // 老版本存过 DOM 口径：读取时合并到接口口径，重复槽取更新的那份。
  saved.set('zygr.rubrics.v1', JSON.stringify({
    'paper-1|43(1)': { answer: 'OLD', updatedAt: 10 },
    'paper-1|43,1': { answer: 'NEW', updatedAt: 20 }
  }));
  assert.equal(lib.getRubricPreset('paper-1|43(1)').answer, 'NEW');
  assert.equal(lib.countRubricPresets(), 1);
  assert.deepEqual(Object.keys(JSON.parse(saved.get('zygr.rubrics.v1'))), ['paper-1|43,1']);

  assert.equal(lib.putRubricPreset('paper-1|43,1', { answer: 'A', rubric: 'B', maxScore: 2, subject: '地理' }), true);
  const preset = lib.getRubricPreset('paper-1|43,1');
  assert.equal(preset.answer, 'A');
  assert.equal(preset.maxScore, 2);
  assert.equal(lib.countRubricPresets(), 1);

  // 全空的上下文不占位
  assert.equal(lib.putRubricPreset('paper-1|43,2', { answer: '  ', rubric: '', question: '' }), false);
  assert.equal(lib.getRubricPreset('paper-1|43,2'), null);

  assert.equal(lib.rubricHasContent({ answer: 'x' }), true);
  assert.equal(lib.rubricHasContent({ maxScore: 5 }), false);
  assert.equal(lib.sameRubricContext({ answer: 'A', rubric: 'B', maxScore: 2 }, { answer: 'A', rubric: 'B', maxScore: 2 }), true);
  assert.equal(lib.sameRubricContext({ answer: 'A' }, { answer: 'C' }), false);
  // 书签字段不能混进配置
  assert.deepEqual(Object.keys(lib.rubricContextFields({ answer: 'A', updatedAt: 1 })), ['question', 'answer', 'rubric', 'maxScore', 'subject']);

  assert.equal(lib.removeRubricPreset('paper-1|43,1'), true);
  assert.equal(lib.getRubricPreset('paper-1|43,1'), null);
  assert.equal(lib.removeRubricPreset('paper-1|43,1'), false);
});

test('复核队列：提交后自动推进下一条待复核', () => {
  const main = readSource('src/main.ts');
  assert.match(main, /let reviewQueueActive = false;/);
  assert.match(main, /function pendingReviewEntries\(\)/);
  assert.match(main, /entry\.result\?\.needsReview && !entry\.reviewedAt && canJumpRecord\(entry\)/);
  assert.match(main, /if \(!options\.silent && reviewQueueActive\) scheduleReviewAdvance\(\);/);
  assert.match(main, /await jumpToHistory\(pending\[0\], \{ fromQueue: true \}\)/);
  assert.match(main, /if \(options\.fromQueue\) reviewQueueActive = true;/);
  assert.match(main, /!result\.changed && \(!expectedUser \|\| observedUser !== expectedUser\)/);
  assert.match(main, /\\u56DE\\u8BC4\\u540E\\u6CA1\\u770B\\u5230\\u76EE\\u6807\\u5377/);
  assert.match(main, /定位失败就退出队列模式/);
  assert.match(main, /if \(!fromQueue\) reviewQueueActive = false;/);
  const history = readSource('src/ui/history.ts');
  assert.match(history, /this\.callbacks\.onJump\?\.\(next, true\)/);
});

test('复核队列：定位后重批更新原记录、换卷与提交后退出重批归属', () => {
  const main = readSource('src/main.ts');
  assert.match(main, /let regradeTargetId = "";/);
  assert.match(main, /regradeTargetId = "";\s*\n\s*const previousSlot = rubricSlotKey/);
  assert.match(main, /regradeTargetId = entry\?\.id \|\| "";/);
  assert.match(main, /const regradeTarget = regradeTargetId && loadHistory\(\)\.find/);
  assert.match(main, /regradeTarget\?\.id \|\| `\$\{Date\.now\(\)\}-\$\{Math\.random\(\)/);
  assert.match(main, /reviewedAt: void 0,\s*\n\s*reviewNote: void 0/);
  assert.match(main, /lastResult = null;\s*\n\s*\/\/ 这份已提交，重批归属到此结束；下一份若来自队列，jumpToHistory 会重新设置。\s*\n\s*regradeTargetId = "";/);
  assert.match(main, /if \(!fromQueue\) reviewQueueActive = false;/);
});
