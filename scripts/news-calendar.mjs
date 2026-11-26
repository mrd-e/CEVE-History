// 折扣板块：官方商城折扣与赠送的起止清单（src/news/calendar.json），游戏内活动不收。
// 负责校验、价值分档、12 个月跨年对照、按年明细和天书短名反查；构建时一次算好，页面脚本只管“今天”、筛选和详情卡片。
import { readFileSync } from 'node:fs';

/** 折扣清单起点：此前开始的条目不收。 */
export const CALENDAR_START = '2021-01-01';
export const CALENDAR_CHANNELS = { web: '官网商城', game: '游戏商城', both: '官网与游戏商城' };

/** 商品：决定胶囊颜色（CSS 变量 `--cal-<键>`）和商品筛选。 */
export const CALENDAR_ITEMS = {
  plex: 'PLEX',
  mct: '多人物训练',
  omega: '欧米伽',
  consumable: '消耗品',
  pack: '礼包',
  booster: '加速器',
};
/** 价值档：高价值、小众、低价值；赠送另标。 */
export const CALENDAR_TIERS = { high: '高价值', niche: '小众', low: '低价值' };
const TIER_ORDER = { high: 0, niche: 1, low: 2, gift: 3 };

/**
 * 优惠类型：每条只写一种，商品与价值档由此推出。
 * PLEX 折扣力度达到 highOff（off ≥ 20，即八折及以下）算高价值，否则低价值；
 * 消耗品里技能提取器与超核归高价值，每日阿尔法注入器归低价值；
 * pay 为 plex 的只在游戏商城卖，为 cash 的不在游戏商城卖；gift 为免费或象征性领取的赠送。short 为月份卡标签里的商品简称。
 */
export const CALENDAR_DEALS = {
  plex: { item: 'plex', name: 'PLEX 折扣', short: 'PLEX', tier: 'low', highOff: 20 },
  'mct-plex': { item: 'mct', name: '多人物训练（PLEX 购买）', short: 'MCT', tier: 'high', pay: 'plex' },
  'mct-cash': { item: 'mct', name: '多人物训练（现金购买）', short: 'MCT', tier: 'low', pay: 'cash' },
  'omega-plex': { item: 'omega', name: '欧米伽（PLEX 购买）', short: '欧米伽', tier: 'high', pay: 'plex' },
  'omega-cash': { item: 'omega', name: '欧米伽（现金购买）', short: '欧米伽', tier: 'low', pay: 'cash' },
  extractor: { item: 'consumable', name: '技能提取器', short: '提取器', tier: 'high' },
  hypercore: { item: 'consumable', name: '超核', short: '超核', tier: 'high' },
  'alpha-injector': { item: 'consumable', name: '每日阿尔法注入器', short: '阿尔法注入器', tier: 'low' },
  pack: { item: 'pack', name: '礼包', short: '礼包', tier: 'niche' },
  booster: { item: 'booster', name: '加速器', short: '加速器', tier: 'niche' },
  'gift-omega': { item: 'omega', name: '送欧米伽', short: '送欧米伽', gift: true },
  'gift-plex': { item: 'plex', name: '送 PLEX', short: '送 PLEX', gift: true },
};

/** 条目的价值档；赠送返回 'gift'。 */
export function dealTier(entry) {
  const d = CALENDAR_DEALS[entry.deal];
  if (d.gift) return 'gift';
  return d.highOff && entry.off >= d.highOff ? 'high' : d.tier;
}

const ENTRY_FIELDS = new Set(['key', 'name', 'nameEn', 'deal', 'off', 'start', 'end', 'channel', 'discount', 'bonus', 'news']);
const TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;
const ENTRY_KEY = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GIFT_PURCHASE_HINT = /原价|附赠|购买|满赠/;
const CASH_PRICE_HINT = /美元|美金|\bUSD\b|\$\d/i;

/** UTC 时间 `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:MM` → { date, time }；不合法返回 null。 */
export function parseCalendarTime(value) {
  const m = typeof value === 'string' && value.match(TIME);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const t = new Date(Date.UTC(+y, +mo - 1, +d, +(h ?? 0), +(mi ?? 0)));
  if (t.getUTCMonth() !== +mo - 1 || t.getUTCDate() !== +d || (h !== undefined && (+h > 23 || +mi > 59))) return null;
  return { date: `${y}-${mo}-${d}`, time: h === undefined ? '' : `${h}:${mi}` };
}

