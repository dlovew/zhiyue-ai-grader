#!/usr/bin/env node
// 构建：按 MODULES 顺序把 src 片段拼成单文件用户脚本。零依赖。
// 每个 src 文件自带 `// src/xxx.ts` 边界注释，拼接后与原单文件脚本逐字等价。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outFile = join(root, 'dist', '智阅批改助手.user.js');

const MODULES = [
  'src/adapters/zhixue.ts',
  'src/infra/storage.ts',
  'src/config.ts',
  'src/core/cache.ts',
  'src/core/export.ts',
  'src/infra/platforms.ts',
  'src/infra/api.ts',
  'src/infra/image.ts',
  'src/core/prompt.ts',
  'src/core/rubric-generator.ts',
  'src/core/parse.ts',
  'src/core/pipeline.ts',
  'src/infra/rate-limit.ts',
  'src/ui/styles.ts',
  'src/ui/panel.ts',
  'src/ui/history.ts',
  'src/ui/settings.ts',
  'src/main.ts',
];

const BANNER = `// ==UserScript==
// @name         智阅批改助手
// @namespace    zygr.local.grader
// @version      1.0.2
// @description  智学网阅卷辅助：读取作答图并结合配置的评分标准进行多模态直评，支持历史导出。
// @match        *://www.zhixue.com/*
// @match        *://zhixue.com/*
// @match        *://*.zhixue.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      zhixue-sc.oss-cn-hangzhou.aliyuncs.com
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==`;

const parts = MODULES.map((rel) => {
  const code = readFileSync(join(root, rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\n$/, '');
  return code;
});

const output = [
  BANNER,
  '"use strict";',
  '(() => {',
  ...parts,
  '})();',
  '',
].join('\n');

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(outFile, output, 'utf8');
console.log(`built ${outFile} (${(Buffer.byteLength(output, 'utf8') / 1024).toFixed(1)} KB)`);
