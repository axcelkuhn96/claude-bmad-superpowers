import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyNativeExclusion } from '../base/memoria/native.mjs';

const installed = {
  pluginId: 'claude-mem@claude-mem-local', name: 'claude-mem', marketplaceName: 'claude-mem-local',
  version: '13.37.0', installed: true, enabled: true, installPolicy: 'AVAILABLE',
  source: { source: 'local' }, marketplaceSource: { sourceType: 'local' },
};

async function probe(t, output) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-codex-plugin-probe-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  const bin = path.join(dir, 'bin');
  await fs.mkdir(root);
  await fs.mkdir(bin);
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const config = path.join(root, '.codex', 'config.toml');
  await fs.mkdir(path.dirname(config));
  await fs.writeFile(config, '[plugins."claude-mem@claude-mem-local"]\nenabled = true\n');
  await fs.writeFile(path.join(bin, 'codex'),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$CBS_TEST_PLUGIN_ARGS"\nprintf "%s\\n" "$CBS_TEST_PLUGIN_OUTPUT"\n', { mode: 0o700 });
  const priorPath = process.env.PATH;
  const priorOutput = process.env.CBS_TEST_PLUGIN_OUTPUT;
  const priorArgs = process.env.CBS_TEST_PLUGIN_ARGS;
  process.env.PATH = `${bin}${path.delimiter}${priorPath}`;
  process.env.CBS_TEST_PLUGIN_ARGS = path.join(dir, 'args');
  try {
    const results = [];
    for (const row of Array.isArray(output) ? output : [output]) {
      process.env.CBS_TEST_PLUGIN_OUTPUT = row;
      results.push(await applyNativeExclusion(root, { cli: 'codex', stateRoot: path.join(dir, 'state') }));
    }
    const args = (await fs.readFile(process.env.CBS_TEST_PLUGIN_ARGS, 'utf8')).trimEnd().split('\n');
    return { result: results.at(-1), results, args, config: await fs.readFile(config, 'utf8') };
  } finally {
    process.env.PATH = priorPath;
    if (priorOutput === undefined) delete process.env.CBS_TEST_PLUGIN_OUTPUT;
    else process.env.CBS_TEST_PLUGIN_OUTPUT = priorOutput;
    if (priorArgs === undefined) delete process.env.CBS_TEST_PLUGIN_ARGS;
    else process.env.CBS_TEST_PLUGIN_ARGS = priorArgs;
  }
}

test('Codex native exclusion rejects a plugin row saying not installed', async t => {
  const { result } = await probe(t, 'claude-mem@claude-mem-local not installed');
  assert.deepEqual(result, { kind: 'blocked', reason: 'unsupported_plugin' });
});

test('Codex native exclusion requires the scoped installed JSON row', async t => {
  const { result, args, config } = await probe(t, JSON.stringify({ installed: [installed], available: [] }));
  assert.deepEqual(args, ['plugin', 'list', '--marketplace', 'claude-mem-local', '--json']);
  assert.equal(result.kind, 'applied');
  assert.match(config, /enabled = false/);
});

test('Codex native exclusion reuses its owned snapshot after disabling the installed plugin', async t => {
  const enabled = JSON.stringify({ installed: [installed], available: [] });
  const disabled = JSON.stringify({ installed: [{ ...installed, enabled: false }], available: [] });
  const { results } = await probe(t, [enabled, disabled]);
  assert.deepEqual(results, [{ kind: 'applied' }, { kind: 'applied', existing: true }]);
});

test('Codex native exclusion ignores available, disabled, foreign and malformed plugin rows', async t => {
  const blocked = { kind: 'blocked', reason: 'unsupported_plugin' };
  for (const output of [
    JSON.stringify({ installed: [], available: [installed] }),
    JSON.stringify({ installed: [{ ...installed, enabled: false }], available: [] }),
    JSON.stringify({ installed: [{ ...installed, installed: false }], available: [] }),
    JSON.stringify({ installed: [{ ...installed, pluginId: 'other@claude-mem-local' }], available: [] }),
    JSON.stringify({ installed: [{ ...installed, name: 'other' }], available: [] }),
    JSON.stringify({ installed: [{ ...installed, marketplaceName: 'other' }], available: [] }),
    JSON.stringify({ installed: [{ ...installed, version: null }], available: [] }),
    JSON.stringify({ installed: [{ ...installed, installPolicy: 'WORKSPACE_MANAGED' }], available: [] }),
    JSON.stringify({ installed: [{ ...installed, source: { source: 'remote' } }], available: [] }),
    JSON.stringify({ installed: [installed, installed], available: [] }),
    '{invalid',
  ]) {
    const { result, config } = await probe(t, output);
    assert.deepEqual(result, blocked, output);
    assert.match(config, /enabled = true/, output);
  }
});