const newsList = entry => (entry.news === undefined ? [] : [entry.news].flat());

/**
 * 校验折扣清单，返回错误数组（每条以“calendar.json：<条目键>：”开头）。
 * newsSlugs 为天书公告短名集合，用来核对 news 字段指向的文章存在。
 */
export function validateCalendar(cal, newsSlugs = new Set()) {
  const errors = [];
  const err = (key, msg) => errors.push(`calendar.json：${key ? `${key}：` : ''}${msg}`);
  if (!cal || typeof cal !== 'object' || !Array.isArray(cal.entries)) {
    err('', '须为 { entries: [...] }');
    return errors;
  }
  for (const f of Object.keys(cal)) if (f !== 'entries' && f !== 'skip') err('', `不认识的顶层字段 ${f}`);
  if (cal.skip !== undefined) {
    const linked = new Set(cal.entries.flatMap(e => (e && typeof e === 'object' ? newsList(e) : [])));
    if (!Array.isArray(cal.skip)) err('skip', '须为短名数组');
    else if (cal.skip.some(s => typeof s !== 'string' || !s)) err('skip', '每项须为天书短名');
    else {
      if (new Set(cal.skip).size !== cal.skip.length) err('skip', '短名重复');
      if (cal.skip.some((s, i) => i && s < cal.skip[i - 1])) err('skip', '须按短名排序');
      for (const s of cal.skip) {
        if (!newsSlugs.has(s)) err('skip', `天书文章 ${s} 不存在`);
        if (linked.has(s)) err('skip', `${s} 已有条目指向，不能同时判定不收`);
      }
    }
  }
  const seen = new Set();
  for (const e of cal.entries) {
    const key = e?.key ?? '(无键)';
    const bad = msg => err(key, msg);
    if (!e || typeof e !== 'object') { bad('条目须为对象'); continue; }
    const m = typeof e.key === 'string' && e.key.match(ENTRY_KEY);
    if (!m) bad('键须为“开始日期-英文短词”，如 2026-11-19-black-friday');
    else if (seen.has(e.key)) bad('键重复');
    seen.add(e.key);
    for (const f of Object.keys(e)) if (!ENTRY_FIELDS.has(f)) bad(`不认识的字段 ${f}`);
    if (!e.name || typeof e.name !== 'string') bad('缺中文名 name');
    if (e.nameEn !== undefined && (typeof e.nameEn !== 'string' || !e.nameEn)) bad('nameEn 须为非空文字');
    const deal = Object.hasOwn(CALENDAR_DEALS, e.deal ?? '') ? CALENDAR_DEALS[e.deal] : null;
    if (!deal) bad(`deal 须为 ${Object.keys(CALENDAR_DEALS).join('、')} 之一`);
    if (e.off !== undefined && !(Number.isInteger(e.off) && e.off > 0 && e.off < 100)) bad('off 须为 1–99 的整数（最高减免百分比，七五折写 25）');
    if (deal?.highOff && e.off === undefined) bad('PLEX 折扣须写 off，用来分档');
    if (deal?.gift && e.off !== undefined) bad('赠送不写 off');
    if (deal?.gift && e.discount !== undefined) bad('赠送不写 discount');
    if (deal?.gift && GIFT_PURCHASE_HINT.test(`${e.name ?? ''} ${e.bonus ?? ''}`)) {
      bad('买赠促销不属赠送，须按实付主商品归类并把赠品写进 bonus');
    }
    if (deal?.pay === 'plex' && e.channel !== undefined && e.channel !== 'game') bad('PLEX 购买只在游戏商城，channel 须为 game');
    if (deal?.pay === 'cash' && e.channel === 'game') bad('现金购买不在游戏商城，channel 不能是 game');
    if (e.channel === 'game' && CASH_PRICE_HINT.test(`${e.name ?? ''} ${e.discount ?? ''} ${e.bonus ?? ''}`)) {
      bad('游戏商城仅用 PLEX 结算，出现美元定价时 channel 应为 web（官译常把官网商城写作新伊甸商城）');
    }
    const start = parseCalendarTime(e.start);
    if (!start) bad('start 缺失或格式不对（YYYY-MM-DD 或 YYYY-MM-DDTHH:MM，UTC）');
    else {
      if (start.date < CALENDAR_START) bad(`开始早于折扣清单起点 ${CALENDAR_START}`);
      if (m && m[1] !== start.date) bad(`键的日期 ${m[1]} 与 start 不符`);
    }
    if (e.end !== undefined) {
      const end = parseCalendarTime(e.end);
      if (!end) bad('end 格式不对（YYYY-MM-DD 或 YYYY-MM-DDTHH:MM，UTC）');
      else if (start && e.end < e.start) bad('结束早于开始');
    }
    if (e.channel !== undefined && !(e.channel in CALENDAR_CHANNELS)) bad('channel 须为 web、game 或 both');
    for (const f of ['discount', 'bonus']) if (e[f] !== undefined && (typeof e[f] !== 'string' || !e[f])) bad(`${f} 须为非空文字`);
    if (e.news !== undefined) {
      const list = newsList(e);
      if (!list.length || list.some(s => typeof s !== 'string' || !s)) bad('news 须为短名或短名数组');
      else for (const s of list) if (!newsSlugs.has(s)) bad(`天书文章 ${s} 不存在`);
    }
  }
  return errors;
}

