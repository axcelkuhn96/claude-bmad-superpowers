import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

// The program is fixed in the installed module. Paths and contents travel as JSON on stdin.
export const WINDOWS_SECURITY_PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
function Result($ok, $code, $extra = @{}) {
  $value = @{ ok = [bool]$ok; code = [string]$code; ownerMatches = $false;
    localNtfs = $false; noReparse = $false; daclSafe = $false; currentSid = '' }
  foreach ($key in $extra.Keys) { $value[$key] = $extra[$key] }
  [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 4))
}
function SafePath([string]$value) {
  if ($value -notmatch '^[A-Za-z]:\\' -or $value -match '[\x00-\x1f]' -or
      $value -match '[<>|"?*]' -or $value.Substring(2).Contains(':') -or
      $value -match '(^|\\)\.\.?($|\\)' -or $value -match '[. ]($|\\)') { throw 'unsafe_path' }
  return [System.IO.Path]::GetFullPath($value)
}
function Audit([string]$value, [string]$kind, [bool]$privateState = $true) {
  $full = SafePath $value
  $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($full))
  if ($drive.DriveType -ne [System.IO.DriveType]::Fixed -or $drive.DriveFormat -ne 'NTFS') { throw 'volume' }
  $root = [System.IO.Path]::GetPathRoot($full)
  $walk = $root
  foreach ($part in $full.Substring($root.Length).Split([char]'\')) {
    if (!$part) { continue }
    $walk = [System.IO.Path]::Combine($walk, $part)
    try { $attributes = [System.IO.File]::GetAttributes($walk) }
    catch [System.IO.FileNotFoundException] { throw 'missing' }
    catch [System.IO.DirectoryNotFoundException] { throw 'missing' }
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
  }
  if ($kind -eq 'file' -and ![System.IO.File]::Exists($full)) { throw 'missing' }
  if ($kind -eq 'directory' -and ![System.IO.Directory]::Exists($full)) { throw 'missing' }
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($kind -eq 'file') { $acl = [System.IO.File]::GetAccessControl($full) }
  else { $acl = [System.IO.Directory]::GetAccessControl($full) }
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
  if (($privateState -and !$acl.AreAccessRulesProtected) -or !$acl.AreAccessRulesCanonical) { throw 'dacl' }
  $allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  $ownerRead = $false
  $ownerWrite = $false
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
        $rule.IdentityReference.Value -notin $allowed) { throw 'dacl' }
    if ($rule.IdentityReference.Value -eq $sid.Value) {
      $rights = [int64]$rule.FileSystemRights
      if (($rights -band [int64][System.Security.AccessControl.FileSystemRights]::ReadData) -ne 0) { $ownerRead = $true }
      if (($rights -band [int64][System.Security.AccessControl.FileSystemRights]::WriteData) -ne 0) { $ownerWrite = $true }
    }
  }
  if (!$ownerRead -or !$ownerWrite) { throw 'dacl' }
  if ($privateState -and $full -ne $root) {
    [void](Audit ([System.IO.Path]::GetDirectoryName($full.TrimEnd([char]'\'))) 'directory' $false)
  }
  return @{ ok = $true; code = 'safe'; ownerMatches = $true; localNtfs = $true;
    noReparse = $true; daclSafe = $true; currentSid = $sid.Value }
}
function PrivateSecurity([bool]$directory) {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($directory) { $security = New-Object System.Security.AccessControl.DirectorySecurity }
  else { $security = New-Object System.Security.AccessControl.FileSecurity }
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  if ($directory) {
    $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  } else { $inherit = [System.Security.AccessControl.InheritanceFlags]::None }
  foreach ($principal in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $identity = [System.Security.Principal.SecurityIdentifier]::new($principal)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity,
      [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow)
    $security.AddAccessRule($rule)
  }
  return $security
}
try {
  $inputValue = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $target = SafePath ([string]$inputValue.path)
  switch ([string]$inputValue.action) {
    'inspect' { Result $true 'safe' (Audit $target ([string]$inputValue.kind) ([bool]$inputValue.privateState)); break }
    'ensure-directory' {
      $root = [System.IO.Path]::GetPathRoot($target)
      $walk = $root
      foreach ($part in $target.Substring($root.Length).Split([char]'\')) {
        if (!$part) { continue }
        $walk = [System.IO.Path]::Combine($walk, $part)
        if (![System.IO.Directory]::Exists($walk)) {
          if ([System.IO.File]::Exists($walk)) { throw 'not_directory' }
          [void](Audit ([System.IO.Path]::GetDirectoryName($walk)) 'directory' $false)
          [void][System.IO.Directory]::CreateDirectory($walk, (PrivateSecurity $true))
        }
        if (([System.IO.File]::GetAttributes($walk) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
      }
      Result $true 'safe' (Audit $target 'directory' ([bool]$inputValue.privateState)); break
    }
    'write-file' {
      $parent = [System.IO.Path]::GetDirectoryName($target)
      [void](Audit $parent 'directory' ([bool]$inputValue.privateState))
      $backup = $target + '.cbs-replace-backup'
      if ([System.IO.File]::Exists($backup)) {
        if (!$inputValue.replace) { throw 'recovery_required' }
        [void](Audit $backup 'file' ([bool]$inputValue.privateState))
        $previous = [System.IO.File]::ReadAllText($backup)
        if ([System.IO.File]::Exists($target)) {
          [void](Audit $target 'file' ([bool]$inputValue.privateState))
          $current = [System.IO.File]::ReadAllText($target)
          if ($current -eq [string]$inputValue.text) {
            [System.IO.File]::Delete($backup)
            Result $true 'safe' (Audit $target 'file' ([bool]$inputValue.privateState))
            break
          }
          if ($current -ne $previous) { throw 'recovery_required' }
          [System.IO.File]::Delete($backup)
        } else {
          [System.IO.File]::Move($backup, $target)
          [void](Audit $target 'file' ([bool]$inputValue.privateState))
        }
      }
      $exists = [System.IO.File]::Exists($target)
      if ($exists) {
        if (!$inputValue.replace) { throw 'exists' }
        [void](Audit $target 'file' ([bool]$inputValue.privateState))
        if ($null -ne $inputValue.expectedText -and
            [System.IO.File]::ReadAllText($target) -cne [string]$inputValue.expectedText) { throw 'changed' }
      } elseif ($inputValue.replace) { throw 'missing' }
      $temp = [System.IO.Path]::Combine($parent, ([System.IO.Path]::GetFileName($target) + '.' + [guid]::NewGuid().ToString('N') + '.tmp'))
      $stream = [System.IO.FileStream]::new($temp, [System.IO.FileMode]::CreateNew,
        [System.Security.AccessControl.FileSystemRights]::Write,
        [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::WriteThrough,
        (PrivateSecurity $false))
      try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes([string]$inputValue.text)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
      } finally { $stream.Dispose() }
      [void](Audit $temp 'file')
      if ($exists) { [System.IO.File]::Replace($temp, $target, $backup) }
      else { [System.IO.File]::Move($temp, $target) }
        $verified = Audit $target 'file' ([bool]$inputValue.privateState)
      if ([System.IO.File]::ReadAllText($target) -ne [string]$inputValue.text) { throw 'recovery_required' }
      if ($exists) { [System.IO.File]::Delete($backup) }
      Result $true 'safe' $verified
      break
    }
    'read-file' {
      [void](Audit ([System.IO.Path]::GetDirectoryName($target)) 'directory' ([bool]$inputValue.privateState))
      $backup = $target + '.cbs-replace-backup'
      if (![System.IO.File]::Exists($target) -and [System.IO.File]::Exists($backup)) {
        [void](Audit $backup 'file' ([bool]$inputValue.privateState))
        [System.IO.File]::Move($backup, $target)
      }
      if (![System.IO.File]::Exists($target)) { throw 'missing' }
      $stream = [System.IO.FileStream]::new($target, [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
      try {
        $result = Audit $target 'file' ([bool]$inputValue.privateState)
        if ($stream.Length -gt 1048576) { throw 'oversize' }
        $reader = [System.IO.StreamReader]::new($stream, [System.Text.UTF8Encoding]::new($false), $true, 4096, $true)
        try { $result['text'] = $reader.ReadToEnd() } finally { $reader.Dispose() }
        Result $true 'safe' $result
      } finally { $stream.Dispose() }
      break
    }
    'codex-plugin' {
      $scope = Audit $target 'directory' $false
      $command = Get-Command codex -CommandType Application -ErrorAction Stop
      $source = SafePath ([string]$command.Source)
      $product = SafePath ([string]$inputValue.productRoot)
      if ($source.StartsWith($target + '\', [System.StringComparison]::OrdinalIgnoreCase) -or
          $source.StartsWith($product + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'unsafe_tool' }
      $walk = [System.IO.Path]::GetPathRoot($source)
      foreach ($part in $source.Substring($walk.Length).Split([char]'\')) {
        if (!$part) { continue }
        $walk = [System.IO.Path]::Combine($walk, $part)
        if (([System.IO.File]::GetAttributes($walk) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe_tool' }
      }
      $listing = (& $source plugin list 2>$null | Out-String)
      if ($LASTEXITCODE -ne 0) { throw 'cli_failed' }
      $scope['installed'] = @($listing -split '\r?\n' | Where-Object {
        $_ -like '*claude-mem@claude-mem-local*' -and $_ -match 'installed' -and $_ -notmatch 'workspace.managed'
      }).Count -gt 0
      Result $true 'safe' $scope
      break
    }
    default { throw 'action' }
  }
} catch {
  $code = if ($_.Exception.Message -in @('unsafe_path','volume','reparse','missing','owner','dacl',
      'not_directory','exists','oversize','action','recovery_required','unsafe_tool','cli_failed','changed')) { $_.Exception.Message } else { 'security_error' }
  Result $false $code
}
`;

const WINDOWS_LOCK_PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadLine() | ConvertFrom-Json
  if ($request.key -notmatch '^[a-f0-9]{64}$') { throw 'key' }
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $security = New-Object System.Security.AccessControl.MutexSecurity
  $rule = [System.Security.AccessControl.MutexAccessRule]::new($sid,
    [System.Security.AccessControl.MutexRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow)
  $security.AddAccessRule($rule)
  $created = $false
  $mutex = [System.Threading.Mutex]::new($false, ('Global\CBS-Mem0-' + $sid.Value + '-' + $request.key),
    [ref]$created, $security)
  try {
    $held = $false
    try { $held = $mutex.WaitOne(5000) }
    catch [System.Threading.AbandonedMutexException] { $held = $true }
    if (!$held) { throw 'timeout' }
    try {
      [Console]::Out.WriteLine('LOCKED')
      [Console]::Out.Flush()
      [void][Console]::In.ReadToEnd()
    } finally { $mutex.ReleaseMutex() }
  } finally { $mutex.Dispose() }
} catch { [Console]::Out.WriteLine('BLOCKED') }
`;

export function windowsPathKey(value) {
  if (typeof value !== 'string') throw new Error('unsafe_windows_path');
  const windows = value.replace(/\//g, '\\');
  if (!/^[A-Za-z]:\\/.test(windows) || /[\x00-\x1f<>|"?*]/.test(windows) ||
      /(^|\\)\.\.?($|\\)/.test(windows) || /[. ]($|\\)/.test(windows) ||
      windows.slice(2).includes(':') || windows.startsWith('\\\\')) throw new Error('unsafe_windows_path');
  const normalized = path.win32.normalize(windows);
  return (normalized.length > 3 ? normalized.replace(/\\+$/, '') : normalized).toLowerCase();
}

export function parseWindowsSecurityResult(raw) {
  let result;
  try { result = JSON.parse(raw); } catch { return { ok: false, code: 'invalid_response' }; }
  if (result?.ok !== true || result.code !== 'safe' || result.ownerMatches !== true ||
      result.localNtfs !== true || result.noReparse !== true || result.daclSafe !== true ||
      !/^S-\d+(?:-\d+){2,}$/.test(result.currentSid ?? '')) {
    return { ok: false, code: typeof result?.code === 'string' ? result.code : 'invalid_response' };
  }
  return result;
}

function powershellExe() {
  const root = process.env.SystemRoot;
  windowsPathKey(root);
  if (!/^windows$/i.test(path.win32.basename(root))) throw new Error('unsafe_system_root');
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function powershellArgs(program) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(program, 'utf16le').toString('base64')];
}

async function invoke(action, file, extra = {}) {
  if (process.platform !== 'win32') return { ok: false, code: 'native_windows_unproved' };
  windowsPathKey(file);
  const command = powershellExe();
  const args = powershellArgs(WINDOWS_SECURITY_PROGRAM);
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(),
        ...(action === 'codex-plugin' ? { PATH: process.env.PATH,
          APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA,
          USERPROFILE: process.env.USERPROFILE } : {}) } });
    child.stdin.once('error', () => resolve({ ok: false, code: 'security_helper_failed' }));
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 2 * 1024 * 1024) child.kill(); });
    child.once('error', () => resolve({ ok: false, code: 'security_helper_failed' }));
    child.once('close', code => resolve(code === 0 ? parseWindowsSecurityResult(output.trim()) :
      { ok: false, code: 'security_helper_failed' }));
    child.stdin.end(JSON.stringify({ action, path: file, ...extra }));
  });
}

export async function canonicalWindowsPath(value) {
  windowsPathKey(value);
  if (process.platform !== 'win32') throw new Error('native_windows_unproved');
  const literal = path.win32.normalize(value.replace(/\//g, '\\'));
  if (!(await inspectWindowsPath(literal, 'directory', { privateState: false })).ok) {
    throw new Error('unsafe_windows_path');
  }
  const real = await fs.realpath(literal);
  const result = await inspectWindowsPath(real, 'directory', { privateState: false });
  if (!result.ok) throw new Error('unsafe_windows_path');
  return windowsPathKey(real);
}

export async function inspectWindowsPath(file, kind = 'file', { privateState = true } = {}) {
  if (!['file', 'directory'].includes(kind)) throw new Error('unsafe_windows_kind');
  return invoke('inspect', file, { kind, privateState });
}

export async function ensureWindowsPrivateDirectory(dir, { privateState = true } = {}) {
  return invoke('ensure-directory', dir, { privateState });
}

export async function writeWindowsPrivateFile(file, text, { replace = false, privateState = true,
  expectedText = null } = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
    return { ok: false, code: 'oversize' };
  }
  return invoke('write-file', file, { text, replace, privateState, expectedText });
}

export async function readWindowsPrivateFile(file, { privateState = true } = {}) {
  return invoke('read-file', file, { privateState });
}

export async function probeWindowsCodexPlugin(root, productRoot) {
  return invoke('codex-plugin', root, { productRoot });
}

export async function resolveWindowsExecutable(name, forbiddenRoots = []) {
  if (process.platform !== 'win32' || name !== 'git.exe') throw new Error('unsafe_windows_tool');
  const where = path.win32.join(process.env.SystemRoot, 'System32', 'where.exe');
  windowsPathKey(where);
  const { stdout } = await runFile(where, [name], { timeout: 5000, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } });
  const candidate = stdout.split(/\r?\n/).find(Boolean);
  const key = windowsPathKey(candidate);
  const real = windowsPathKey(await fs.realpath(candidate));
  if (key !== real || forbiddenRoots.some(root => {
    const prefix = windowsPathKey(root);
    return key === prefix || key.startsWith(prefix + '\\');
  })) throw new Error('unsafe_windows_tool');
  return candidate;
}

export async function withWindowsLock(key, callback) {
  if (process.platform !== 'win32' || typeof callback !== 'function') throw new Error('native_windows_unproved');
  const child = spawn(powershellExe(), powershellArgs(WINDOWS_LOCK_PROGRAM),
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir() } });
  const ready = await new Promise((resolve) => {
    let output = '';
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 7000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('\n')) { clearTimeout(timer); resolve(output.trim() === 'LOCKED'); }
    });
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('close', () => { clearTimeout(timer); resolve(false); });
    child.stdin.once('error', () => { clearTimeout(timer); resolve(false); });
    child.stdin.write(JSON.stringify({ key: createHash('sha256').update(key).digest('hex') }) + '\n');
  });
  if (!ready) { child.stdin.end(); throw new Error('windows_lock_failed'); }
  try { return await callback(); }
  finally { child.stdin.end(); }
}
