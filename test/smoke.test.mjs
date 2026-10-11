import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.mjs';

test('未知命令返回非零并打印用法', async () => {
  const code = await main(['nope']);
  assert.equal(code, 2);
});

test('package.json 不得含任何依赖', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});
