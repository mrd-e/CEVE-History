// 游戏内专名校验核心：正文里的舰船、建筑、星系、星域英文名须写中文。
const NAME_PART = /[A-Za-z]*[a-z][A-Za-z]*$/;
const NAME_PART_AFTER = /^[A-Za-z]*[a-z]/;
const JOINER = "[ \\-·_.'’&]";

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 待查词表：术语表的舰船、建筑加星系、星域全表；英文原词 → 中文，同名的（如 Curse）两个中文都给。 */
export function gameNames(entries, systems, regions = {}) {
  const names = { ...regions, ...systems };
  for (const { term, meaning, kind } of entries) {
    if (!['ship', 'structure'].includes(kind) || !/^[A-Za-z]/.test(term)) continue;
    names[term] = names[term] && names[term] !== meaning ? `${meaning}／${names[term]}` : meaning;
  }
  return names;
}

/** 遮住不归本规则管的原文：链接地址、代码、引号、书名号；保持字符位置不变。 */
export function maskQuoted(line) {
  const blank = match => ' '.repeat(match.length);
  return line
    .replace(/\]\([^)]*\)/g, blank)
    .replace(/https?:\/\/\S+/g, blank)
    .replace(/`[^`]*`/g, blank)
    .replace(/“[^”]*”|‘[^’]*’|「[^」]*」|《[^》]*》/g, blank);
}

export function namePattern(names) {
  const alternatives = Object.keys(names).sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  return new RegExp(`(?<![A-Za-z0-9_\\-])(?:${alternatives})(?![A-Za-z0-9_\\-])`, 'g');
}

/** 紧邻含小写字母的英文词时，这个词是多词专名的一部分（如军团名、角色名）；全大写缩写和数字不算。 */
function isPartOfLongerName(text, start, end) {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const joinedBefore = new RegExp(`${JOINER}$`).test(before) && NAME_PART.test(before.slice(0, -1));
  const joinedAfter = new RegExp(`^${JOINER}`).test(after) && NAME_PART_AFTER.test(after.slice(1));
  return joinedBefore || joinedAfter;
}

const ESCAPED_SHIP_VARIANT = '(?:海军型|舰队型|国家版|势力版|帝国型|政府型|联邦型|财团型|部族型|应急反应型|MKV|豪华游轮)';
const SHIP_CLASS_RE = new RegExp(`((?:(?!(?<!共)和|[与及或跟级的])[\\u4e00-\\u9fa5A-Za-z0-9]){1,12})级(${ESCAPED_SHIP_VARIANT})?(?![别点段层阶])`, 'g');
const SHIP_SHORTHAND_RE = /海神示(?:级)?|海凤凰(?:级)?|海莫洛(?:级)?|海乌鸦(?:级)?|海军神示(?:级)?|海军凤凰(?:级)?|海军莫洛(?:级)?|海军乌鸦(?:级)?|阿斯特拉胡斯/g;
const NON_SHIP_PREFIX_RE = /(?:[一二两三四五六七八九十零百千万亿多半余]+(?:人|亿|万|千|百)?|(?:安全)?等|高等|低等|层|了|找上|上下|同|高|低|初|中|大|小|顶|次|终|末|首|本|外|内|头|尾|后|前|双|单|多|各|每|超|特|满星|满|星|升|降|分|晋|评|轻量|重量|轻中量|量|平|越|逐|跨|甲|世界|史诗|全服|宇宙|联盟|军团|战术|战略|保姆|入门|元老|殿堂|灭灯|总监|断层|势力|主力|榜首|骚扰|大型|中型|小型|无畏|泰坦|航母|超航|战列|战巡|巡洋|驱逐|护卫|后勤|掠夺|重突|轻拦|重拦|截击|隐轰|侦察|指挥|工业|货舰|强运|运输|旗舰|常规|超旗|特种|采矿|电子|突击|新手|战舰|T[123]|[ABS]|CEO)$/;

/** 从术语表收集所有已登记的舰船中文名（按字长降序，用于最长后缀匹配）。 */
export function shipMeanings(entries) {
  return [...new Set(entries.filter(entry => entry.kind === 'ship').map(entry => entry.meaning))]
    .sort((a, b) => b.length - a.length);
}

function findMatchingShip(prefix, suffix, full, knownShips) {
  return knownShips.find(meaning => (suffix ? full.endsWith(meaning) : prefix.endsWith(meaning) || full.endsWith(meaning)));
}

/** 列出正文里未按术语表登记的 `<词>级` 船名与战役已知俗称/错译；front matter、引用块与引号/书名号保留原文。 */
export function findInvalidShipNames(text, knownShips, { checkShorthand = false } = {}) {
  const found = [];
  const lines = text.split(/\r?\n/);
  let inFrontMatter = lines[0] === '---';
  lines.forEach((line, index) => {
    if (inFrontMatter) {
      if (index > 0 && line === '---') inFrontMatter = false;
      return;
    }
    if (line.startsWith('>')) return;
    const masked = maskQuoted(line);
    if (checkShorthand) {
      for (const match of masked.matchAll(SHIP_SHORTHAND_RE)) {
        found.push({ line: index + 1, term: match[0], zh: '请写完整官方中文船名/建筑名' });
      }
    }
    for (const match of masked.matchAll(SHIP_CLASS_RE)) {
      const full = match[0];
      const prefix = match[1];
      const suffix = match[2] || '';
      if (findMatchingShip(prefix, suffix, full, knownShips)) continue;
      if (!suffix && NON_SHIP_PREFIX_RE.test(prefix)) continue;
      found.push({ line: index + 1, term: full, zh: '词表外或错译“级”舰船名，须按术语表校对' });
    }
  });
  return found;
}

/** 列出正文里写成英文的专名；front matter 和引用块是原文，不查。 */
export function findEnglishNames(text, names, pattern = namePattern(names)) {
  const found = [];
  const lines = text.split(/\r?\n/);
  let inFrontMatter = lines[0] === '---';
  lines.forEach((line, index) => {
    if (inFrontMatter) {
      if (index > 0 && line === '---') inFrontMatter = false;
      return;
    }
    if (line.startsWith('>')) return;
    const masked = maskQuoted(line);
    for (const match of masked.matchAll(pattern)) {
      if (isPartOfLongerName(masked, match.index, match.index + match[0].length)) continue;
      found.push({ line: index + 1, term: match[0], zh: names[match[0]] });
    }
  });
  return found;
}

/** 例外只按文件登记，放过某文件的某词；文件里已没有这个词时算失效。 */
export function applyExceptions(file, found, exceptions = {}) {
  const local = exceptions.files?.[file] ?? {};
  const kept = found.filter(item => !(item.term in local));
  const stale = Object.keys(local).filter(term => !found.some(item => item.term === term));
  return { kept, stale };
}

/** 每条例外都要写明原因。 */
export function validateExceptions(exceptions) {
  const errors = [];
  for (const [file, terms] of Object.entries(exceptions.files ?? {})) {
    for (const [term, reason] of Object.entries(terms)) {
      if (typeof reason !== 'string' || !reason.trim()) errors.push(`docs/game-name-exceptions.json：${file} 的 ${term} 缺原因`);
    }
  }
  return errors;
}
