// 折扣页交互：顶部“正在进行与即将开始”（独立于筛选，永不跳动）、本月高亮、档位与商品筛选（?tier= 与 ?i=）、
// “仅看高价值”快捷切换、月份卡详情浮层与年份明细锚点展开。无 JS 时卡片直链明细，历年明细全展开；时间按 UTC 比较。
const list = document.getElementById('cal-list');
const tierButtons = [...document.querySelectorAll('#cal-tiers .chip[data-tier]')];
const highOnlyBtn = document.getElementById('deals-high-only');
const itemButtons = [...document.querySelectorAll('#cal-items .chip[data-item]')];
const status = document.getElementById('filter-status');
const emptyArchive = document.getElementById('deals-empty-archive');
const CHIP = '.deal-chip';
const chips = [...(list?.querySelectorAll(CHIP) ?? [])];
const yearRows = [...(list?.querySelectorAll('.deal-year-chips') ?? [])];
const items = [...(list?.querySelectorAll('.cal-item') ?? [])];
const archiveMonths = [...(list?.querySelectorAll('.cal-month') ?? [])];
const archiveYears = [...(list?.querySelectorAll('details.cal-year') ?? [])];
const DAY = 86400000;
const SOON_DAYS = 14;

// “YYYY-MM-DD”或“YYYY-MM-DDTHH:MM”（UTC）→ 毫秒；只有日期的结束时间算到当天 23:59
const toTime = (value, end = false) => (value ? Date.parse(`${value.length === 10 ? `${value}T${end ? '23:59' : '00:00'}` : value}:00Z`) : NaN);

function showNow(now) {
  const box = document.getElementById('cal-now');
  if (!box) return;
  const live = [];
  const soon = [];
  for (const li of items) {
    const start = toTime(li.dataset.start);
    const end = toTime(li.dataset.end, true);
    if (start <= now && (now <= end || (Number.isNaN(end) && now - start < SOON_DAYS * DAY))) {
      live.push({ li, sort: Number.isNaN(end) ? Infinity : end, note: Number.isNaN(end) ? '结束待考' : left(end - now) });
    } else if (start > now && start - now <= SOON_DAYS * DAY) {
      soon.push({ li, sort: start, note: `${Math.ceil((start - now) / DAY)} 天后` });
    }
  }
  fill(box.querySelector('#cal-now-live ul'), live, '暂无');
  fill(box.querySelector('#cal-now-soon ul'), soon, '暂无');
  box.hidden = false;
}

function left(ms) {
  const days = Math.floor(ms / DAY);
  return days < 1 ? '今天结束' : `剩 ${days} 天`;
}

function fill(ul, rows, empty) {
  if (!ul) return;
  ul.replaceChildren();
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'is-none';
    li.textContent = empty;
    ul.append(li);
    return;
  }
  rows.sort((a, b) => a.sort - b.sort);
  for (const { li: item, note } of rows) {
    const li = document.createElement('li');
    li.className = [...item.classList].find(c => c.startsWith('cal-t-')) ?? '';
    const a = document.createElement('a');
    a.href = `#${item.id}`;
    a.textContent = item.querySelector('.cal-item-name')?.textContent ?? '';
    const small = document.createElement('small');
    small.textContent = note;
    li.append(a, small);
    ul.append(li);
  }
}

// 给本月那张对比卡加朱砂高亮与“本月”徽标，并按当前月起循环重排 12 张月份卡（本月排第一位，顺接未来各月）
function markToday(now) {
  const month = new Date(now).getUTCMonth() + 1;
  const grid = document.getElementById('deals-months');
  if (grid) {
    const cards = [...grid.querySelectorAll('.deal-month-card')];
    cards.sort((a, b) => ((+a.dataset.m - month + 12) % 12) - ((+b.dataset.m - month + 12) % 12));
    grid.append(...cards);
  }
  const card = document.querySelector(`.deal-month-card[data-m="${month}"]`);
  if (!card) return;
  card.classList.add('is-now');
  const badge = card.querySelector('.deal-now-badge');
  if (badge) badge.hidden = false;
}

