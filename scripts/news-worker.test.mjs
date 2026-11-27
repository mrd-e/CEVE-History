import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../.github/news-worker.mjs';
import { LORE_COLUMNS } from './news-lore.mjs';

const clock = Date.parse('2026-11-25T12:00:00Z');
const patch = 'patch-notes-version-24-02';
const baseState = { feed: ['seen'], baseline: [], pending: ['pending'], deploy: false, patch };
const quiet = { ...baseState, pending: [], patchPublishedAt: '2026-11-20T11:00:10Z' };
const lore = { since: '2026-09-23', seen: ['new-eden-news/done'], pending: [] };
const loreItem = (key, date) => `<item><link>https://universe.eveonline.com/${key}</link><pubDate>${date}</pubDate></item>`;
const oldFeed = loreItem('empires/old', 'Sat, 13 Nov 2021 17:44:17 GMT');
const patchPage = `<script>window.APOLLO_STATE = ${JSON.stringify({ ROOT_QUERY: {
  [`articleCollection(${JSON.stringify({ locale: 'en', where: { slug: patch } })})`]: { items: [{ sys: { publishedAt: quiet.patchPublishedAt } }] },
} })};</script>`;

async function scheduled(t, state, { runs = [], feeds = {}, time = clock } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url.includes('raw.githubusercontent.com')) return Response.json(state);
    if (url.endsWith('/rss')) return new Response('<rss><channel><item><link>https://www.eveonline.com/news/view/seen</link></item></channel></rss>');
    if (url.endsWith('eveonline.com/news')) return new Response(`<a href="/news/view/${patch}"><strong>Patch Notes</strong></a>`);
    if (url.endsWith(`/news/view/${patch}`)) return new Response(patchPage);
    const column = url.match(/universe\.eveonline\.com\/feed\/([a-z-]+)\.rss$/)?.[1];
    if (column) return new Response(`<rss><channel>${feeds[column] ?? oldFeed}</channel></rss>`);
    if (url.includes('/runs?')) return Response.json({ workflow_runs: runs });
    if (url.endsWith('/dispatches')) return new Response(null, { status: 204 });
    throw new Error(`意外请求 ${url}`);
  });
  await worker.scheduled({ scheduledTime: time }, { GITHUB_TOKEN: 'test-token' });
  return calls;
}

const dispatched = calls => calls.some(c => c.url.endsWith('/dispatches'));
const loreFeeds = calls => calls.map(c => c.url.match(/\/feed\/([a-z-]+)\.rss$/)?.[1]).filter(Boolean);

test('额度恢复前既不检查新稿也不调度模型', async t => {
  const calls = await scheduled(t, { ...baseState, modelRetryAfter: '2026-11-25T14:00:00Z' });
  assert.equal(calls.length, 1);
});

test('额度已恢复时继续处理待办', async t => {
  const calls = await scheduled(t, { ...baseState, modelRetryAfter: '2026-11-25T11:00:00Z' });
  assert.equal(calls.at(-1).options.method, 'POST');
});

test('额度等待期间仍可发布已经完成的文章', async t => {
  const calls = await scheduled(t, { ...baseState, deploy: true, modelRetryAfter: '2026-11-25T14:00:00Z' });
  assert.equal(calls.at(-1).options.method, 'POST');
});

test('已有运行时不会重复调度', async t => {
  const calls = await scheduled(t, baseState, { runs: [{ status: 'in_progress' }] });
  assert.equal(dispatched(calls), false);
});

test('整点查遍正史各栏目；已处理和起点前修改的条目不调度', async t => {
  const feeds = { 'new-eden-news': loreItem('new-eden-news/done', 'Wed, 11 Nov 2026 08:25:04 GMT') + loreItem('new-eden-news/older', 'Tue, 22 Sep 2026 23:59:59 GMT') };
  const calls = await scheduled(t, { ...quiet, lore }, { feeds });
  assert.deepEqual(loreFeeds(calls), LORE_COLUMNS.map(c => c.key));
  assert.equal(dispatched(calls), false);
});

test('整点发现起点后更新的正史条目即调度', async t => {
  const feeds = { chronicles: loreItem('chronicles/fresh', 'Wed, 23 Sep 2026 00:00:00 GMT') };
  assert.equal(dispatched(await scheduled(t, { ...quiet, lore }, { feeds })), true);
});

test('正史待办整点重试，非整点不查正史', async t => {
  assert.equal(dispatched(await scheduled(t, { ...quiet, lore: { ...lore, pending: ['chronicles/fresh'] } })), true);
  const feeds = { chronicles: loreItem('chronicles/fresh', 'Wed, 11 Nov 2026 08:25:04 GMT') };
  const calls = await scheduled(t, { ...quiet, lore }, { feeds, time: clock + 10 * 60 * 1000 });
  assert.deepEqual(loreFeeds(calls), []);
  assert.equal(dispatched(calls), false);
});

test('订阅状态还没有正史块时不查正史；栏目订阅异常时报错', async t => {
  assert.deepEqual(loreFeeds(await scheduled(t, quiet)), []);
  await assert.rejects(scheduled(t, { ...quiet, lore }, { feeds: { lore: '' } }), /正史 lore RSS 缺少条目/);
});
