const site = 'https://www.eveonline.com';
const repository = 'mrd-e/CEVE-History';
const workflow = `https://api.github.com/repos/${repository}/actions/workflows/news.yml`;
const loreSite = 'https://universe.eveonline.com';
// 与 scripts/news-lore.mjs 的 LORE_COLUMNS、scripts/ci-news/sync.py 同序，测试核对三处一致。
const loreColumns = ['new-eden-news', 'interstellar-correspondents', 'chronicles', 'short-stories',
  'scientific-articles', 'empires', 'factions', 'lore'];

async function checked(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} 返回 HTTP ${response.status}`);
  return response;
}

async function patchChanged(state) {
  const news = await (await checked(`${site}/news`)).text();
  const slug = news.match(/<a\b[^>]*href="\/news\/view\/(patch-notes-version-[\d-]+)"[^>]*>\s*<strong>Patch Notes<\/strong>/i)?.[1];
  if (!slug) throw new Error('官网新闻页未找到当前补丁');
  if (slug !== state.patch) return true;
  const html = await (await checked(`${site}/news/view/${slug}`)).text();
  const script = html.match(/window\.APOLLO_STATE\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
  if (!script) throw new Error('补丁页缺少文章数据');
  const data = JSON.parse(script[1]);
  const resolve = value => value?.__ref ? data[value.__ref] : value;
  for (const [key, value] of Object.entries(data.ROOT_QUERY)) {
    if (!key.startsWith('articleCollection(')) continue;
    const args = JSON.parse(key.slice('articleCollection('.length, -1));
    if (args.locale !== 'en' || args.where?.slug !== slug) continue;
    const article = resolve(resolve(value)?.items?.[0]);
    const updated = resolve(article?.sys)?.publishedAt;
    if (updated) return updated !== state.patchPublishedAt;
  }
  throw new Error('补丁页缺少英文版本时间');
}

// 正史栏目 RSS 的 pubDate 是最后修改时间；起点前首发的旧文由收录任务按原文发布日期排除。
async function loreChanged(lore) {
  if (!lore) return false;
  for (const column of loreColumns) {
    const rss = await (await checked(`${loreSite}/feed/${column}.rss`)).text();
    const items = [...rss.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
    if (!items.length) throw new Error(`正史 ${column} RSS 缺少条目`);
    for (const [, item] of items) {
      const key = item.match(/<link>\s*https:\/\/universe\.eveonline\.com\/([a-z0-9-]+\/[A-Za-z0-9][A-Za-z0-9-]*)\/?\s*<\/link>/i)?.[1];
      const updated = Date.parse(item.match(/<pubDate>([^<]+)<\/pubDate>/i)?.[1]);
      if (!key || Number.isNaN(updated)) throw new Error(`正史 ${column} RSS 条目格式异常`);
      const day = new Date(updated).toISOString().slice(0, 10);
      if (day >= lore.since && !lore.seen.includes(key) && !lore.pending.includes(key)) return true;
    }
  }
  return false;
}

export default {
  async scheduled(event, env) {
    const stateResponse = await fetch(`https://raw.githubusercontent.com/${repository}/main/.github/news-state.json`);
    if (!stateResponse.ok && stateResponse.status !== 404) throw new Error(`读取订阅状态失败 HTTP ${stateResponse.status}`);
    const state = stateResponse.ok ? await stateResponse.json() : null;
    // 额度恢复前不调度翻译；已完成文章仍可请求部署。
    if (state?.modelRetryAfter && Date.parse(state.modelRetryAfter) > event.scheduledTime && !state.deploy) return;
    const rss = await (await checked(`${site}/rss`)).text();
    const items = [...rss.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
    if (!items.length) throw new Error('RSS 缺少新闻条目');
    const hasNewArticle = items.map(([, item]) => {
      const slug = item.match(/<link>\s*https?:\/\/(?:www\.)?eveonline\.com\/(?:en\/)?news\/view\/([\w-]+)\/?(?:[?#][^<]*)?\s*<\/link>/i)?.[1];
      if (!slug) throw new Error('RSS 新闻链接格式异常');
      return slug;
    }).some(slug => !state?.feed.includes(slug) && !state?.baseline.includes(slug));
    const hourly = new Date(event.scheduledTime).getUTCMinutes() === 0;
    if (state && !hasNewArticle && !(hourly && (state.pending.length || state.lore?.pending.length || state.deploy ||
      await patchChanged(state) || await loreChanged(state.lore)))) return;

    const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'ceve-history-news' };
    const runs = await (await checked(`${workflow}/runs?branch=main&per_page=5`, { headers })).json();
    if (runs.workflow_runs.some(run => run.status !== 'completed')) return;
    await checked(`${workflow}/dispatches`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: 'main' })
    });
  }
};
