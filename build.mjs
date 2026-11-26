#!/usr/bin/env node
// 构建：按 MODULES 顺序把 src 片段拼成单文件用户脚本。零依赖。
// 同时导出 buildOutput()，测试用它断言产物与源码完全一致。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outFile = join(root, 'dist', '智阅批改助手.user.js');

// 版本号只认 version.json：banner、README、测试都用它，避免三处各写一遍。
export const VERSION = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8')).version;

export const MODULES = [
  'src/adapters/zhixue.ts',
  'src/adapters/zhixue-hook.ts',
  'src/adapters/zhixue-jump.ts',
  'src/infra/storage.ts',
  'src/config.ts',
  'src/core/rubric-library.ts',
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
// @version      ${VERSION}
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
    `var ZYGR_VERSION = ${JSON.stringify(VERSION)};`,
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

// 只校验不写盘：CI / pre-commit 用它挡住「改了源码忘记重建 dist」。
export function checkBuild() {
  const output = buildOutput();
  const current = existsSync(outFile) ? readFileSync(outFile, 'utf8') : "";
  if (current === output) {
    console.log("dist \u4E0E\u6E90\u7801\u4E00\u81F4");
    return true;
  }
  console.error("dist \u4E0E\u6E90\u7801\u4E0D\u4E00\u81F4\uFF1A\u8BF7\u5148\u8FD0\u884C node build.mjs \u91CD\u65B0\u6784\u5EFA");
  return false;
}

// 只有直接执行时才写盘：测试 import 本模块不应产生副作用。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.includes("--check")) {
    if (!checkBuild()) process.exit(1);
  } else {
    buildAndWrite();
  }
}
