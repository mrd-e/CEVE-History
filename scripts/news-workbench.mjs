#!/usr/bin/env node
// 天书工作台：把官方新闻（官方中文版或本站译文）写成 src/news/<短名>.md，正史文章写成 src/news/lore/<短名>.md，并校验天书、正史与折扣清单。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import {
  articleMeta, fetchArticle, newsCategory, newsDocument, officialChinese, parseNewsUrl, richTextMarkdown, splitTitle,
  validateNews,
} from './news.mjs';
import {
  CALENDAR_CHANNELS, CALENDAR_DEALS, dealReview, dealRules, loadCalendar, mergeDeals, missingCalendar, nearbyDeals,
  validateCalendar,
} from './news-calendar.mjs';
import { fetchLore, loreDocument, parseLoreUrl, UndatedLoreError, validateLore } from './news-lore.mjs';
import { publishNews } from './news-publication.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEWS_DIR = path.join(ROOT, 'src', 'news');
const LORE_DIR = path.join(NEWS_DIR, 'lore');
const CALENDAR_FILE = path.join(NEWS_DIR, 'calendar.json');
const INSTRUCTION_FILES = new Set(['AGENTS.md', 'CLAUDE.md']);

const HELP = `用法：npm run news -- <命令>

  official <英文链接> [--source-snapshot <英文快照.md>] [--force]
      官网有中文版时直接抓取写成页面（translation: official）；没有时退出码 3，需走翻译。
  add <英文链接> --file <中文.md> [--translation site|official] [--source-snapshot <英文快照.md>] [--force]
      用一篇中文 Markdown（首行“# 标题”）写成页面，元数据取自英文原文；默认 translation: site。
  import <目录> --registry <登记.jsonl> [--force]
      批量导入官方中文 Markdown：登记表每行含 local_path 与 url（中文页链接），按文件名匹配。
  lore <universe.eveonline.com 链接> --out <草稿.md>
      抓取正史英文原文，写出待译草稿（首行“# 英文标题”）；页面没有发布日期时退出码 3，不写草稿。
  lore <universe.eveonline.com 链接> --file <中文.md> [--force]
      用译文（首行“# 中文标题”）写成 src/news/lore/<短名>.md，元数据取自原文；translation: site。
  check [--slug <短名>]
      校验 src/news/、src/news/lore/ 与折扣清单。
  record <英文链接> [--source-snapshot <英文快照.md>]
      已手工编辑的页面同步订阅状态；补丁必须提供该译文所用的完整英文快照。
  deals <英文链接> [--source <英文.md>]
      已收录页面要不要增补折扣清单：输出判断材料 JSON（review 为 true 时含规则、同期条目与中英文正文）。
  deals <英文链接> --file <判断.json>
      把判断结果 { entries, link } 校验后并入 src/news/calendar.json；促销公告判断为空时记入 skip，以后不再判断。

已存在的页面默认不覆盖，加 --force 才重写（保留手工指定的 category、lore、toc、tocDepth）。`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') out.force = true;
    else if (a.startsWith('--')) {
      if (i + 1 >= argv.length) throw new Error(`${a} 缺少取值`);
      out[a.slice(2)] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

const pageFile = slug => path.join(NEWS_DIR, `${slug}.md`);

function slugOf(url) {
  const parsed = parseNewsUrl(url);
  if (!parsed) throw new Error(`不是 eveonline.com 新闻链接：${url}`);
  return parsed.slug;
}

/** 写页面；已存在且未加 --force 时跳过。返回 written / skipped。 */
function writePage(slug, data, body, force, options = {}) {
  const file = pageFile(slug);
  if (existsSync(file)) {
    if (!force) return 'skipped';
    const old = matter(readFileSync(file, 'utf8')).data;
    if (old.category) data = { ...data, category: old.category };
    if (old.lore !== undefined) data = { ...data, lore: old.lore };
    if (old.toc !== undefined) data = { ...data, toc: old.toc };
    if (old.tocDepth !== undefined) data = { ...data, tocDepth: old.tocDepth };
  }
  const errors = validateNews(data, body, slug);
  if (errors.length) throw new Error(errors.join('\n'));
  mkdirSync(NEWS_DIR, { recursive: true });
  return publishNews({ root: ROOT, slug, document: newsDocument(data, body), body, ...options });
}

function publicationOptions(args) {
  const inferred = args.file && path.join(path.dirname(args.file), 'source.md');
  return {
    sourceFile: args['source-snapshot'] ?? (inferred && existsSync(inferred) ? inferred : undefined),
    fingerprintsFile: args.fingerprints,
  };
}

async function englishMeta(slug) {
  const en = await fetchArticle(slug, 'en');
  if (!en) throw new Error(`${slug}：英文原文不存在或页面中没有文章对象`);
  return articleMeta(slug, en);
}

async function cmdOfficial(args) {
  const slug = slugOf(args._[1] ?? '');
  const zh = officialChinese(await fetchArticle(slug, 'zh'));
  if (!zh) {
    console.log(JSON.stringify({ slug, status: 'no_official_chinese' }));
    return 3;
  }
  const meta = await englishMeta(slug);
  const status = writePage(slug, { title: zh.title, ...meta, translation: 'official' }, zh.body, args.force, publicationOptions(args));
  console.log(JSON.stringify({ slug, status, file: path.relative(ROOT, pageFile(slug)) }));
  return 0;
}

async function cmdAdd(args) {
  const slug = slugOf(args._[1] ?? '');
  if (!args.file) throw new Error('add 需要 --file <中文.md>');
  const translation = args.translation ?? 'site';
  const { title, body } = splitTitle(readFileSync(args.file, 'utf8'));
  if (!title) throw new Error(`${args.file}：首行必须是“# 中文标题”`);
  const meta = await englishMeta(slug);
  const status = writePage(slug, { title, ...meta, translation }, body, args.force, publicationOptions(args));
  console.log(JSON.stringify({ slug, status, file: path.relative(ROOT, pageFile(slug)) }));
  return 0;
}

async function cmdImport(args) {
  const dir = args._[1];
  if (!dir || !args.registry) throw new Error('import 需要 <目录> 与 --registry <登记.jsonl>');
  const urls = new Map();
  for (const line of readFileSync(args.registry, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.local_path && row.url) urls.set(path.basename(row.local_path), row);
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.md'));
  const result = { written: 0, skipped: 0, failed: [] };
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const name = files[next++];
      try {
        const row = urls.get(name);
        if (!row) throw new Error('登记表中没有链接');
        const slug = slugOf(row.url);
        if (existsSync(pageFile(slug)) && !args.force) {
          result.skipped++;
          continue;
        }
        const { title, body } = splitTitle(readFileSync(path.join(dir, name), 'utf8'));
        if (!title) throw new Error('首行不是“# 标题”');
        const meta = await englishMeta(slug);
        result[writePage(slug, { title, ...meta, translation: 'official' }, body, args.force,
          { sourceFile: row.source_snapshot })]++;
      } catch (error) {
        result.failed.push(`${name}：${error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log(JSON.stringify(result, null, 2));
  return result.failed.length ? 1 : 0;
}

function cmdRecord(args) {
  const slug = slugOf(args._[1] ?? '');
  const document = readFileSync(pageFile(slug), 'utf8');
  const { data, content } = matter(document);
  const errors = validateNews(data, content, slug);
  if (errors.length) throw new Error(errors.join('\n'));
  publishNews({ root: ROOT, slug, document, body: content, requestDeploy: true, ...publicationOptions(args) });
  console.log(JSON.stringify({ slug, status: 'recorded' }));
  return 0;
}

async function cmdLore(args) {
  const url = args._[1] ?? '';
  if (!args.out === !args.file) throw new Error('lore 需要 --out <草稿.md>（抓取英文稿）或 --file <中文.md>（写成页面），二选一');
  let lore;
  try {
    lore = await fetchLore(url);
  } catch (error) {
    if (!args.out || !(error instanceof UndatedLoreError)) throw error;
    console.log(JSON.stringify({ slug: parseLoreUrl(url).slug, status: 'undated' }));
    return 3;
  }
  const { meta, slug, body } = lore;
  if (args.out) {
    writeFileSync(args.out, `# ${meta.titleEn}\n\n${body}\n`, 'utf8');
    console.log(JSON.stringify({ slug, status: 'draft', file: args.out, meta }));
    return 0;
  }
  const { title, body: zh } = splitTitle(readFileSync(args.file, 'utf8'));
  if (!title) throw new Error(`${args.file}：首行必须是“# 中文标题”`);
  const file = path.join(LORE_DIR, `${slug}.md`);
  if (existsSync(file) && !args.force) {
    console.log(JSON.stringify({ slug, status: 'skipped', file: path.relative(ROOT, file) }));
    return 0;
  }
  const data = { title, ...meta, translation: 'site' };
  const errors = validateLore(data, zh, slug);
  if (errors.length) throw new Error(errors.join('\n'));
  mkdirSync(LORE_DIR, { recursive: true });
  writeFileSync(file, loreDocument(data, zh), 'utf8');
  console.log(JSON.stringify({ slug, status: 'written', file: path.relative(ROOT, file) }));
  return 0;
}

const markdownPages = dir => (existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md') && !INSTRUCTION_FILES.has(f)) : []);

function cmdCheck(args) {
  if (args.slug) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(args.slug)) throw new Error('新闻短名无效');
    const { data, content } = matter(readFileSync(pageFile(args.slug), 'utf8'));
    const errors = validateNews(data, content, args.slug);
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(`${args.slug} 校验通过`);
    return 0;
  }
  const errors = [];
  const newsPages = [];
  const pages = (dir, validate, seen) => {
    const names = markdownPages(dir);
    for (const name of names) {
      const slug = name.replace(/\.md$/, '');
      const { data, content } = matter(readFileSync(path.join(dir, name), 'utf8'));
      errors.push(...validate(data, content, slug));
      seen?.push({ slug, published: data.published, cat: newsCategory(data)?.key });
    }
    return names.length;
  };
  const news = pages(NEWS_DIR, validateNews, newsPages);
  const lore = pages(LORE_DIR, validateLore);
  let calendar = null;
  if (existsSync(CALENDAR_FILE)) {
    try {
      calendar = loadCalendar(CALENDAR_FILE);
      errors.push(...validateCalendar(calendar, new Set(newsPages.map(p => p.slug))));
    } catch (error) {
      errors.push(`calendar.json：读取失败：${error.message}`);
    }
  }
  if (errors.length) {
    console.error(errors.join('\n'));
    return 1;
  }
  const entries = calendar ? `、折扣 ${calendar.entries.length} 项` : '';
  console.log(`天书 ${news} 篇、正史 ${lore} 篇${entries}校验通过`);
  if (calendar) {
    const missing = missingCalendar(calendar, newsPages);
    if (missing.length) console.warn(`折扣未登记的促销公告 ${missing.length} 篇：\n${missing.join('\n')}`);
  }
  return 0;
}

const DEALS_TASK = '判断本篇天书是否带来折扣清单的新条目，收与不收、字段写法都按 rules（折扣板块规则）。'
  + '交付 JSON 对象 {"entries": [...], "link": [...]}。entries 为本篇新增条目，字段按规则填写，deal 取 dealTypes 的键，'
  + 'channel 取 channels 的键，不写 news（宿主填本篇短名），key 的日期与 start 相同；一次折扣中商品或支付方式不同的分条记。'
  + 'nearby 里已有的同一次折扣不新建，改在 link 写 {"key": 已有条目键, "primary": 布尔, "set": {...}}：'
  + 'primary 为真表示本篇是该折扣的正式公告（原条目挂的是预告等），set 只补原条目缺失或本篇更正的 nameEn、off、end、channel、discount、bonus。'
  + '时间换算成 UTC；name、discount、bonus 写中文并沿用 article.zh 的译名，channel 与现金／PLEX 购买以 article.en 的计价货币和商城链接为准。'
  + '本篇没有可收的折扣或赠送时交付 {"entries": [], "link": []}';

const newsSlugs = () => new Set(markdownPages(NEWS_DIR).map(name => name.replace(/\.md$/, '')));

async function englishBody(slug, source) {
  if (source) return readFileSync(source, 'utf8').trim();
  const en = await fetchArticle(slug, 'en');
  if (!en) throw new Error(`${slug}：英文原文不存在或页面中没有文章对象`);
  return en.richText?.json ? richTextMarkdown(en.richText).trim() : '';
}

async function cmdDeals(args) {
  const slug = slugOf(args._[1] ?? '');
  const calendar = loadCalendar(CALENDAR_FILE);
  const { data, content } = matter(readFileSync(pageFile(slug), 'utf8'));
  const category = newsCategory(data)?.key;
  if (args.file) {
    const answer = JSON.parse(readFileSync(args.file, 'utf8'));
    const merged = mergeDeals(calendar, slug, answer, newsSlugs(), { offer: category === 'offer' });
    if (merged.changed) {
      const tmp = `${CALENDAR_FILE}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(merged.calendar, null, 2)}\n`, 'utf8');
      renameSync(tmp, CALENDAR_FILE);
    }
    const { added, linked, skipped } = merged;
    console.log(JSON.stringify({ slug, status: merged.changed ? 'written' : 'unchanged', added, linked, skipped }));
    return 0;
  }
  const published = data.published instanceof Date ? data.published.toISOString().slice(0, 10) : String(data.published ?? '');
  const packet = {
    slug, title: data.title, titleEn: data.titleEn, published, category,
    ...dealReview({ slug, cat: category, published, text: `${data.title}\n${data.titleEn}\n${content}` }, calendar),
  };
  if (packet.review) {
    Object.assign(packet, {
      task: DEALS_TASK,
      rules: dealRules(readFileSync(path.join(NEWS_DIR, 'AGENTS.md'), 'utf8')),
      dealTypes: Object.fromEntries(Object.entries(CALENDAR_DEALS).map(([k, d]) => [k, d.name])),
      channels: CALENDAR_CHANNELS,
      nearby: nearbyDeals(calendar, published),
      article: { zh: content.trim(), en: await englishBody(slug, args.source) },
    });
  }
  console.log(JSON.stringify(packet, null, 2));
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const commands = {
    official: cmdOfficial, add: cmdAdd, import: cmdImport, lore: cmdLore, check: cmdCheck, record: cmdRecord, deals: cmdDeals,
  };
  const run = commands[args._[0]];
  if (!run) {
    console.log(HELP);
    return args._[0] ? 2 : 0;
  }
  return run(args);
}

main().then(code => { process.exitCode = code; }, error => {
  console.error(error.message);
  process.exitCode = 2;
});
