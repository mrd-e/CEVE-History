import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarPage, calendarRange, dealLabel, dealTier, missingCalendar, parseCalendarTime, validateCalendar } from './news-calendar.mjs';

const NEWS = new Set(['plex-sale', 'harvest-is-here', 'harvest-is-coming']);
const entry = (over = {}) => ({
  key: '2026-10-24-plex', name: 'PLEX 七五折', deal: 'plex', off: 25,
  start: '2026-10-24', end: '2026-11-02T23:59', channel: 'web', discount: '最高七五折', news: 'plex-sale', ...over,
});
const cal = (...entries) => ({ entries });

test('时间：日期或日期加时刻，按日历校验', () => {
  assert.deepEqual(parseCalendarTime('2026-11-02T23:59'), { date: '2026-11-02', time: '23:59' });
  assert.deepEqual(parseCalendarTime('2026-11-02'), { date: '2026-11-02', time: '' });
  assert.equal(parseCalendarTime('2026-02-30'), null);
  assert.equal(parseCalendarTime('2026-11-02T24:00'), null);
  assert.equal(parseCalendarTime('2026/11/02'), null);
});

test('分档：PLEX 八折及以下、PLEX 买的多人物训练与欧米伽、技能提取器与超核为高价值，现金欧米伽与每日阿尔法注入器低价值，礼包与加速器小众', () => {
  assert.equal(dealTier({ deal: 'plex', off: 20 }), 'high');
  assert.equal(dealTier({ deal: 'plex', off: 10 }), 'low');
  assert.equal(dealTier({ deal: 'mct-plex' }), 'high');
  assert.equal(dealTier({ deal: 'omega-plex', off: 25 }), 'high');
  assert.equal(dealTier({ deal: 'extractor', off: 50 }), 'high');
  assert.equal(dealTier({ deal: 'hypercore', off: 50 }), 'high');
  assert.equal(dealTier({ deal: 'mct-cash', off: 40 }), 'low');
  assert.equal(dealTier({ deal: 'omega-cash', off: 30 }), 'low');
  assert.equal(dealTier({ deal: 'alpha-injector', off: 50 }), 'low');
  assert.equal(dealTier({ deal: 'pack' }), 'niche');
  assert.equal(dealTier({ deal: 'booster' }), 'niche');
  assert.equal(dealTier({ deal: 'gift-plex' }), 'gift');
});

test('校验：合规条目无错，news 可为数组', () => {
  assert.deepEqual(validateCalendar(cal(entry()), NEWS), []);
  assert.deepEqual(validateCalendar(cal(entry({ deal: 'pack', off: undefined, news: ['harvest-is-here', 'harvest-is-coming'] })), NEWS), []);
});

test('校验：逐项拦下不合规条目', () => {
  const cases = [
    [{ start: undefined }, 'start 缺失'],
    [{ end: '2026-10-20' }, '结束早于开始'],
    [{ deal: 'event' }, 'deal 须为'],
    [{ off: undefined }, 'PLEX 折扣须写 off'],
    [{ off: 0.25 }, 'off 须为 1–99 的整数'],
    [{ deal: 'gift-omega' }, '赠送不写 off'],
    [{ deal: 'mct-plex', channel: 'web' }, 'PLEX 购买只在游戏商城'],
    [{ deal: 'omega-cash', channel: 'game' }, '现金购买不在游戏商城'],
    [{ news: 'no-such-news' }, '天书文章 no-such-news 不存在'],
    [{ source: 'https://example.com' }, '不认识的字段 source'],
    [{ key: '2026-10-25-plex' }, '与 start 不符'],
    [{ key: '2020-12-25-plex', start: '2020-12-25', end: '2020-12-31' }, '早于折扣清单起点'],
    [{ channel: 'shop' }, 'channel'],
    [{ discount: '' }, 'discount 须为非空文字'],
  ];
  for (const [over, msg] of cases) {
    const errors = validateCalendar(cal(entry(over)), NEWS);
    assert.ok(errors.some(e => e.includes(msg)), `${JSON.stringify(over)} 应报“${msg}”，实得 ${errors.join('；')}`);
  }
  const dup = validateCalendar(cal(entry(), entry()), NEWS);
  assert.ok(dup.some(e => e.includes('键重复')));
  assert.ok(validateCalendar({}, NEWS)[0].includes('entries'));
  assert.ok(validateCalendar({ types: [], entries: [] }, NEWS)[0].includes('顶层字段 types'));
});

