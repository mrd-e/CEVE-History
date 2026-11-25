import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../.github/news-worker.mjs';

const clock = Date.parse('2026-11-25T12:00:00Z');
const baseState = { feed: ['seen'], baseline: [], pending: ['pending'], deploy: false, patch: 'patch-notes-version-24-02' };

async function scheduled(t, state, runs = []) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url.includes('raw.githubusercontent.com')) return Response.json(state);
    if (url.endsWith('/rss')) return new Response('<rss><channel><item><link>https://www.eveonline.com/news/view/seen</link></item></channel></rss>');
    if (url.includes('/runs?')) return Response.json({ workflow_runs: runs });
    if (url.endsWith('/dispatches')) return new Response(null, { status: 204 });
    throw new Error(`意外请求 ${url}`);
  });
  await worker.scheduled({ scheduledTime: clock }, { GITHUB_TOKEN: 'test-token' });
  return calls;
}

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
  const calls = await scheduled(t, baseState, [{ status: 'in_progress' }]);
  assert.equal(calls.some(c => c.url.endsWith('/dispatches')), false);
});
