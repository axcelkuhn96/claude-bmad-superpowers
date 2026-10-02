param(
  [string]$ProductRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$ReportPath = (Join-Path $env:TEMP ('cbs-memoria-windows-' + [guid]::NewGuid().ToString('N') + '.json')),
  [string]$RuntimeStateDir,
  [string]$ModelPath,
  [string]$TokenizerPath,
  [switch]$CheckDirectML
)

# Native Windows diagnostic only. It never activates Mem0 or changes user CLI configuration.
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $ReportPath) { throw 'ReportPath must be a new file' }
$report = [ordered]@{
  schema = 'cbs-mem0-windows-diagnostic-v1'
  status = 'BLOCKED_UNSUPPORTED'
  platform = [System.Environment]::OSVersion.Platform.ToString()
  controls = [ordered]@{}
}
function Record([string]$name, [string]$status, $evidence) {
  $report.controls[$name] = [ordered]@{ status = $status; evidence = $evidence }
}
function Save-Report {
  $parent = Split-Path -Parent $ReportPath
  if ($parent -and !(Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($report | ConvertTo-Json -Depth 12) + "`n")
  $stream = [System.IO.File]::Open($ReportPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  Write-Output $ReportPath
}
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  $report.status = 'UNSUPPORTED_PLATFORM'
  Record 'native_platform' 'unsupported' @{ reason = 'Requires actual Windows/NTFS; this run is not Windows proof' }
  Save-Report
  exit 2
}

Record 'native_platform' 'observed' @{ os = [System.Environment]::OSVersion.VersionString; powershell = $PSVersionTable.PSVersion.ToString() }
$fixture = Join-Path $env:TEMP ('cbs-memoria-diagnostic-' + [guid]::NewGuid().ToString('N'))
$child = $null
$second = $null
try {
  New-Item -ItemType Directory -Path $fixture | Out-Null
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls $fixture /inheritance:r /grant:r "${sid}:(OI)(CI)F" > $null
  if ($LASTEXITCODE -ne 0) { throw 'fixture ACL setup failed' }
  $acl = Get-Acl -LiteralPath $fixture
  $ownerSid = ([System.Security.Principal.NTAccount]::new($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  $allowed = @($sid, 'S-1-5-18', 'S-1-5-32-544')
  $unexpected = @($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $allowed })
  $probe = Join-Path $fixture 'owner-read-write.txt'
  [System.IO.File]::WriteAllText($probe, 'fixture-only')
  $actualReadWrite = [System.IO.File]::ReadAllText($probe) -eq 'fixture-only'
  $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($fixture))
  $isNtfs = $drive.DriveFormat -eq 'NTFS'
  Record 'fixture_ntfs_sid_dacl' $(if ($ownerSid -eq $sid -and !$unexpected.Count -and $actualReadWrite -and $isNtfs) { 'observed' } else { 'failed' }) @{
    filesystem = $drive.DriveFormat; owner_matches_current_sid = ($ownerSid -eq $sid)
    unexpected_allow_aces = @($unexpected | ForEach-Object { $_.IdentityReference.Value })
    actual_owner_read_write = $actualReadWrite; inherited_aces = @($rules | Where-Object IsInherited).Count
  }
} catch {
  Record 'fixture_ntfs_sid_dacl' 'unproved' @{ error_type = $_.Exception.GetType().Name }
}

try {
  $repo = Join-Path $fixture 'repo'
  New-Item -ItemType Directory -Path $repo | Out-Null
  & git init -q $repo
  if ($LASTEXITCODE -ne 0) { throw 'git init failed' }
  & git -C $repo -c user.name=cbs-diagnostic -c user.email=diagnostic@invalid.example commit --allow-empty -q -m fixture
  if ($LASTEXITCODE -ne 0) { throw 'fixture commit failed' }
  $sub = Join-Path $repo 'subdir'
  New-Item -ItemType Directory -Path $sub | Out-Null
  $worktree = Join-Path $fixture 'worktree'
  & git -C $repo worktree add --detach -q $worktree HEAD
  if ($LASTEXITCODE -ne 0) { throw 'fixture worktree failed' }
  $alias = Join-Path $fixture 'junction'
  $junction = $false
  try { New-Item -ItemType Junction -Path $alias -Target $repo | Out-Null; $junction = $true } catch { }
  $rootGit = (& git -C $repo rev-parse --show-toplevel).Trim()
  $subGit = (& git -C $sub rev-parse --show-toplevel).Trim()
  $worktreeGit = (& git -C $worktree rev-parse --show-toplevel).Trim()
  $caseAlias = $repo.ToUpperInvariant()
  $caseGit = (& git -C $caseAlias rev-parse --show-toplevel).Trim()
  $aliasGit = if ($junction) { (& git -C $alias rev-parse --show-toplevel).Trim() } else { $null }
  $rootCanonical = [System.IO.Path]::GetFullPath($rootGit).TrimEnd('\')
  $sameSub = [string]::Equals($rootCanonical, ([System.IO.Path]::GetFullPath($subGit)).TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)
  $sameCase = [string]::Equals($rootCanonical, ([System.IO.Path]::GetFullPath($caseGit)).TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)
  $differentWorktree = ![string]::Equals($rootCanonical, ([System.IO.Path]::GetFullPath($worktreeGit)).TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)
  Record 'git_aliases_fixture' $(if ($sameSub -and $sameCase -and $differentWorktree) { 'observed' } else { 'failed' }) @{
    root_subdir_same = $sameSub; case_alias_same = $sameCase; worktree_distinct = $differentWorktree
    junction_created = $junction; junction_root_reported = $aliasGit; cross_drive = 'unproved'
  }
} catch {
  Record 'git_aliases_fixture' 'unproved' @{ error_type = $_.Exception.GetType().Name }
}

try {
  $env:CBS_MEMORIA_WINDOWS_REPO = (Resolve-Path -LiteralPath $ProductRoot).Path
  $env:CBS_MEMORIA_WINDOWS_FIXTURE = $fixture
  $env:CBS_MEMORIA_WINDOWS_GIT_ROOT = $repo
  $env:CBS_MEMORIA_WINDOWS_GIT_SUB = $sub
  $env:CBS_MEMORIA_WINDOWS_GIT_CASE = $caseAlias
  $env:CBS_MEMORIA_WINDOWS_GIT_WORKTREE = $worktree
  $env:CBS_MEMORIA_WINDOWS_GIT_JUNCTION = if ($junction) { $alias } else { '' }
  $guardCode = @'
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const root = process.env.CBS_MEMORIA_WINDOWS_REPO;
const local = name => import(pathToFileURL(path.join(root, 'base', 'memoria', name)).href);
const { runtimePython, RUNTIME_PINS } = await local('runtime.mjs');
const { activateProject, authorizeCurrentDestination } = await local('setup.mjs');
const { applyNativeExclusion, verifyNativeCapture } = await local('native.mjs');
const { requestBroker } = await local('broker.mjs');
const { identifyProject } = await local('project-id.mjs');
const { inspectConfiguration, initializeSession, resolveProject } = await local('provider.mjs');
const { createLaunch } = await local('launch.mjs');
const { createOutbox } = await local('outbox.mjs');
const fixture = process.env.CBS_MEMORIA_WINDOWS_FIXTURE;
const project = process.env.CBS_MEMORIA_WINDOWS_GIT_ROOT;
const stateRoot = path.join(fixture, 'state');
const defaultSelection = await initializeSession(project, 'fixture-default', { event: 'SessionStart', stateRoot });
await fs.mkdir(path.join(project, '.cbs'));
await fs.writeFile(path.join(project, '.cbs', 'memoria.json'), JSON.stringify({
  provider: 'mem0', project_id: 'fixture',
  qdrant: { url: 'http://127.0.0.1:6333', collection: 'fixture', api_key_env: 'CBS_FIXTURE_KEY' },
  embedding: { model: 'multilingual-e5-small', dimension: 384,
    fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` },
}));
const optinSelection = await inspectConfiguration(project, { stateRoot });
const optinSession = await initializeSession(project, 'fixture-optin', { event: 'SessionStart', stateRoot });
const pinnedSession = await resolveProject(project, 'fixture-optin', { stateRoot });
let secretRead = false;
const untrustedAuthorization = await authorizeCurrentDestination(project, 'fixture-optin',
  () => { secretRead = true; return 'fixture-key'; }, { stateRoot });
const nativeCapture = Object.fromEntries(await Promise.all(['claude', 'codex'].map(async cli =>
  [cli, (await verifyNativeCapture(project, { cli, projectRoot: project })).reason])));
let replay;
try { await createOutbox(path.join(fixture, 'outbox-state')).pending(); replay = 'unexpected_success'; }
catch (error) { replay = error.message; }
const launch = Object.fromEntries(await Promise.all(['claude', 'codex'].map(async cli =>
  [cli, (await createLaunch(project, cli, { stateRoot })).reason])));
const gitInputs = Object.fromEntries(['ROOT', 'SUB', 'CASE', 'WORKTREE', 'JUNCTION']
  .map(name => [name, process.env['CBS_MEMORIA_WINDOWS_GIT_' + name]]).filter(([, value]) => value));
const git = Object.fromEntries(await Promise.all(Object.entries(gitInputs)
  .map(async ([name, value]) => [name, await identifyProject(value)])));
process.stdout.write(JSON.stringify({ platform: process.platform,
  runtime_path: runtimePython(fixture),
  activation: (await activateProject(fixture)).reason,
  native_exclusion: (await applyNativeExclusion(fixture, { cli: 'codex' })).reason,
  broker: (await requestBroker({}, '')).reason, git,
  selection: { default: defaultSelection.provider, optin: optinSelection.provider,
    session: optinSession.provider, pinned: pinnedSession.provider,
    untrusted_authorization: untrustedAuthorization.reason, secret_read: secretRead },
  native_capture: nativeCapture, replay, launch }));
'@
  $guardJson = $guardCode | & node --input-type=module -
  if ($LASTEXITCODE -ne 0) { throw 'guard check failed' }
  $guard = $guardJson | ConvertFrom-Json
  $expectedPath = Join-Path $fixture 'runtime\Scripts\python.exe'
  $guardsHold = $guard.platform -eq 'win32' -and $guard.runtime_path -eq $expectedPath -and
    $guard.activation -eq 'native_windows_unproved' -and $guard.native_exclusion -eq 'native_windows_unproved' -and
    $guard.broker -eq 'native_windows_unproved'
  Record 'production_windows_guards' $(if ($guardsHold) { 'unsupported' } else { 'unproved' }) @{
    runtime_path_matches_windows = ($guard.runtime_path -eq $expectedPath)
    activation = $guard.activation; native_exclusion = $guard.native_exclusion; broker = $guard.broker
  }
  $selectionOkay = $guard.selection.default -eq 'claude-mem' -and $guard.selection.optin -eq 'mem0' -and
    $guard.selection.session -eq 'mem0' -and $guard.selection.pinned -eq 'mem0' -and
    $guard.selection.untrusted_authorization -eq 'trust_changed' -and !$guard.selection.secret_read
  Record 'production_default_optin_selection_fixture' $(if ($selectionOkay) { 'observed' } else { 'unproved' }) @{
    default = $guard.selection.default; optin = $guard.selection.optin
    fresh_session = $guard.selection.session; pinned_session = $guard.selection.pinned
    untrusted_authorization = $guard.selection.untrusted_authorization
    untrusted_config_read_secret = $guard.selection.secret_read
    production_activation = $guard.activation; trust_written = $false
  }
  $nativeGuardsHold = $guard.native_capture.claude -eq 'native_windows_unproved' -and
    $guard.native_capture.codex -eq 'native_windows_unproved' -and
    $guard.native_exclusion -eq 'native_windows_unproved' -and
    $guard.activation -eq 'native_windows_unproved'
  Record 'native_claude_codex_hooks_exclusion_trust' $(if ($nativeGuardsHold) { 'unsupported' } else { 'unproved' }) @{
    claude_capture = $guard.native_capture.claude; codex_capture = $guard.native_capture.codex
    exclusion = $guard.native_exclusion; activation = $guard.activation
    claude_cli_available = [bool](Get-Command claude -ErrorAction SilentlyContinue)
    codex_cli_available = [bool](Get-Command codex -ErrorAction SilentlyContinue)
    native_cli_fixture_executed = $false; trust_authorized = $false
  }
  $replayGuardsHold = $guard.replay -eq 'native_windows_unproved' -and
    $guard.broker -eq 'native_windows_unproved' -and
    $guard.launch.claude -eq 'native_windows_unproved' -and
    $guard.launch.codex -eq 'native_windows_unproved'
  Record 'native_outbox_replay_two_machines' $(if ($replayGuardsHold) { 'unsupported' } else { 'unproved' }) @{
    outbox_replay_precondition = $guard.replay; broker = $guard.broker
    claude_launch = $guard.launch.claude; codex_launch = $guard.launch.codex
    durable_replay_executed = $false; second_machine_executed = $false
  }
  $git = $guard.git
  $identityGood = $git.ROOT.kind -eq 'git' -and $git.SUB.kind -eq 'git' -and $git.CASE.kind -eq 'git' -and
    $git.WORKTREE.kind -eq 'git' -and $git.ROOT.projectRoot -eq $git.SUB.projectRoot -and
    $git.ROOT.projectRoot -eq $git.CASE.projectRoot -and $git.ROOT.projectRoot -eq $git.WORKTREE.projectRoot -and
    $git.ROOT.activeRoot -ne $git.WORKTREE.activeRoot
  if ($junction) { $identityGood = $identityGood -and $git.JUNCTION.kind -eq 'git' -and $git.ROOT.projectRoot -eq $git.JUNCTION.projectRoot }
  Record 'production_git_identity_fixture' $(if ($identityGood) { 'observed' } else { 'unproved' }) @{
    root = $git.ROOT.kind; subdir = $git.SUB.kind; case_alias = $git.CASE.kind
    junction = if ($junction) { $git.JUNCTION.kind } else { 'unproved' }
    worktree = $git.WORKTREE.kind; shared_project_root = $identityGood
    cross_drive = 'unproved'
  }
} catch {
  Record 'production_windows_guards' 'unproved' @{ error_type = $_.Exception.GetType().Name }
}

try {
  $lockCode = @'
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.CBS_MEMORIA_WINDOWS_REPO;
const fixture = process.env.CBS_MEMORIA_WINDOWS_FIXTURE;
const mode = process.env.CBS_MEMORIA_WINDOWS_LOCK_MODE;
const { withProjectLock } = await import(pathToFileURL(path.join(root, 'base', 'memoria', 'ledger.mjs')).href);
await withProjectLock(fixture, async () => {
  const temp = path.join(fixture, 'crash-record.tmp');
  const target = path.join(fixture, 'crash-record.json');
  if (mode === 'hold') {
    const handle = await fs.open(temp, 'wx');
    try { await handle.writeFile('{"fixture":true}\n'); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, target);
  }
  await fs.writeFile(path.join(fixture, mode + '.ready'), 'ready');
  if (mode === 'hold') await new Promise(resolve => setTimeout(resolve, 60000));
}, 'diagnostic.lock', 2000);
'@
  function Start-OwnNode([string]$mode) {
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = (Get-Command node).Source
    $info.Arguments = '--input-type=module -'
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables.Clear()
    foreach ($name in 'PATH','SystemRoot','TEMP','USERPROFILE') {
      if ([System.Environment]::GetEnvironmentVariable($name)) {
        $info.EnvironmentVariables[$name] = [System.Environment]::GetEnvironmentVariable($name)
      }
    }
    $info.EnvironmentVariables['CBS_MEMORIA_WINDOWS_REPO'] = $env:CBS_MEMORIA_WINDOWS_REPO
    $info.EnvironmentVariables['CBS_MEMORIA_WINDOWS_FIXTURE'] = $fixture
    $info.EnvironmentVariables['CBS_MEMORIA_WINDOWS_LOCK_MODE'] = $mode
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $info
    [void]$process.Start()
    $process.StandardInput.Write($lockCode)
    $process.StandardInput.Close()
    return $process
  }
  $child = Start-OwnNode 'hold'
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (!(Test-Path -LiteralPath (Join-Path $fixture 'hold.ready')) -and !$child.HasExited -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if (!(Test-Path -LiteralPath (Join-Path $fixture 'hold.ready'))) { throw 'lock holder did not acquire' }
  Stop-Process -Id $child.Id -Force
  $child.WaitForExit(5000) | Out-Null
  $second = Start-OwnNode 'reacquire'
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (!(Test-Path -LiteralPath (Join-Path $fixture 'reacquire.ready')) -and !$second.HasExited -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  $reacquired = Test-Path -LiteralPath (Join-Path $fixture 'reacquire.ready')
  $recordPreserved = [System.IO.File]::ReadAllText((Join-Path $fixture 'crash-record.json')).TrimEnd([char[]]"`r`n") -eq '{"fixture":true}'
  Record 'own_child_lock_crash_fixture' $(if ($reacquired -and $recordPreserved) { 'observed' } else { 'unproved' }) @{
    lock_reacquired_after_recorded_child_termination = $reacquired
    fsynced_renamed_record_readable_after_child_termination = $recordPreserved
    power_loss_durability = 'unproved'; production_outbox_replay = 'unproved'
  }
} catch {
  Record 'own_child_lock_crash_fixture' 'unproved' @{ error_type = $_.Exception.GetType().Name }
} finally {
  foreach ($process in @($child, $second)) {
    if ($process -and !$process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  }
}

if ($RuntimeStateDir) {
  try {
    $python = Join-Path $RuntimeStateDir 'runtime\Scripts\python.exe'
    if (!(Test-Path -LiteralPath $python -PathType Leaf)) { throw 'existing runtime missing' }
    $runtimeJson = & $python -c 'import json,sys,importlib.metadata as m; print(json.dumps({"python":sys.version.split()[0],"onnxruntime":m.version("onnxruntime"),"qdrant_client":m.version("qdrant-client")}))'
    if ($LASTEXITCODE -ne 0) { throw 'runtime probe failed' }
    Record 'existing_runtime' 'observed' ($runtimeJson | ConvertFrom-Json)
  } catch { Record 'existing_runtime' 'unproved' @{ error_type = $_.Exception.GetType().Name } }
} else { Record 'existing_runtime' 'unproved' @{ reason = 'RuntimeStateDir not supplied; no runtime downloaded or installed' } }

if ($RuntimeStateDir -and $ModelPath -and $TokenizerPath) {
  try {
    $env:CBS_MEMORIA_MODEL = (Resolve-Path -LiteralPath $ModelPath).Path
    $env:CBS_MEMORIA_TOKENIZER = (Resolve-Path -LiteralPath $TokenizerPath).Path
    $env:CBS_MEMORIA_WINDOWS_DML = if ($CheckDirectML) { '1' } else { '0' }
    $embeddingCode = @'
import json, os, sys, time
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer
sys.path.insert(0, os.environ['CBS_MEMORIA_WINDOWS_REPO'])
from base.memoria.python.mem0_adapter import E5Embedder
text = 'cbs diagnostic vector'
start = time.perf_counter()
cpu = E5Embedder().embed(text)
result = {'cpu_provider': 'CPUExecutionProvider', 'cpu_dimensions': len(cpu), 'cpu_norm': float(np.linalg.norm(cpu)),
          'cpu_ms': round((time.perf_counter() - start) * 1000, 3), 'providers': ort.get_available_providers()}
if os.environ['CBS_MEMORIA_WINDOWS_DML'] == '1':
    if 'DmlExecutionProvider' not in ort.get_available_providers():
        result['directml'] = 'unavailable'
    else:
        tokenizer = Tokenizer.from_file(os.environ['CBS_MEMORIA_TOKENIZER'])
        tokenizer.enable_truncation(max_length=512)
        encoded = tokenizer.encode('passage: ' + text)
        ids = np.asarray([encoded.ids], dtype=np.int64)
        mask = np.asarray([encoded.attention_mask], dtype=np.int64)
        options = ort.SessionOptions()
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.enable_mem_pattern = False
        start = time.perf_counter()
        session = ort.InferenceSession(os.environ['CBS_MEMORIA_MODEL'], sess_options=options, providers=['DmlExecutionProvider'])
        names = {item.name for item in session.get_inputs()}
        inputs = {'input_ids': ids, 'attention_mask': mask, 'token_type_ids': np.zeros_like(ids)}
        output = session.run(None, {name: inputs[name] for name in names})[0]
        pooled = (output * mask[:, :, None]).sum(axis=1) / mask.sum(axis=1)[:, None]
        vector = (pooled / np.linalg.norm(pooled, axis=1, keepdims=True))[0].astype('float32')
        result['directml'] = {'actual_providers': session.get_providers(), 'dimensions': len(vector),
                              'max_abs_diff_cpu': float(np.max(np.abs(vector - np.asarray(cpu)))),
                              'ms': round((time.perf_counter() - start) * 1000, 3)}
print(json.dumps(result))
'@
    $embeddingJson = $embeddingCode | & $python -
    if ($LASTEXITCODE -ne 0) { throw 'existing model/runtime probe failed' }
    $embedding = $embeddingJson | ConvertFrom-Json
    $cpuOkay = $embedding.cpu_dimensions -eq 384 -and [Math]::Abs($embedding.cpu_norm - 1) -lt 0.0001
    Record 'existing_e5_cpu' 'unproved' @{
      diagnostic = $embedding; one_vector_dimensions_and_norm_ok = $cpuOkay
      missing_proof = @('representative corpus', 'stored-row vectors', 'CPU/RAM p95 and peak measurements')
    }
    if ($CheckDirectML) {
      $dml = $embedding.directml
      $dmlOkay = $dml -and $dml.actual_providers -contains 'DmlExecutionProvider' -and
        $dml.dimensions -eq 384 -and $dml.max_abs_diff_cpu -le 0.0001
      Record 'existing_directml' 'unproved' @{
        one_vector_diagnostic = $dml; provider_listed_and_one_vector_within_tolerance = $dmlOkay
        device_execution_proved = $false
        missing_proof = @('representative corpus with max absolute difference <= 1e-4',
          'stored-row comparison and new fingerprint if drift', 'CPU/RAM/VRAM and p95 measurements')
      }
    } else { Record 'existing_directml' 'unproved' @{ reason = 'optional CheckDirectML not requested' } }
  } catch {
    Record 'existing_e5_cpu' 'unproved' @{ error_type = $_.Exception.GetType().Name }
    Record 'existing_directml' 'unproved' @{ reason = 'existing runtime/model probe failed or unavailable' }
  }
} else {
  Record 'existing_e5_cpu' 'unproved' @{ reason = 'existing runtime, model and tokenizer paths not all supplied' }
  Record 'existing_directml' 'unproved' @{ reason = 'requires existing runtime/model/tokenizer and explicit CheckDirectML' }
}

if (!$report.controls.Contains('native_claude_codex_hooks_exclusion_trust')) {
  Record 'native_claude_codex_hooks_exclusion_trust' 'unproved' @{ reason = 'production fixture probe failed before reaching native controls' }
}
if (!$report.controls.Contains('native_outbox_replay_two_machines')) {
  Record 'native_outbox_replay_two_machines' 'unproved' @{ reason = 'production fixture probe failed before reaching replay controls' }
}
Record 'windows_activation_release' 'unsupported' @{ reason = 'diagnostic cannot authorize opt-in; native implementation and user-machine E2E gates remain' }

foreach ($name in 'CBS_MEMORIA_WINDOWS_REPO','CBS_MEMORIA_WINDOWS_FIXTURE','CBS_MEMORIA_MODEL','CBS_MEMORIA_TOKENIZER','CBS_MEMORIA_WINDOWS_DML','CBS_MEMORIA_WINDOWS_GIT_ROOT','CBS_MEMORIA_WINDOWS_GIT_SUB','CBS_MEMORIA_WINDOWS_GIT_CASE','CBS_MEMORIA_WINDOWS_GIT_WORKTREE','CBS_MEMORIA_WINDOWS_GIT_JUNCTION') {
  Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}
try { Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction Stop } catch {
  Record 'fixture_cleanup' 'unproved' @{ error_type = $_.Exception.GetType().Name }
}
Save-Report
exit 1
