import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

test('ADR 0001：翻译框架的所有 checkout 均跟随最新默认分支', () => {
  let count = 0;
  for (const name of readdirSync(new URL('../.github/workflows/', import.meta.url))) {
    if (!/\.ya?ml$/.test(name)) continue;
    const text = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
    for (const step of text.split(/\n\s*-(?= (?:name:|uses:|run:|if:))/)) {
      if (!step.includes('repository: mrd-e/EVE-Online-Translation-Framework')) continue;
      count++;
      assert.doesNotMatch(step, /^\s+ref:/m, `${name} 不得固定翻译框架 ref，见 ADR 0001`);
      assert.match(step, /token: \$\{\{ secrets\.TRANSLATOR_READ_TOKEN \}\}/);
    }
  }
  assert.ok(count >= 2, '自动收录及回归 CI 都应读取翻译框架');
});

test('翻译回归进入 CI；任务成果在取消、失败和成功后都保存', () => {
  const news = readFileSync(new URL('../.github/workflows/news.yml', import.meta.url), 'utf8');
  const deploy = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(news, /python -m unittest discover -s scripts\/ci-news/);
  assert.match(deploy, /python -m unittest discover -s scripts\/ci-news/);
  const upload = news.split(/\n\s*- name:/).find(step => step.includes('actions/upload-artifact@'));
  assert.match(upload, /if: always\(\)/);
  assert.match(news, /sync\.py restore/);
});
