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

test('天书每轮只在收尾提交一次：收录开始后由收录提交，没走到收录时由收尾提交', () => {
  const news = readFileSync(new URL('../.github/workflows/news.yml', import.meta.url), 'utf8');
  const steps = news.split(/\n\s*- (?=name:|uses:|if:|run:)/);
  const publish = steps.find(step => step.includes('sync.py publish'));
  const finish = steps.find(step => step.includes('sync.py finish'));
  assert.match(publish, /id: publish/);
  assert.match(publish, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(finish, /if: always\(\) && steps\.scan\.outcome == 'success' && steps\.publish\.outcome == 'skipped'/);
  assert.match(finish, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(news, /sync\.py deploy/);
});