export function loadCalendar(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** 起止的展示文字：“2026-11-19 至 11-26”，带时刻的加“HH:MM”，结束未知写“起，结束待考”。 */
export function calendarRange(entry) {
  const s = parseCalendarTime(entry.start);
  const e = entry.end ? parseCalendarTime(entry.end) : null;
  const left = s.date + (s.time ? ` ${s.time}` : '');
  if (!e) return `${left} 起，结束待考`;
  const sameYear = e.date.slice(0, 4) === s.date.slice(0, 4);
  const right = (sameYear ? e.date.slice(5) : e.date) + (e.time ? ` ${e.time}` : '');
  return e.date === s.date && !e.time && !s.time ? left : `${left} 至 ${right}`;
}

const zhe = off => {
  const rest = 100 - off;
  return `${rest % 10 ? rest : rest / 10}折`;
};

/** 卡片标签：商品简称加折扣，如“PLEX 75折”“欧米伽 8折”；没写力度的只写简称。 */
export function dealLabel(entry) {
  const { short } = CALENDAR_DEALS[entry.deal];
  return entry.off ? `${short} ${zhe(entry.off)}` : short;
}

/** 给模板与脚本用的条目视图。 */
function entryView(e) {
  const news = newsList(e);
  const deal = CALENDAR_DEALS[e.deal];
  const tier = dealTier(e);
  return {
    key: e.key,
    name: e.name,
    nameEn: e.nameEn ?? '',
    deal: e.deal,
    dealName: deal.name,
    label: dealLabel(e),
    item: deal.item,
    itemName: CALENDAR_ITEMS[deal.item],
    tier,
    tierName: tier === 'gift' ? '赠送' : CALENDAR_TIERS[tier],
    gift: tier === 'gift',
    off: e.off ?? 0,
    start: e.start,
    end: e.end ?? '',
    startDate: parseCalendarTime(e.start).date,
    endDate: e.end ? parseCalendarTime(e.end).date : '',
    range: calendarRange(e),
    channel: e.channel ? CALENDAR_CHANNELS[e.channel] : '',
    discount: e.discount ?? '',
    bonus: e.bonus ?? '',
    news: news[0] ?? '',
    month: +e.start.slice(5, 7),
  };
}

/** 条目在某月里的日子：“6–26日”“18日→”“→4日”“整月”；结束待考写“18日起”，赠送只写开始日。 */
function monthDays(e, year, month, cont) {
  const end = e.gift ? e.startDate : e.endDate;
  const from = cont ? 0 : +e.startDate.slice(8, 10);
  if (!end) return `${from}日起`;
  const to = end.slice(0, 7) === `${year}-${String(month).padStart(2, '0')}` ? +end.slice(8, 10) : 0;
  if (from && to) return from === to ? `${from}日` : `${from}–${to}日`;
  if (from) return `${from}日→`;
  if (to) return `→${to}日`;
  return '整月';
}

/**
 * 同一月格内出现 2 项及以上礼包（pack）时合并为一枚聚合标签，避免小众礼包占满多行。
 * 保留各自明细键，点击浮层可展开全部礼包；只有 1 项礼包时不合并。
 */
function collapsePacks(chips) {
  const packs = chips.filter(c => c.entry.deal === 'pack');
  if (packs.length < 2) return chips;
  const maxOff = Math.max(0, ...packs.map(c => c.entry.off || 0));
  const cont = packs.every(c => c.cont);
  const first = packs[0].entry;
  const groupChip = {
    group: true,
    cont,
    days: maxOff ? `低至${zhe(maxOff)}` : '',
    keys: packs.map(c => c.entry.key).join(','),
    count: packs.length,
    title: `共 ${packs.length} 项礼包：\n${packs.map(c => `· ${c.entry.name}｜${c.entry.range}（UTC）${c.entry.discount ? `｜${c.entry.discount}` : ''}`).join('\n')}`,
    entry: {
      key: first.key,
      name: `共 ${packs.length} 项礼包`,
      label: `礼包 ×${packs.length}`,
      item: 'pack',
      tier: 'niche',
      gift: false,
    },
    entries: packs,
  };
  const out = [];
  let inserted = false;
  for (const c of chips) {
    if (c.entry.deal === 'pack') {
      if (!inserted) {
        out.push(groupChip);
        inserted = true;
      }
    } else {
      out.push(c);
    }
  }
  return out;
}

/**
 * 12 张月份对比卡：每张卡列一个自然月，内含各年（新到旧）该月的全部条目。
 * 条目落进进行中的每个月（跨年截断），结束待考与赠送只落开始月；同一年内高价值在前，新开在前。
 * 同月同年出现多项礼包时合并为一枚标签；highCount 按“当月新开的高价值折扣”计，用来直观标出哪些月份常出好价。
 */
export function monthCards(entries, years) {
  const startYear = CALENDAR_START.slice(0, 4);
  const startMonth = +CALENDAR_START.slice(5, 7);
  const byMonth = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    highCount: 0,
    totalCount: 0,
    years: years.map(year => ({ year, pre: year === startYear && i + 1 < startMonth, chips: [] })),
  }));
  const yearIndex = new Map(years.map((y, i) => [y, i]));

  for (const e of entries) {
    const sm = +e.startDate.slice(5, 7);
    byMonth[sm - 1].totalCount++;
    if (e.tier === 'high') byMonth[sm - 1].highCount++;

    const end = e.gift ? e.startDate : e.endDate || e.startDate;
    const sy = +e.startDate.slice(0, 4);
    const ey = +end.slice(0, 4);
    for (let y = sy; y <= ey; y++) {
      const idx = yearIndex.get(String(y));
      if (idx === undefined) continue;
      const before = sy < y;
      const first = before ? 1 : sm;
      const last = ey > y ? 12 : +end.slice(5, 7);
      for (let m = first; m <= last; m++) {
        const cont = before || m > first;
        byMonth[m - 1].years[idx].chips.push({ entry: e, cont, days: monthDays(e, String(y), m, cont) });
      }
    }
  }

  const maxHigh = Math.max(1, ...byMonth.map(m => m.highCount));
  for (const m of byMonth) {
    m.heatLevel = m.highCount ? Math.ceil((m.highCount / maxHigh) * 4) : 0;
    for (const y of m.years) {
      y.chips.sort((a, b) =>
        TIER_ORDER[a.entry.tier] - TIER_ORDER[b.entry.tier] ||
        Number(a.cont) - Number(b.cont) ||
        a.entry.start.localeCompare(b.entry.start) ||
        a.entry.key.localeCompare(b.entry.key));
      y.chips = collapsePacks(y.chips);
    }
  }
  return byMonth;
}

