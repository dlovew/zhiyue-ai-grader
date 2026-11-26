#!/usr/bin/env node
// 构建：按 MODULES 顺序把 src 片段拼成单文件用户脚本。零依赖。
// 同时导出 buildOutput()，测试用它断言产物与源码完全一致。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outFile = join(root, 'dist', '智阅批改助手.user.js');

const MODULES = [
  'src/adapters/zhixue.ts',
  'src/adapters/zhixue-hook.ts',
  'src/infra/storage.ts',
  'src/config.ts',
  'src/core/cache.ts',
  'src/core/submit.ts',
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
// @version      1.0.6
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

// 拼接产物：纯函数，不读写磁盘，便于测试与 dist 逐字比对。
export function buildOutput() {
  const parts = MODULES.map((rel) => {
    const code = readFileSync(join(root, rel), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\n$/, '');
    return code;
  });
  return [
    BANNER,
    '"use strict";',
    '(() => {',
    ...parts,
    '})();',
    '',
  ].join('\n');
}

export function buildAndWrite() {
  const output = buildOutput();
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(outFile, output, 'utf8');
  console.log(`built ${outFile} (${(Buffer.byteLength(output, 'utf8') / 1024).toFixed(1)} KB)`);
  return output;
}

// 只有直接执行时才写盘：测试 import 本模块不应产生副作用。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) buildAndWrite();
