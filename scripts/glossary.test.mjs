import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { auditGlossary, parseGlossary, glossaryEntries, glossaryLinks, queryGlossary, run, termId } from './glossary.mjs';

const record = (patch = {}) => ({ term: 'Test', meaning: '测试', avoid: '', note: '说明文字', status: '待复核', kind: 'term', links: [], ...patch });
const parse = entries => parseGlossary({ version: 1, entries });
const md = new MarkdownIt().use(glossaryLinks);
const links = html => [...html.matchAll(/data-glossary-id="([^"]+)"[^>]*>(.*?)<\/a>/g)].map(m => ({ id: m[1], word: m[2] }));

test('命令行帮助直接输出文本，帮助参数不能掩盖查询或校验参数', () => {
  assert.equal(typeof run(['--help']), 'string');
  assert.throws(() => run(['Monitor', '--help']), /单独使用/);
  assert.throws(() => run(['--help', '--check']), /单独使用/);
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./glossary.mjs', import.meta.url)), '--help'], { encoding: 'utf8' });
  assert.ok(output.includes('npm run glossary --'));
  assert.throws(() => JSON.parse(output), SyntaxError);
});

test('JSON保留竖线和上下文；类别与是否标注不由备注或确认状态推定，锚点沿用原算法', () => {
  const input = record({ term: 'Test🚀', note: '引用 `a|b`，不是表格字段', kind: 'ship', links: [{ word: '测试船' }] });
  const [entry] = parse([input]);
  assert.equal(entry.note, '引用 a|b，不是表格字段');
  assert.equal(input.note, '引用 `a|b`，不是表格字段');
  assert.equal(entry.id, 'term-54-65-73-74-1f680');
  const html = new MarkdownIt().use(glossaryLinks, { entries: [entry] }).render('测试船 Test🚀');
  assert.deepEqual(links(html), [{ id: entry.id, word: '测试船' }]);
  assert.equal(links(new MarkdownIt().use(glossaryLinks, { entries: parse([record({ note: '舰船名；旧说明', kind: 'ship' })]) }).render('测试')).length, 0);
});

test('拒绝重复词条、争用匹配文字和无效字段，保留明确错误', () => {
  assert.throws(() => parseGlossary({ version: 2, entries: [record()] }), /version/);
  assert.throws(() => parse([record(), record()]), /重复词条/);
  assert.throws(() => parse([record({ links: [{ word: '相同' }] }), record({ term: 'Other', links: [{ word: '相同' }] })]), /重复归属/);
  for (const patch of [{ status: '已读' }, { kind: 'guessed' }, { meaning: '' }, { avoid: null }, { links: null }, { link_note: '' }, { typo: true }]) {
    assert.throws(() => parse([record(patch)]), /术语档案/);
  }
  for (const link of [{ word: '' }, { word: ' word' }, { word: 'word', exclude_suffixes: [''] }, { word: 'word', exclude_suffixes: ['船', '船'] },
    { word: 'word', exclude_suffixes: [] }, { word: 'word', exclude_prefixes: '玉' }, { word: 'word', exclude_prefixes: ['玉', '玉'] }, { word: 'word', typo: true }]) {
    assert.throws(() => parse([record({ links: [link] })]), /术语档案/);
  }
});

test('保留最长匹配、英文边界，以及原有词条目标', () => {
  assert.deepEqual(links(md.render('卖水果 xMonitor Monitor2 大鱼')).map(l => l.word), ['卖水果', '大鱼']);
  const actual = links(md.render('大鱼 监视者'));
  assert.equal(actual.find(l => l.word === '大鱼').id, termId('大鱼'));
  assert.equal(actual.find(l => l.word === '监视者').id, termId('Monitor'));
  assert.deepEqual(links(md.render('救赎')), [{ id: termId('Absolution'), word: '救赎' }]);
});

test('每篇只标同一词条第一次出现，后续各种写法保持原文；重复处整词跳过', () => {
  assert.deepEqual(links(md.render('监视者 Monitor solo Solo\n\n水果 卖水果 水果')).map(l => l.word), ['监视者', 'solo', '水果']);
  // A repeated 狞獾 must not leave its inner 獾 (another ship) to be linked.
  assert.deepEqual(links(md.render('狞獾 狞獾级')).map(l => l.word), ['狞獾']);
  assert.deepEqual(links(md.render('狞獾')).map(l => l.word), ['狞獾'], '每次渲染重新计数');
});