/**
 * 折扣页数据：12 张月份对比卡 + 按年、月分节的明细（新的在前）+ 天书短名反查。
 * tiers 与 items 只列有条目的档位与商品。
 */
export function calendarPage(cal, today = new Date().toISOString().slice(0, 10)) {
  const entries = cal.entries.map(entryView)
    .sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
  const byNews = {};
  for (const e of cal.entries) for (const s of newsList(e)) (byNews[s] ??= []).push(entries.find(v => v.key === e.key));

  const items = Object.entries(CALENDAR_ITEMS)
    .map(([key, name]) => ({ key, name, total: entries.filter(e => e.item === key).length }))
    .filter(i => i.total);
  const tiers = [...Object.entries(CALENDAR_TIERS), ['gift', '赠送']]
    .map(([key, name]) => ({ key, name, total: entries.filter(e => e.tier === key).length }))
    .filter(t => t.total);

  // 明细：按开始年份、月份分节，都是新的在前；节内按开始先后
  const details = [];
  for (const e of [...entries].reverse()) {
    const year = e.startDate.slice(0, 4);
    if (details.at(-1)?.year !== year) details.push({ year, months: [] });
    const months = details.at(-1).months;
    if (months.at(-1)?.month !== e.month) months.push({ key: e.startDate.slice(0, 7), month: e.month, entries: [] });
    months.at(-1).entries.unshift(e);
  }
  for (const y of details) y.count = y.months.reduce((n, m) => n + m.entries.length, 0);

  // 对照年份：从最早条目所在年到今年或最晚条目结束之年，中间无条目的年份也列出，便于上下对照
  const years = [];
  if (entries.length) {
    const lastYear = entries.reduce((acc, e) => {
      const y = (e.endDate || e.startDate).slice(0, 4);
      return y > acc ? y : acc;
    }, today.slice(0, 4));
    for (let y = +lastYear; y >= +entries[0].startDate.slice(0, 4); y--) years.push(String(y));
  }

  const months = monthCards(entries, years);
  return { items, tiers, years, entries, months, details, byNews, start: CALENDAR_START };
}