// 档位与商品默认全选；未全选时分别同步可重复的 ?tier= 与 ?i=
const knownTiers = tierButtons.map(c => c.dataset.tier);
const knownItems = itemButtons.map(c => c.dataset.item);
const params = new URLSearchParams(location.search);
const wantedTiers = params.getAll('tier').filter(t => knownTiers.includes(t));
const wantedItems = params.getAll('i').filter(t => knownItems.includes(t));
const activeTiers = new Set(wantedTiers.length ? wantedTiers : knownTiers);
const activeItems = new Set(wantedItems.length ? wantedItems : knownItems);

function applyFilters() {
  const match = el => activeTiers.has(el.dataset.tier) && activeItems.has(el.dataset.item);

  for (const chip of chips) chip.hidden = !match(chip);
  for (const row of yearRows) {
    const hasVisible = [...row.querySelectorAll(CHIP)].some(c => !c.hidden);
    row.classList.toggle('is-empty', !hasVisible);
  }

  let totalVisible = 0;
  for (const li of items) {
    const ok = match(li);
    li.hidden = !ok;
    if (ok) totalVisible++;
  }
  for (const m of archiveMonths) {
    m.hidden = ![...m.querySelectorAll('.cal-item')].some(li => !li.hidden);
  }
  for (const y of archiveYears) {
    const count = [...y.querySelectorAll('.cal-item')].filter(li => !li.hidden).length;
    y.hidden = count === 0;
    const badge = y.querySelector('.cal-year-count');
    if (badge) badge.textContent = String(count);
  }
  if (emptyArchive) emptyArchive.hidden = totalVisible > 0;

  for (const btn of tierButtons) {
    const on = activeTiers.has(btn.dataset.tier);
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  if (highOnlyBtn) {
    const onlyHigh = activeTiers.size === 1 && activeTiers.has('high');
    highOnlyBtn.classList.toggle('is-active', onlyHigh);
    highOnlyBtn.setAttribute('aria-pressed', String(onlyHigh));
  }
  for (const btn of itemButtons) {
    const on = activeItems.has(btn.dataset.item);
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', String(on));
  }

  const allTiers = activeTiers.size === knownTiers.length;
  const allItems = activeItems.size === knownItems.length;
  const filtered = !allTiers || !allItems;
  if (status) {
    status.hidden = !filtered;
    status.textContent = filtered ? `共 ${totalVisible} 项` : '';
  }

  const url = new URL(location.href);
  url.searchParams.delete('tier');
  url.searchParams.delete('i');
  if (!allTiers) for (const t of knownTiers) if (activeTiers.has(t)) url.searchParams.append('tier', t);
  if (!allItems) for (const t of knownItems) if (activeItems.has(t)) url.searchParams.append('i', t);
  history.replaceState(null, '', url);
}

// 详情卡：点月份卡里的条目弹出该项明细卡片的副本；带修饰键的点击照常跳到明细
let pop = null;
let opener = null;

function closePop(refocus = false) {
  if (!pop) return;
  pop.remove();
  pop = null;
  if (refocus) opener?.focus();
  opener = null;
}

function openPop(trigger) {
  const keys = (trigger.dataset.keys || trigger.dataset.key || '').split(',').filter(Boolean);
  const matched = keys.map(k => document.getElementById(`e-${k}`)).filter(Boolean);
  if (!matched.length) return false;
  closePop();
  const isGroup = matched.length > 1;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'cal-pop-close';
  close.setAttribute('aria-label', '关闭');
  close.textContent = '×';
  close.addEventListener('click', () => closePop(true));
  pop = document.createElement('ul');
  pop.className = isGroup ? 'cal-pop is-group' : 'cal-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', isGroup ? `共 ${matched.length} 项礼包` : (matched[0].querySelector('.cal-item-name')?.textContent ?? '详情'));
  if (isGroup) {
    const head = document.createElement('li');
    head.className = 'cal-pop-head';
    const title = document.createElement('span');
    title.textContent = `共 ${matched.length} 项礼包`;
    head.append(title, close);
    pop.append(head);
  }
  for (const item of matched) {
    const card = item.cloneNode(true);
    card.removeAttribute('id');
    card.classList.remove('is-flash');
    card.hidden = false;
    if (!isGroup) card.append(close);
    pop.append(card);
  }
  document.body.append(pop);
  const r = trigger.getBoundingClientRect();
  const width = pop.offsetWidth;
  const height = pop.offsetHeight;
  const maxX = document.documentElement.clientWidth - width - 8;
  const leftPos = Math.max(8, Math.min(r.left, maxX)) + scrollX;
  const fitsBelow = r.bottom + height + 12 <= window.innerHeight;
  const topPos = (fitsBelow ? r.bottom + 6 : Math.max(8, r.top - height - 6)) + scrollY;
  pop.style.left = `${leftPos}px`;
  pop.style.top = `${topPos}px`;
  opener = trigger;
  (pop.querySelector('a.cal-item-name') ?? close).focus({ preventScroll: true });
  return true;
}

