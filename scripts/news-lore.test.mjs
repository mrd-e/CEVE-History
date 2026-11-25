import assert from 'node:assert/strict';
import test from 'node:test';
import matter from 'gray-matter';
import { fetchLore, loreCards, loreDocument, loreFromHtml, loreHtmlMarkdown, parseLoreUrl, validateLore, ycDate, ycToPublished } from './news-lore.mjs';

const SLUG = 'sample-lore';
const SOURCE = `https://universe.eveonline.com/chronicles/${SLUG}`;
const valid = () => ({
  title: '示例编年史', titleEn: 'Sample Chronicle', source: SOURCE, yc: 'YC128-11-09', published: '2026-11-09',
  column: 'chronicles', translation: 'site',
});

test('YC 纪年：公历年 = YC 年 + 1898，月日不变', () => {
  assert.equal(ycDate('2026-11-09'), 'YC128-11-09');
  assert.equal(ycDate('2003-05-06'), 'YC105-05-06');
  assert.equal(ycToPublished('YC128-11-09'), '2026-11-09');
  assert.equal(ycDate('2026/11/09'), '');
  assert.equal(ycToPublished('YC28-11-09'), '');
});

test('parseLoreUrl：识别栏目与短名，拒绝其他站点和 /id/ 分享链接', () => {
  assert.deepEqual(parseLoreUrl(`${SOURCE}/?a=1`), { category: 'chronicles', slug: SLUG });
  assert.equal(parseLoreUrl(`https://www.eveonline.com/news/view/${SLUG}`), null);
  assert.equal(parseLoreUrl(`https://universe.eveonline.com/id/1ssjjCKWCcbRz5ayUFVE2r/${SLUG}`), null);
  assert.equal(parseLoreUrl(undefined), null);
});

test('validateLore：合格无错', () => {
  assert.deepEqual(validateLore(valid(), '正文', SLUG), []);
  assert.deepEqual(validateLore({ ...valid(), cover: 'https://images.ctfassets.net/a.jpg' }, '正文', SLUG), []);
});

test('validateLore：原文链接不是 lore 站或末段不符时报错', () => {
  const offSite = validateLore({ ...valid(), source: `https://forums.eveonline.com/t/${SLUG}` }, '正文', SLUG);
  assert.ok(offSite.some(e => e.includes('source') && e.includes(`lore/${SLUG}`)));
  const mismatch = validateLore({ ...valid(), source: 'https://universe.eveonline.com/chronicles/other' }, '正文', SLUG);
  assert.ok(mismatch.some(e => e.includes('source')));
});

test('validateLore：YC 日期缺失或与公历日期不一致时报错', () => {
  const missing = validateLore({ ...valid(), yc: undefined }, '正文', SLUG);
  assert.ok(missing.some(e => e.includes('yc')));
  const off = validateLore({ ...valid(), published: '2026-11-10' }, '正文', SLUG);
  assert.ok(off.some(e => e.includes('published 与 yc 不符') && e.includes('2026-11-09')));
});

test('validateLore：其他字段逐项报错', () => {
  const errors = validateLore({ ...valid(), title: '', titleEn: '', column: 'outlet', translation: 'x', cover: 'http://a' }, '# 标题', SLUG);
  for (const word of ['title', 'titleEn', 'column', 'translation', 'cover', '一级标题']) assert.ok(errors.some(e => e.includes(word)), word);
  assert.ok(validateLore(valid(), ' ', SLUG).some(e => e.includes('正文为空')));
});

test('loreDocument：字段顺序固定，可回读', () => {
  const text = loreDocument({ translation: 'site', column: 'chronicles', title: '标', titleEn: 'T', source: SOURCE, yc: 'YC128-11-09', published: '2026-11-09' }, '正文');
  assert.deepEqual(Object.keys(matter(text).data), ['title', 'titleEn', 'source', 'yc', 'published', 'column', 'translation']);
  assert.ok(text.endsWith('正文\n'));
});

test('loreHtmlMarkdown：标题、强调、链接、图片、列表、嵌入视频', () => {
  const md = loreHtmlMarkdown([
    '<article><h2>Head &amp; Title</h2>',
    '<p>Plain <em>italic</em> and <strong>bold</strong> with <a href="https://x.test/a">link</a>.</p>',
    '<p><img src="//images.ctfassets.net/a.png" alt="Pic"></p>',
    '<ul><li>One</li><li>Two <em>it</em></li></ul>',
    '<div data-wrapper="iframe"><iframe title="Clip" src="https://www.youtube.com/embed/abc"></iframe></div>',
    '</article>',
  ].join(''));
  assert.match(md, /^## Head & Title/);
  assert.ok(md.includes('Plain *italic* and **bold** with [link](https://x.test/a).'));
  assert.ok(md.includes('![Pic](https://images.ctfassets.net/a.png)'));
  assert.ok(md.includes('- One\n- Two *it*'));
  assert.ok(md.includes('https://www.youtube.com/embed/abc'));
  assert.throws(() => loreHtmlMarkdown('<article><p><marquee>x</marquee></p></article>'), /marquee/);
});

const page = (category = 'cat1') => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    initialState: {
      article: { articles: { a1: { slug: SLUG, title: 'Sample Chronicle', publicationDate: '2026-11-09T12:00:00.000Z', category, heroImage: { url: '//images.ctfassets.net/h.jpg' } } } },
      category: { cat1: { name: 'Chronicles', slug: 'chronicles' } },
    },
  },
})}</script><body><article class="x"><p>Body text.</p></article></body></html>`;

test('loreFromHtml：从页面数据取元数据，从 <article> 取正文', () => {
  const { meta, slug, body } = loreFromHtml(page(), SOURCE);
  assert.equal(slug, SLUG);
  assert.deepEqual(meta, {
    titleEn: 'Sample Chronicle', source: SOURCE, yc: 'YC128-11-09', published: '2026-11-09', column: 'chronicles',
    cover: 'https://images.ctfassets.net/h.jpg',
  });
  assert.equal(body, 'Body text.');
  assert.throws(() => loreFromHtml(page(), 'https://universe.eveonline.com/chronicles/other'), /没有文章 other/);
  assert.throws(() => loreFromHtml('<html></html>', SOURCE), /__NEXT_DATA__/);
});

test('loreCards：lore 站文章取栏目，交叉列入的公告标官网新闻并换算 YC 日期，按日期倒序', () => {
  const cards = loreCards([
    { url: '/news/x/', data: { title: '公告', titleEn: 'News', published: '2025-03-04', lore: true }, rawInput: '这是一段足够长的公告正文第一段，用来生成摘要。' },
    { url: `/lore/${SLUG}/`, data: valid(), rawInput: '这是一段足够长的编年史正文第一段，用来生成摘要。' },
  ]);
  assert.deepEqual(cards.map(c => [c.cat.key, c.yc, c.month]), [['chronicles', 'YC128-11-09', '2026'], ['eveonline-news', 'YC127-03-04', '2025']]);
  assert.equal(cards[1].cat.name, '官网新闻');
  assert.ok(cards[0].key.includes('sample chronicle') && cards[0].excerpt.includes('编年史'));
});

test('fetchLore：经注入的 fetcher 抓取，404 报错', async () => {
  assert.equal((await fetchLore(SOURCE, async () => page())).meta.column, 'chronicles');
  await assert.rejects(fetchLore(SOURCE, async () => null), /不存在/);
});
