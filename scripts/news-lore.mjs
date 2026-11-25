// 正史板块：官方 lore 站（universe.eveonline.com）文章的链接、YC 纪年、页面格式、校验与英文稿提取。
// 本模块不读写磁盘；抓取通过可注入的 fetcher，CLI 在 news-workbench.mjs。
import matter from 'gray-matter';
import { defaultFetcher, newsExcerpt, normalizeBody, TRANSLATIONS, videoLink } from './news.mjs';

export const LORE_SITE = 'https://universe.eveonline.com';
const LORE_URL = /^https?:\/\/universe\.eveonline\.com\/([a-z0-9-]+)\/([A-Za-z0-9][A-Za-z0-9-]*)\/?(?:[?#].*)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YC = /^YC(\d{3})-(\d{2})-(\d{2})$/;
const YC_OFFSET = 1898;

// lore 站官方分类，按官网菜单顺序：News、Chronicles、Universe。key 即官方分类短名。
export const LORE_COLUMNS = [
  { key: 'new-eden-news', name: '新伊甸新闻', en: 'New Eden News' },
  { key: 'interstellar-correspondents', name: '星际通讯员', en: 'Interstellar Correspondents' },
  { key: 'chronicles', name: '编年史', en: 'Chronicles' },
  { key: 'short-stories', name: '短篇故事', en: 'Short Stories' },
  { key: 'scientific-articles', name: '科学文章', en: 'Scientific Articles' },
  { key: 'empires', name: '帝国', en: 'Empires' },
  { key: 'factions', name: '势力', en: 'Factions' },
  { key: 'lore', name: '背景设定', en: 'Lore' },
];
// 交叉列入的 eveonline.com 公告在宇宙目录里的栏目
export const LORE_CROSS_COLUMN = { key: 'eveonline-news', name: '官网新闻', en: 'EVE Online News' };
const columnByKey = new Map([...LORE_COLUMNS, LORE_CROSS_COLUMN].map(c => [c.key, c]));
export const loreColumn = key => columnByKey.get(key) ?? null;

/** lore 站文章链接 → { category, slug }；不是时返回 null。 */
export function parseLoreUrl(url) {
  const m = String(url ?? '').trim().match(LORE_URL);
  return m && m[1] !== 'id' ? { category: m[1], slug: m[2] } : null;
}

/** 公历日期 YYYY-MM-DD → YC 日期 YCnnn-MM-DD（公历年 = YC 年 + 1898，月日不变）。 */
export function ycDate(published) {
  const m = String(published ?? '').match(DATE);
  return m ? `YC${Number(m[1]) - YC_OFFSET}-${m[2]}-${m[3]}` : '';
}

/** YC 日期 → 公历日期。 */
export function ycToPublished(yc) {
  const m = String(yc ?? '').match(YC);
  return m ? `${Number(m[1]) + YC_OFFSET}-${m[2]}-${m[3]}` : '';
}

/**
 * 宇宙目录卡片：lore 站文章（有 column）与交叉列入的公告（lore: true）合在一起，按日期倒序。
 * cat 与公告卡片同形，目录复用公告的筛选脚本；month 取公历年，供按 YC 年分节。
 */
export function loreCards(items) {
  return (items ?? []).map(({ url, data, rawInput }) => {
    const date = String(data.published);
    const excerpt = newsExcerpt(rawInput);
    return {
      cat: data.column ? loreColumn(data.column) : LORE_CROSS_COLUMN,
      url, date, yc: data.yc ?? ycDate(date), year: date.slice(0, 4), month: date.slice(0, 4),
      title: data.title, titleEn: data.titleEn, excerpt, cover: data.cover,
      key: [data.title, data.titleEn, excerpt].join(' ').toLowerCase(),
    };
  }).sort((a, b) => b.date.localeCompare(a.date) || a.url.localeCompare(b.url));
}

const FIELD_ORDER = ['title', 'titleEn', 'source', 'yc', 'published', 'column', 'cover', 'translation'];

/** 生成宇宙文章文件文本，字段顺序固定。 */
export function loreDocument(data, body) {
  const ordered = Object.fromEntries(FIELD_ORDER.filter(k => data[k] !== undefined).map(k => [k, data[k]]));
  return matter.stringify(`\n${normalizeBody(body)}\n`, ordered).replace(/\n*$/, '\n');
}

export function validateLore(data, body, slug) {
  const errors = [];
  const fail = m => errors.push(`lore/${slug}：${m}`);
  if (!data.title?.trim()) fail('缺少中文标题 title');
  if (!data.titleEn?.trim()) fail('缺少英文标题 titleEn');
  const parsed = parseLoreUrl(data.source);
  if (!parsed || parsed.slug !== slug) fail(`source 必须是本篇 universe.eveonline.com 原文链接，且末段为 ${slug}`);
  if (!YC.test(String(data.yc ?? ''))) fail('yc 必须是 YCnnn-MM-DD');
  if (!DATE.test(String(data.published ?? ''))) fail('published 必须是 YYYY-MM-DD');
  else if (YC.test(String(data.yc ?? '')) && ycToPublished(data.yc) !== data.published) fail(`published 与 yc 不符：${data.yc} 应为 ${ycToPublished(data.yc)}`);
  if (!LORE_COLUMNS.some(c => c.key === data.column)) fail(`column 只能是 ${LORE_COLUMNS.map(c => c.key).join('、')}`);
  if (data.cover !== undefined && !/^https:\/\//.test(data.cover)) fail('cover 必须是 https 地址');
  if (!TRANSLATIONS[data.translation]) fail(`translation 只能是 ${Object.keys(TRANSLATIONS).join('、')}`);
  if (!String(body ?? '').trim()) fail('正文为空');
  if (/^\s*# /m.test(body ?? '')) fail('正文不能有一级标题，标题写在 title');
  return errors;
}

// ---------- 抓取英文稿 ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENTITIES[e.toLowerCase()] ?? all;
});
const absolute = url => (String(url).startsWith('//') ? `https:${url}` : String(url));
const VOID = new Set(['img', 'br', 'hr', 'source', 'input', 'meta', 'link', 'wbr']);

/** 极简 HTML 解析：只服务 lore 站服务端渲染的文章正文，返回 { tag, attrs, kids } 树。 */
function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, kids: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi;
  for (const m of html.matchAll(re)) {
    const top = stack.at(-1);
    if (m[5] !== undefined) top.kids.push({ text: decode(m[5]) });
    else if (m[1]) {
      const tag = m[1].toLowerCase();
      const i = stack.findLastIndex(n => n.tag === tag);
      if (i > 0) stack.length = i;
    } else if (m[2]) {
      const attrs = {};
      for (const a of (m[3] ?? '').matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
      const node = { tag: m[2].toLowerCase(), attrs, kids: [] };
      top.kids.push(node);
      if (!VOID.has(node.tag) && !m[4]) stack.push(node);
    }
  }
  return root;
}

/** 文章正文 HTML → Markdown。遇到未支持的标签报错，不静默丢内容。 */
export function loreHtmlMarkdown(html) {
  const inline = node => {
    if (node.text !== undefined) return node.text.replace(/\s+/g, ' ');
    const inner = () => node.kids.map(inline).join('');
    const wrap = mark => {
      const s = inner();
      const body = s.trim();
      return body ? s.match(/^\s*/)[0] + mark + body + mark + s.match(/\s*$/)[0] : s;
    };
    switch (node.tag) {
      case 'em': case 'i': return wrap('*');
      case 'strong': case 'b': return wrap('**');
      case 'code': return wrap('`');
      case 'span': case 'u': case 'sup': case 'sub': case 'small': return inner();
      case 'br': return '\n';
      case 'a': {
        const text = inner().trim();
        const href = absolute(node.attrs.href ?? '');
        return href && text ? `[${text}](${href})` : text;
      }
      case 'img': return `![${node.attrs.alt ?? ''}](${absolute(node.attrs.src ?? '')})`;
      default: throw new Error(`未支持的行内标签：<${node.tag}>`);
    }
  };
  const block = (node, depth = 0) => {
    if (node.text !== undefined) return node.text.trim();
    const kids = node.kids;
    const blocks = () => kids.map(k => block(k, depth)).filter(Boolean).join('\n\n');
    const tag = node.tag;
    if (tag === '#root' || tag === 'article' || tag === 'div' || tag === 'section' || tag === 'figure') return blocks();
    if (tag === 'p' || tag === 'figcaption') return kids.map(inline).join('').trim();
    if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Math.max(2, Number(tag[1])))} ${kids.map(inline).join('').trim()}`;
    if (tag === 'hr') return '---';
    if (tag === 'img') return inline(node);
    if (tag === 'iframe') return videoLink(node.attrs.title, absolute(node.attrs.src ?? ''));
    if (tag === 'blockquote') return blocks().split('\n').map(l => (l ? `> ${l}` : '>')).join('\n');
    if (tag === 'ul' || tag === 'ol') {
      return kids.filter(k => k.tag === 'li').map((li, i) => {
        const hasBlock = li.kids.some(k => ['p', 'ul', 'ol', 'div', 'blockquote'].includes(k.tag));
        const parts = hasBlock ? li.kids.map(k => (['ul', 'ol'].includes(k.tag) ? block(k, depth + 1) : k.tag === 'p' || k.tag === 'div' ? block(k, depth + 1) : inline(k).trim())).filter(Boolean) : [li.kids.map(inline).join('').trim()];
        const marker = tag === 'ol' ? `${i + 1}.` : '-';
        return `${'  '.repeat(depth)}${marker} ${parts[0]}${parts.slice(1).map(p => `\n${p}`).join('')}`;
      }).join('\n');
    }
    if (tag === 'table') {
      const rows = [];
      const collect = n => {
        if (n.tag === 'tr') rows.push(n.kids.filter(c => c.tag === 'td' || c.tag === 'th').map(c => c.kids.map(inline).join('').trim().replace(/\|/g, '\\|')));
        else for (const k of n.kids ?? []) collect(k);
      };
      collect(node);
      if (!rows.length) return '';
      const width = Math.max(...rows.map(r => r.length));
      const lines = rows.map(r => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`);
      return [lines[0], `|${' --- |'.repeat(width)}`, ...lines.slice(1)].join('\n');
    }
    // 行内标签直接出现在块级位置（如 <article> 下的 <em>）
    return inline(node).trim();
  };
  return block(parseHtml(html)).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * lore 站文章页 HTML → { meta, title, body }。
 * 元数据取 __NEXT_DATA__ 的 initialState：article.articles 中的文章对象，分类 ID 在 category 中查官方短名；
 * 正文取服务端渲染的 <article> 元素。
 */