test('起止文字：同年省年份，带时刻，结束待考', () => {
  assert.equal(calendarRange(entry()), '2026-10-24 至 11-02 23:59');
  assert.equal(calendarRange(entry({ start: '2026-12-28', end: '2027-01-04' })), '2026-12-28 至 2027-01-04');
  assert.equal(calendarRange(entry({ end: undefined })), '2026-10-24 起，结束待考');
  assert.equal(calendarRange(entry({ end: '2026-10-24' })), '2026-10-24');
});

test('折扣页：档位与商品胶囊只列有条目的项，反查表收齐数组短名，月份高价值次数按开始月统计', () => {
  const page = calendarPage(cal(
    entry(),
    entry({ key: '2026-11-06-plex', start: '2026-11-06', end: '2026-11-10' }),
    entry({ key: '2026-11-19-plex-10', off: 10, start: '2026-11-19', end: '2026-11-26' }),
    entry({ key: '2026-11-20-gift', deal: 'gift-omega', off: undefined, start: '2026-11-20', end: '2026-11-27' }),
    entry({ key: '2026-10-06-harvest', deal: 'pack', off: undefined, start: '2026-10-06', end: '2026-11-03', news: ['harvest-is-here', 'harvest-is-coming'] }),
  ), '2026-11-25');
  assert.deepEqual(page.tiers.map(t => [t.key, t.total]), [['high', 2], ['niche', 1], ['low', 1], ['gift', 1]]);
  assert.deepEqual(page.items.map(i => [i.key, i.total]), [['plex', 3], ['omega', 1], ['pack', 1]]);
  assert.equal(page.months[9].highCount, 1);
  assert.equal(page.months[10].highCount, 1);
  assert.equal(page.months[10].heatLevel, 4);
  assert.equal(page.months[0].highCount, 0);
  assert.equal(page.months[0].heatLevel, 0);
  assert.equal(page.byNews['harvest-is-coming'][0].key, '2026-10-06-harvest');
  assert.equal(page.byNews['harvest-is-here'][0].news, 'harvest-is-here');
  assert.equal(page.byNews['plex-sale'].length, 4);
});

test('折扣页：明细按年、月分节，新的在前，节内按开始先后，空月不出', () => {
  const page = calendarPage(cal(
    entry({ key: '2024-03-01-plex', start: '2024-03-01', end: '2024-03-05' }),
    entry({ key: '2026-11-10-plex', start: '2026-11-10', end: '2026-11-15' }),
    entry({ key: '2026-11-02-plex', start: '2026-11-02', end: '2026-11-05' }),
    entry({ key: '2026-08-22-plex', start: '2026-08-22', end: '2026-09-02' }),
  ), '2026-11-25');
  assert.deepEqual(page.details.map(y => [y.year, y.count]), [['2026', 3], ['2024', 1]]);
  assert.deepEqual(page.details[0].months.map(m => m.month), [11, 8]);
  assert.deepEqual(page.details[0].months[0].entries.map(e => e.key), ['2026-11-02-plex', '2026-11-10-plex']);
});

test('月份对比卡：年份从最早条目到今年连续列出，跨年条目让下一年也出卡', () => {
  const page = calendarPage(cal(
    entry({ key: '2024-03-01-plex', start: '2024-03-01', end: '2024-03-05' }),
    entry({ key: '2026-12-28-plex', start: '2026-12-28', end: '2027-01-04' }),
  ), '2026-12-30');
  assert.equal(page.months.length, 12);
  assert.deepEqual(page.years, ['2027', '2026', '2025', '2024']);
  assert.deepEqual(page.months[0].years.map(y => y.year), ['2027', '2026', '2025', '2024']);
  assert.equal(page.months[0].years[0].chips[0].days, '→4日');
  assert.equal(page.months[0].years[0].chips[0].cont, true);
  assert.ok(page.months.every(m => m.years[2].chips.length === 0));
});