/**
 * 漏登提示：分类为促销、发布于起点之后的公告，没有任何条目指向它，也不在已判定不收的 skip 里；游戏内活动不进折扣清单。
 * pages 为 [{ slug, published, cat }]，cat 为分类键。
 */
export function missingCalendar(cal, pages) {
  const covered = new Set([...cal.entries.flatMap(newsList), ...(cal.skip ?? [])]);
  return pages
    .filter(p => p.cat === 'offer' && isoDay(p.published) >= CALENDAR_START && !covered.has(p.slug))
    .map(p => p.slug)
    .sort();
}

const isoDay = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? ''));

// 非促销分类的公告（资料片上线、周年庆等）也常带商城折扣，凭这些字眼决定要不要请模型判断。
const STORE_HINT = /商城|商店|PLEX|欧米伽|多人物训练|技能提取器|超核|礼包|折扣|优惠|特惠|促销|[一二三四五六七八九]五?折/i;

/**
 * 收录天书后要不要判断折扣增补：已有条目指向本篇、已判定不收、补丁说明或起点之前的公告不判；促销分类必判；
 * 其余分类出现商城或折扣字眼才判。text 为中文标题、英文标题与正文。返回 { review, reason, covered }。
 */
export function dealReview({ slug, cat, published, text }, cal) {
  const covered = cal.entries.filter(e => newsList(e).includes(slug)).map(e => e.key);
  const result = (review, reason) => ({ review, reason, covered });
  if (covered.length) return result(false, `已有 ${covered.length} 项折扣指向本篇`);
  if (cal.skip?.includes(slug)) return result(false, '已判定不收');
  if (/^patch-notes-version-/.test(slug)) return result(false, '补丁说明不收折扣');
  if (published !== undefined && isoDay(published) < CALENDAR_START) return result(false, `发布早于折扣清单起点 ${CALENDAR_START}`);
  if (cat === 'offer') return result(true, '促销公告');
  return STORE_HINT.test(text) ? result(true, '正文提到商城或折扣') : result(false, '正文未提到商城或折扣');
}

/** 与 day 前后 days 天内有交集的条目（结束未知按开始当天算），供判断是否同一次折扣。 */
export function nearbyDeals(cal, day, days = 60) {
  const t = Date.parse(`${isoDay(day)}T00:00Z`);
  const from = new Date(t - days * 864e5).toISOString().slice(0, 10);
  const to = new Date(t + days * 864e5).toISOString().slice(0, 10);
  return cal.entries.filter(e => e.start.slice(0, 10) <= to && (e.end ?? e.start).slice(0, 10) >= from);
}

/** 从天书指令中取出“折扣板块”整段（含缩进子项），判断折扣时原样交给模型，规则只维护一处。 */
export function dealRules(markdown) {
  const m = String(markdown).match(/^- \*\*折扣板块\*\*[\s\S]*?(?=^- |(?![\s\S]))/m);
  if (!m) throw new Error('天书指令中没有“折扣板块”一节');
  return m[0].trim();
}

