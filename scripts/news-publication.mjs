// 页面与订阅状态共同落盘；登记失败时还原本次写入，保留原有人工编辑。
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function publishNews({ root, slug, document, body, sourceFile, fingerprintsFile, requestDeploy = false, write = writeFileSync }) {
  const file = path.join(root, 'src', 'news', `${slug}.md`);
  const stateFile = path.join(root, '.github', 'news-state.json');
  const before = existsSync(file) ? readFileSync(file) : null;
  const changed = before?.toString('utf8') !== document;
  const oldState = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : null;
  let stateText;
  if (oldState !== null) {
    const result = spawnSync(process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
      ['-X', 'utf8', path.join(root, 'scripts', 'ci-news', 'publication.py')], {
        encoding: 'utf8',
        input: JSON.stringify({
          state: JSON.parse(oldState), slug, body, changed: changed || requestDeploy,
          source: sourceFile ? readFileSync(sourceFile, 'utf8') : null,
          fingerprints: fingerprintsFile ? JSON.parse(readFileSync(fingerprintsFile, 'utf8')) : null,
        }),
      });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.trim() || `订阅登记退出码 ${result.status}`);
    stateText = `${JSON.stringify(JSON.parse(result.stdout), null, 2)}\n`;
  }
  const temporary = `${stateFile}.tmp`;
  try {
    if (changed) write(file, document, 'utf8');
    if (stateText !== undefined && stateText !== oldState) {
      write(temporary, stateText, 'utf8');
      renameSync(temporary, stateFile);
    }
  } catch (error) {
    if (before !== null) writeFileSync(file, before);
    else if (existsSync(file)) unlinkSync(file);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return 'written';
}