test('人物外号、组织名和常用词不误标；需要时只认“X级”或按前后文排除', () => {
  const html = md.render('台风 黑鸦 万古 复仇 凤凰城 凤凰联盟群 银鹰骑士团 银鹰军团 冥府之光 泡泡船 泡泡手 泡泡仙人 泡泡金仙 网格里 玉麒麟 挑战级别\n\n凤凰 银鹰 冥府 泡泡 台风级 格里级 麒麟\n\n魔符级、激进级、獾级');
  assert.deepEqual(links(html).map(l => l.word), ['凤凰', '银鹰', '冥府', '泡泡', '台风级', '格里级', '麒麟', '魔符级', '激进级', '獾级']);
});

test('舰船词后紧跟的“级”一并加蓝，其他类别不吞“级”', () => {
  const entries = parse([record({ kind: 'term', links: [{ word: '测试' }] }), record({ term: 'Ship', kind: 'ship', links: [{ word: '船甲' }] })]);
  const plugin = new MarkdownIt().use(glossaryLinks, { entries });
  assert.deepEqual(links(plugin.render('测试级 船甲级舰队')).map(l => l.word), ['测试', '船甲级']);
  assert.deepEqual(links(md.render('神使级泰坦')).map(l => l.word), ['神使级']);
});

test('不改标题、引用、已有链接或代码，不把原文术语换成中文', () => {
  const input = '# Monitor\n\n> Monitor\n\n[Monitor](https://example.com) `Monitor`\n\n```\nMonitor\n```\n\nMonitor';
  const html = md.render(input);
  assert.equal(links(html).length, 1);
  assert.match(html, /<h1>Monitor<\/h1>/);
  assert.match(html, /<code>Monitor<\/code>/);
  assert.match(html, /href="https:\/\/example.com">Monitor<\/a>/);
  assert.equal(links(html)[0].word, 'Monitor');
});

test('查询支持中文、原词和匹配写法，按类别／状态筛选分页，无条件不输出全表', () => {
  assert.deepEqual(run([]).records, []);
  assert.equal(run(['monitor', '--kind', 'ship']).records[0].term, 'Monitor');
  assert.equal(run(['泡泡']).records.some(e => e.term === 'bubble / warp disruption bubble'), true);
  const first = run(['--status', '待复核', '--limit', '1']);
  const second = run(['--status', '待复核', '--limit', '1', '--offset', '1']);
  assert.equal(first.total, second.total);
  assert.notEqual(first.records[0].term, second.records[0].term);
  assert.equal(run(['--check']).valid, true);
  assert.equal(run(['--check']).entries, glossaryEntries.length);
  assert.throws(() => run(['--check', 'Monitor']), /不与/);
  assert.throws(() => run(['--status']), /缺少值/);
  assert.throws(() => run(['--unknown']), /未知选项/);
  assert.throws(() => queryGlossary(glossaryEntries, { status: '已读' }), /status/);
  assert.throws(() => run(['--limit', '0']), /正整数/);
  assert.throws(() => run(['--offset', '-1']), /非负整数/);
});

test('审计按站内渲染规则统计蓝字，并逐处标出这串文字是否加蓝', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-audit-'));
  try {
    const write = (file, body) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), body);
    };
    write('src/a/a.md', '---\ntitle: 测试船\n---\n测试船出场，测试船又来。\n\n::: 红料 测试船标题\n网测试\n:::\n\n> 测试船');
    write('src/b.md', '测试船');
    for (const file of ['src/_skip.md', 'src/a/materials-a.md', 'src/AGENTS.md', 'src/_data/c.md']) write(file, '测试船');
    const entries = parse([record({ kind: 'ship', links: [{ word: '测试船' }, { word: '测试', exclude_prefixes: ['网'] }] })]);
    const summary = await auditGlossary({ root, entries });
    assert.equal(summary.files, 2);
    assert.equal(summary.links, 2);
    assert.deepEqual(summary.records.map(r => [r.text, r.count]), [['测试船', 2]]);
    const found = await auditGlossary({ root, entries, query: '测试' });
    assert.equal(found.total, 4);
    assert.equal(found.linked, 2);
    assert.deepEqual(found.records.map(r => r.status).sort(), ['未标', '蓝字', '蓝字', '重复不加蓝'].sort());
    assert.ok(found.records.some(r => r.context.includes('网【测试】')));
    await assert.rejects(auditGlossary({ root, entries, limit: 0 }), /正整数/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.throws(() => run(['--audit', '--kind', 'ship']), /未知选项/);
  assert.throws(() => run(['--audit', '--audit']), /一次/);
});