test('月份对比卡：跨月延续、同月高价值排在前面、结束待考与赠送只落开始月', () => {
  const page = calendarPage(cal(
    entry({ key: '2026-10-05-pack', deal: 'pack', off: 50, start: '2026-10-05', end: '2026-12-05' }),
    entry({ key: '2026-10-20-plex', deal: 'plex', off: 25, start: '2026-10-20', end: '2026-10-25' }),
    entry({ key: '2026-03-01-pack', deal: 'pack', off: undefined, start: '2026-03-01', end: undefined }),
    entry({ key: '2026-11-10-gift', deal: 'gift-plex', off: undefined, start: '2026-11-10', end: '2026-12-20' }),
  ), '2026-12-01');
  const m10 = page.months[9].years[0].chips;
  const m11 = page.months[10].years[0].chips;
  const m12 = page.months[11].years[0].chips;
  const m03 = page.months[2].years[0].chips;
  // 高价值 PLEX 排在更早开始的小众礼包前面
  assert.deepEqual(m10.map(c => [c.entry.key, c.days, c.cont]), [
    ['2026-10-20-plex', '20–25日', false],
    ['2026-10-05-pack', '5日→', false],
  ]);
  assert.deepEqual(m11.map(c => [c.entry.key, c.days, c.cont]), [
    ['2026-10-05-pack', '整月', true],
    ['2026-11-10-gift', '10日', false],
  ]);
  assert.deepEqual(m12.map(c => [c.entry.key, c.days, c.cont]), [
    ['2026-10-05-pack', '→5日', true],
  ]);
  assert.deepEqual(m03.map(c => [c.entry.key, c.days]), [['2026-03-01-pack', '1日起']]);
});

test('月份对比卡：同月同年多项礼包合并为一枚标签，保留全部键并取最大折扣', () => {
  const page = calendarPage(cal(
    entry({ key: '2026-11-01-pack-a', name: '礼包甲', deal: 'pack', off: 25, start: '2026-11-01', end: '2026-11-05' }),
    entry({ key: '2026-11-10-pack-b', name: '礼包乙', deal: 'pack', off: 50, start: '2026-11-10', end: '2026-12-03' }),
    entry({ key: '2026-11-15-plex', deal: 'plex', off: 25, start: '2026-11-15', end: '2026-11-20' }),
  ), '2026-12-01');
  const m11 = page.months[10].years[0].chips;
  const m12 = page.months[11].years[0].chips;
  assert.equal(m11.length, 2);
  assert.equal(m11[0].entry.key, '2026-11-15-plex');
  assert.equal(m11[1].group, true);
  assert.equal(m11[1].entry.label, '礼包 ×2');
  assert.equal(m11[1].days, '低至5折');
  assert.equal(m11[1].keys, '2026-11-01-pack-a,2026-11-10-pack-b');
  assert.equal(m11[1].cont, false);
  // 12 月只有一项跨月礼包，不合并
  assert.equal(m12.length, 1);
  assert.equal(m12[0].group, undefined);
  assert.equal(m12[0].entry.key, '2026-11-10-pack-b');
});

test('标签：折扣写成几折，没写力度的只写简称', () => {
  assert.equal(dealLabel({ deal: 'plex', off: 20 }), 'PLEX 8折');
  assert.equal(dealLabel({ deal: 'omega-cash', off: 15 }), '欧米伽 85折');
  assert.equal(dealLabel({ deal: 'mct-cash' }), 'MCT');
  assert.equal(dealLabel({ deal: 'gift-omega' }), '送欧米伽');
});

test('月份对比卡：起点年份全年皆在收录内，2 月 29 日照常落进 2 月', () => {
  const page = calendarPage(cal(
    entry({ key: '2021-03-22-omega', deal: 'omega-cash', off: 15, start: '2021-03-22', end: '2021-03-29' }),
    entry({ key: '2024-02-29-plex', start: '2024-02-29', end: '2024-03-01' }),
  ), '2024-03-02');
  const y2021Jan = page.months[0].years.find(y => y.year === '2021');
  assert.equal(y2021Jan.pre, false);
  const y2024Feb = page.months[1].years.find(y => y.year === '2024');
  const y2024Mar = page.months[2].years.find(y => y.year === '2024');
  assert.deepEqual(y2024Feb.chips.map(c => c.days), ['29日→']);
  assert.deepEqual(y2024Mar.chips.map(c => c.days), ['→1日']);
});

test('漏登提示：只看起点后的促销公告，数组里的预告也算已登记，游戏内活动不提示', () => {
  const calendar = cal(entry({ deal: 'pack', off: undefined, news: ['harvest-is-here', 'harvest-is-coming'] }));
  const pages = [
    { slug: 'plex-sale', published: new Date('2026-10-24T00:00:00Z'), cat: 'offer' },
    { slug: 'harvest-is-coming', published: '2026-10-01', cat: 'offer' },
    { slug: 'harvest-is-here', published: '2026-10-06', cat: 'offer' },
    { slug: 'login-event', published: '2026-10-06', cat: 'event' },
    { slug: 'patch', published: '2026-10-06', cat: 'update' },
    { slug: 'old-sale', published: '2020-12-01', cat: 'offer' },
  ];
  assert.deepEqual(missingCalendar(calendar, pages), ['plex-sale']);
});