const LINK_FIELDS = new Set(['key', 'primary', 'set']);
const LINK_SET = new Set(['nameEn', 'off', 'end', 'channel', 'discount', 'bonus']);

/**
 * 把折扣判断 { entries: [新条目], link: [条目键 | { key, primary, set }] } 并入清单。
 * 新条目不写 news，由工具填本篇短名并按开始时间与键插入；link 把本篇挂到已有条目，primary 为真时本篇成为正式公告，
 * set 只补改 nameEn、off、end、channel、discount、bonus。offer 为真（促销公告）且判断为空时，本篇记入 skip，以后不再判断；
 * 有条目指向本篇时移出 skip。整份清单校验不过时抛错，不改动传入的清单。
 * 返回 { calendar, added, linked, skipped, changed }。
 */
export function mergeDeals(cal, slug, answer, newsSlugs, { offer = false } = {}) {
  const fail = msg => { throw new Error(`折扣判断：${msg}`); };
  const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(answer)) fail('须为 { entries, link }');
  for (const f of Object.keys(answer)) if (f !== 'entries' && f !== 'link') fail(`不认识的字段 ${f}`);
  const adds = answer.entries ?? [];
  const links = answer.link ?? [];
  if (!Array.isArray(adds) || !Array.isArray(links)) fail('entries 与 link 须为数组');

  const entries = cal.entries.map(e => ({ ...e }));
  const byKey = new Map(entries.map(e => [e.key, e]));
  const linked = [];
  for (const raw of links) {
    const link = typeof raw === 'string' ? { key: raw } : raw;
    if (!isObject(link)) fail('link 每项须为条目键或 { key, primary, set }');
    for (const f of Object.keys(link)) if (!LINK_FIELDS.has(f)) fail(`link 不认识的字段 ${f}`);
    const e = byKey.get(link.key);
    if (!e) fail(`link 指向不存在的条目 ${link.key}`);
    if (link.primary !== undefined && typeof link.primary !== 'boolean') fail(`${link.key}：primary 须为布尔值`);
    if (link.set !== undefined) {
      if (!isObject(link.set)) fail(`${link.key}：set 须为对象`);
      for (const [f, v] of Object.entries(link.set)) {
        if (!LINK_SET.has(f)) fail(`${link.key}：set 只能改 ${[...LINK_SET].join('、')}，不能改 ${f}`);
        if (v === null || v === undefined) fail(`${link.key}：set.${f} 不能为空`);
        e[f] = v;
      }
    }
    const list = newsList(e);
    const next = link.primary ? [slug, ...list.filter(s => s !== slug)] : list.includes(slug) ? list : [...list, slug];
    e.news = next.length === 1 ? next[0] : next;
    linked.push(e.key);
  }

  const added = [];
  for (const raw of adds) {
    if (!isObject(raw)) fail('entries 每项须为对象');
    const key = raw.key ?? '(无键)';
    for (const f of Object.keys(raw)) if (!ENTRY_FIELDS.has(f)) fail(`${key}：不认识的字段 ${f}`);
    if (raw.news !== undefined) fail(`${key}：新条目不写 news，由工具填本篇短名`);
    if (byKey.has(raw.key)) fail(`${key}：键已存在；同一次折扣用 link 挂到已有条目`);
    const e = Object.fromEntries([...ENTRY_FIELDS].filter(f => f !== 'news' && raw[f] !== undefined).map(f => [f, raw[f]]));
    e.news = slug;
    const at = entries.findIndex(x => x.start > e.start || (x.start === e.start && x.key > e.key));
    entries.splice(at < 0 ? entries.length : at, 0, e);
    byKey.set(e.key, e);
    added.push(e.key);
  }

  const calendar = { ...cal, entries };
  const skipped = offer && !added.length && !linked.length;
  const skip = (cal.skip ?? []).filter(s => s !== slug);
  if (skipped) skip.push(slug);
  if (skip.length) calendar.skip = skip.sort();
  else delete calendar.skip;
  const errors = validateCalendar(calendar, newsSlugs);
  if (errors.length) fail(`清单校验不通过：\n${errors.join('\n')}`);
  return { calendar, added, linked, skipped, changed: JSON.stringify(calendar) !== JSON.stringify(cal) };
}
