import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishNews } from './news-publication.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = 'patch-notes-version-24-02';
const source = '# Version\n\nIntro\n\n## Patch Notes for 2026-11-25.1\n\nFixed';
const body = '前言\n\n## **2026-11-25.1补丁说明**\n\n已修复';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'news-publication-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['src/news', '.github', 'scripts/ci-news']) mkdirSync(path.join(root, name), { recursive: true });
  copyFileSync(path.join(ROOT, 'scripts/ci-news/publication.py'), path.join(root, 'scripts/ci-news/publication.py'));
  const page = path.join(root, 'src/news', `${slug}.md`);
  const stateFile = path.join(root, '.github/news-state.json');
  writeFileSync(page, '原稿');
  writeFileSync(stateFile, JSON.stringify({ pending: [slug, 'other'], baseline: [], sections: {}, deploy: false, parallel: 42 }));
  const sourceFile = path.join(root, 'source.md');
  writeFileSync(sourceFile, source);
  return { root, page, stateFile, sourceFile };
}

test('收录与章节状态一同更新，保留其他待办和字段', t => {
  const f = fixture(t);
  publishNews({ root: f.root, slug, document: body, body, sourceFile: f.sourceFile });
  const state = JSON.parse(readFileSync(f.stateFile));
  assert.deepEqual(state.pending, ['other']);
  assert.equal(state.parallel, 42);
  assert.equal(state.deploy, true);
  assert.equal(state.sections[slug]['2026-11-25.1'].source.length, 64);
  assert.equal(readFileSync(f.page, 'utf8'), body);
});

test('没有实际英文快照时，页面和状态都不写', t => {
  const f = fixture(t);
  const before = readFileSync(f.stateFile, 'utf8');
  assert.throws(() => publishNews({ root: f.root, slug, document: body, body }), /英文快照/);
  assert.equal(readFileSync(f.page, 'utf8'), '原稿');
  assert.equal(readFileSync(f.stateFile, 'utf8'), before);
});

test('状态落盘失败还原原页面，不留下临时文件', t => {
  const f = fixture(t);
  const before = readFileSync(f.stateFile, 'utf8');
  const write = (file, ...args) => {
    if (file.endsWith('.json.tmp')) throw new Error('磁盘写入失败');
    writeFileSync(file, ...args);
  };
  assert.throws(() => publishNews({ root: f.root, slug, document: body, body, sourceFile: f.sourceFile, write }), /写入失败/);
  assert.equal(readFileSync(f.page, 'utf8'), '原稿');
  assert.equal(readFileSync(f.stateFile, 'utf8'), before);
  assert.equal(existsSync(`${f.stateFile}.tmp`), false);
});

test('已有译文仅补状态时保留正文；普通新闻不需要补丁快照', t => {
  const f = fixture(t);
  publishNews({ root: f.root, slug, document: '原稿', body, sourceFile: f.sourceFile, requestDeploy: true });
  assert.equal(readFileSync(f.page, 'utf8'), '原稿');
  const state = JSON.parse(readFileSync(f.stateFile));
  assert.equal(state.deploy, true);
  publishNews({ root: f.root, slug: 'other', document: '# 普通新闻\n\n正文', body: '正文' });
  assert.deepEqual(JSON.parse(readFileSync(f.stateFile)).pending, []);
});