export function loreFromHtml(html, url) {
  const parsed = parseLoreUrl(url);
  if (!parsed) throw new Error(`不是 universe.eveonline.com 文章链接：${url}`);
  const next = String(html).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!next) throw new Error('页面中没有 __NEXT_DATA__');
  const state = JSON.parse(next[1]).props?.initialState ?? {};
  const article = Object.values(state.article?.articles ?? {}).find(a => a?.slug === parsed.slug);
  if (!article) throw new Error(`页面数据中没有文章 ${parsed.slug}`);
  const column = state.category?.[article.category]?.slug ?? parsed.category;
  if (!LORE_COLUMNS.some(c => c.key === column)) throw new Error(`未知的官方分类：${column}`);
  const published = String(article.publicationDate ?? '').slice(0, 10);
  if (!DATE.test(published)) throw new Error(`发布日期无法识别：${article.publicationDate}`);
  const start = html.indexOf('<article');
  const end = html.indexOf('</article>', start);
  if (start < 0 || end < 0) throw new Error('页面中没有 <article> 正文');
  const cover = article.heroImage?.url ?? article.listingImage?.url;
  return {
    meta: {
      titleEn: String(article.title ?? '').trim(),
      source: `${LORE_SITE}/${parsed.category}/${parsed.slug}`,
      yc: ycDate(published),
      published,
      column,
      ...(cover ? { cover: absolute(cover) } : {}),
    },
    slug: parsed.slug,
    body: loreHtmlMarkdown(html.slice(start, end + '</article>'.length)),
  };
}

export async function fetchLore(url, fetcher = defaultFetcher) {
  const html = await fetcher(String(url).trim());
  if (html == null) throw new Error(`${url} 不存在`);
  return loreFromHtml(html, url);
}
