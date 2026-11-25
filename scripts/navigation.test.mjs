import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import nunjucks from 'nunjucks';

const root = path.resolve(import.meta.dirname, '..');
const includes = path.join(root, 'src/_includes');
const pages = [
  ['_includes/person.njk', '/'],
  ['_includes/battle.njk', '/battles/'],
  ['_includes/corp.njk', '/corps/'],
  ['_includes/news.njk', '/news/'],
  ['_includes/lore.njk', '/lore/'],
  ['glossary.njk', '/'],
];

// 用各页面实际传入的参数渲染顶部导航，不加载与返回行为无关的正文数据。
function renderNavigation(file, prefix) {
  const source = readFileSync(path.join(root, 'src', file), 'utf8');
  const navigation = /{%-?\s*set backHref\b[\s\S]*?{%\s*include\s+"back\.njk"\s*%}/.exec(source);
  assert.ok(navigation, `${file} 应使用共用返回组件`);
  const environment = new nunjucks.Environment(new nunjucks.FileSystemLoader(includes), { autoescape: true });
  environment.addFilter('url', url => `${prefix}${url}`);
  return environment.renderString(navigation[0]);
}

function clickNavigation(html, referrer, modifiers = {}) {
  const listeners = [];
  let backCalls = 0;
  const document = {
    referrer,
    getElementById: () => ({ addEventListener: (_, listener) => listeners.push(listener) }),
  };
  const context = {
    document,
    URL,
    location: new URL('https://example.test/p/123/'),
    history: { length: 5, back: () => backCalls++ },
  };
  for (const [, script] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    runInNewContext(script, context);
  }
  const event = { ...modifiers, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  for (const listener of listeners) listener(event);
  assert.equal(backCalls, 0, '返回目录不得触发浏览器后退');
  assert.equal(event.defaultPrevented, false, '保留链接与修饰键的原生导航行为');
}

for (const [file, directory] of pages) {
  test(`${file}：从不同来源进入、连续翻页后仍返回对应目录，兼容部署子路径`, () => {
    for (const prefix of ['', '/wiki']) {
      const html = renderNavigation(file, prefix);
      const nav = /<nav class="back"[^>]*>([\s\S]*?)<\/nav>/.exec(html);
      assert.ok(nav, '生成返回导航');
      assert.match(nav[1], new RegExp(`href="${prefix}${directory}"`));
      assert.match(nav[0], /data-pagefind-ignore/);
      for (const from of ['', 'https://external.test/', 'https://example.test/search/', 'https://example.test/p/456/', `https://example.test${prefix}${directory}?f=test`]) {
        for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
          clickNavigation(html, from, modifiers);
        }
      }
    }
  });
}
