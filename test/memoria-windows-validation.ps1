# Run on native Windows PowerShell with Node >=18, Python >=3.11, Git and NTFS.
# This is a portability/guard harness. It intentionally does not activate Mem0.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$fixture = Join-Path $env:TEMP ('cbs-memoria-windows-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
  $env:CBS_MEMORIA_WINDOWS_FIXTURE = $fixture
  $env:CBS_MEMORIA_WINDOWS_REPO = $repo
  $check = @'
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.CBS_MEMORIA_WINDOWS_REPO;
const local = name => import(pathToFileURL(path.join(root, 'base', 'memoria', name)).href);
const { runtimePython } = await local('runtime.mjs');
const { activateProject } = await local('setup.mjs');
const { applyNativeExclusion } = await local('native.mjs');
const { requestBroker } = await local('broker.mjs');
const { withProjectLock } = await local('ledger.mjs');
const fixture = process.env.CBS_MEMORIA_WINDOWS_FIXTURE;
assert.equal(process.platform, 'win32');
assert.equal(runtimePython(fixture), path.join(fixture, 'runtime', 'Scripts', 'python.exe'));
assert.equal((await activateProject(fixture)).reason, 'native_windows_unproved');
assert.equal((await applyNativeExclusion(fixture, { cli: 'codex' })).reason, 'native_windows_unproved');
assert.equal((await requestBroker({}, '')).reason, 'native_windows_unproved');
let active = 0, peak = 0;
await Promise.all([0, 1].map(() => withProjectLock(fixture, async () => {
  active++; peak = Math.max(peak, active);
  await new Promise(resolve => setTimeout(resolve, 80));
  active--;
}, 'extract.lock')));
assert.equal(peak, 1);
process.stdout.write('PASS Scripts/python.exe, Windows lock serialization, and unsupported activation guard\n');
'@
  $check | node --input-type=module -
  if ($LASTEXITCODE -ne 0) { throw 'Node Windows portability check failed' }
  Write-Host 'Current SID:'
  whoami /user
  Write-Host 'Fixture NTFS ACL (manual SID/DACL review required):'
  icacls $fixture
  Write-Host 'UNSUPPORTED: native hook exclusion, SID/DACL ownership, durable outbox and AMD resource proof require separate actual validation.'
}
finally {
  Remove-Item Env:CBS_MEMORIA_WINDOWS_FIXTURE -ErrorAction SilentlyContinue
  Remove-Item Env:CBS_MEMORIA_WINDOWS_REPO -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}