// 锚点指向明细项（#e-...）或年份（#yYYYY）时自动展开对应年份并滚动到位
function revealHash() {
  const raw = location.hash.slice(1);
  if (!raw) return;
  const id = decodeURIComponent(raw);
  if (/^y\d{4}$/.test(id)) {
    const details = document.getElementById(id);
    if (details && details.matches('details.cal-year') && !details.hidden) {
      details.open = true;
      details.scrollIntoView();
    }
    return;
  }
  if (!id.startsWith('e-')) return;
  const target = document.getElementById(id);
  if (!target) return;
  for (const li of items) li.classList.toggle('is-flash', li === target);
  // 若该项被当前筛选藏起，临时放开筛选让读者能看到目标
  if (target.hidden) {
    activeTiers.add(target.dataset.tier);
    activeItems.add(target.dataset.item);
    applyFilters();
  }
  const details = target.closest('details.cal-year');
  if (details && !details.open) {
    details.open = true;
    target.scrollIntoView();
  }
}

if (list) {
  const now = Date.now();
  // 今年及之后的明细保持展开，更早的年份收起
  const thisYear = new Date(now).toISOString().slice(0, 4);
  for (const d of archiveYears) d.open = d.dataset.year >= thisYear;
  showNow(now);
  markToday(now);

  for (const btn of tierButtons) {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tier;
      if (!activeTiers.delete(t)) activeTiers.add(t);
      closePop();
      applyFilters();
    });
  }
  if (highOnlyBtn) {
    highOnlyBtn.addEventListener('click', () => {
      const onlyHigh = activeTiers.size === 1 && activeTiers.has('high');
      activeTiers.clear();
      if (onlyHigh) for (const t of knownTiers) activeTiers.add(t);
      else activeTiers.add('high');
      closePop();
      applyFilters();
    });
  }
  for (const btn of itemButtons) {
    btn.addEventListener('click', () => {
      const t = btn.dataset.item;
      if (!activeItems.delete(t)) activeItems.add(t);
      closePop();
      applyFilters();
    });
  }
  if (tierButtons.length || itemButtons.length) applyFilters();

  for (const chip of chips) {
    chip.addEventListener('click', e => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      if (openPop(chip)) e.preventDefault();
    });
  }
  document.addEventListener('click', e => {
    if (pop && !pop.contains(e.target) && !chips.includes(e.target.closest(CHIP))) closePop();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closePop(true);
  });
  window.addEventListener('resize', () => closePop());
  window.addEventListener('hashchange', revealHash);
  revealHash();
}
