import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const runFile = promisify(execFile);
const nativeFile = new URL('./bin/windows-native-x64.node', import.meta.url);
const requireNative = createRequire(import.meta.url);
export const WINDOWS_NATIVE_SHA256 = '67acff10cfe721fbe8e340759da3d6b5124fe830ed53824af51bd529c25b7cc9';

export function windowsGitPattern(root, target) {
  const relative = path.win32.relative(windowsPathKey(root), windowsPathKey(target));
  if (!relative || relative === '..' || relative.startsWith('..\\') || path.win32.isAbsolute(relative)) {
    throw new Error('unsafe_windows_path');
  }
  return '/' + relative.replace(/\\/g, '/');
}

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
function AuditAncestor([string]$value, [bool]$toolOnly = $false) {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $acl = [System.IO.Directory]::GetAccessControl($value)
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $trusted = @($sid, 'S-1-5-18', 'S-1-5-32-544',
    'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  if ($toolOnly) { $trusted = @($trusted | Where-Object { $_ -ne $sid }) }
  if ($owner -notin $trusted) { throw 'ancestor' }
  $dangerous = [int64]([System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [System.Security.AccessControl.FileSystemRights]::Delete -bor
    [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [System.Security.AccessControl.FileSystemRights]::TakeOwnership)
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        $rule.IdentityReference.Value -notin $trusted -and
        (([int64]$rule.FileSystemRights -band $dangerous) -ne 0)) { throw 'ancestor' }
  }
}
function WalkAncestors([string]$value, [bool]$includeFinal = $false, [bool]$toolOnly = $false) {
  $full = SafePath $value
  $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($full))
  if ($drive.DriveType -ne [System.IO.DriveType]::Fixed -or $drive.DriveFormat -ne 'NTFS') { throw 'volume' }
  $root = [System.IO.Path]::GetPathRoot($full)
  $walk = $root
  AuditAncestor $root $toolOnly
  foreach ($part in $full.Substring($root.Length).Split([char]'\')) {
    if (!$part) { continue }
    $walk = [System.IO.Path]::Combine($walk, $part)
    try { $attributes = [System.IO.File]::GetAttributes($walk) }
    catch [System.IO.FileNotFoundException] { throw 'missing' }
    catch [System.IO.DirectoryNotFoundException] { throw 'missing' }
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
    if ($walk -ne $full -or $includeFinal) { AuditAncestor $walk $toolOnly }
  }
}
function Audit([string]$value, [string]$kind, [bool]$privateState = $true,
    [System.IO.FileStream]$handle = $null) {
  $full = SafePath $value
  WalkAncestors $full
  if ($kind -eq 'file' -and ![System.IO.File]::Exists($full)) { throw 'missing' }
  if ($kind -eq 'directory' -and ![System.IO.Directory]::Exists($full)) { throw 'missing' }
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($kind -eq 'file' -and $handle) { $acl = $handle.GetAccessControl() }
  elseif ($kind -eq 'file') { $acl = [System.IO.File]::GetAccessControl($full) }
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
function AuditTool([string]$value, $roots) {
  $full = SafePath $value
  $inside = $false
  foreach ($rootValue in $roots) {
    $root = SafePath ([string]$rootValue)
    if ($full.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) { $inside = $true }
  }
  if (!$inside) { throw 'unsafe_tool' }
  WalkAncestors $full $false $true
  if (![System.IO.File]::Exists($full) -or
      (([System.IO.File]::GetAttributes($full) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw 'unsafe_tool'
  }
  $acl = [System.IO.File]::GetAccessControl($full)
  $trusted = @('S-1-5-18', 'S-1-5-32-544',
    'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $trusted) {
    throw 'unsafe_tool'
  }
  $dangerous = [int64]([System.Security.AccessControl.FileSystemRights]::WriteData -bor
    [System.Security.AccessControl.FileSystemRights]::AppendData -bor
    [System.Security.AccessControl.FileSystemRights]::Delete -bor
    [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [System.Security.AccessControl.FileSystemRights]::TakeOwnership)
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        $rule.IdentityReference.Value -notin $trusted -and
        (([int64]$rule.FileSystemRights -band $dangerous) -ne 0)) { throw 'unsafe_tool' }
  }
  return @{ trustedTool = $true }
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
          WalkAncestors ([System.IO.Path]::GetDirectoryName($walk)) $true
          [void][System.IO.Directory]::CreateDirectory($walk, (PrivateSecurity $true))
        }
        if (([System.IO.File]::GetAttributes($walk) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
      }
      Result $true 'safe' (Audit $target 'directory' ([bool]$inputValue.privateState)); break
    }
    'write-file' {
      $parent = [System.IO.Path]::GetDirectoryName($target)
      [void](Audit $parent 'directory' ([bool]$inputValue.privateState))
      $intent = $target + '.cbs-replace-intent'
      if ([System.IO.File]::Exists($intent)) { throw 'recovery_required' }
      $exists = [System.IO.File]::Exists($target)
      if ($exists) {
        if (!$inputValue.replace) { throw 'exists' }
        if ($null -eq $inputValue.expectedText) { throw 'changed' }
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
      if ($exists) {
        $backup = $target + '.cbs-' + [guid]::NewGuid().ToString('N') + '.bak'
        $hasher = [System.Security.Cryptography.SHA256]::Create()
        try {
          $oldHash = [BitConverter]::ToString($hasher.ComputeHash(
            [System.Text.UTF8Encoding]::new($false).GetBytes([string]$inputValue.expectedText))).Replace('-', '')
          $newHash = [BitConverter]::ToString($hasher.ComputeHash($bytes)).Replace('-', '')
        } finally { $hasher.Dispose() }
        $manifest = @{ backup = $backup; temp = $temp; expectedTextHash =
          $oldHash; nextTextHash = $newHash } |
          ConvertTo-Json -Compress
        $intentStream = [System.IO.FileStream]::new($intent, [System.IO.FileMode]::CreateNew,
          [System.Security.AccessControl.FileSystemRights]::Write,
          [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::WriteThrough,
          (PrivateSecurity $false))
        try {
          $intentBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($manifest)
          $intentStream.Write($intentBytes, 0, $intentBytes.Length)
          $intentStream.Flush($true)
        } finally { $intentStream.Dispose() }
        [void](Audit $intent 'file')
        [System.IO.File]::Replace($temp, $target, $backup)
      } else { [System.IO.File]::Move($temp, $target) }
      $verified = Audit $target 'file' ([bool]$inputValue.privateState)
      if ([System.IO.File]::ReadAllText($target) -ne [string]$inputValue.text) { throw 'recovery_required' }
      if ($exists) {
        [void](Audit $backup 'file' ([bool]$inputValue.privateState))
        if ([System.IO.File]::ReadAllText($backup) -cne [string]$inputValue.expectedText) {
          throw 'recovery_required'
        }
        [System.IO.File]::Delete($backup)
        [System.IO.File]::Delete($intent)
      }
      Result $true 'safe' $verified
      break
    }
    'read-file' {
      [void](Audit ([System.IO.Path]::GetDirectoryName($target)) 'directory' ([bool]$inputValue.privateState))
      if ([System.IO.File]::Exists($target + '.cbs-replace-intent')) { throw 'recovery_required' }
      if (![System.IO.File]::Exists($target)) { throw 'missing' }
      $stream = [System.IO.FileStream]::new($target, [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
      try {
        $result = Audit $target 'file' ([bool]$inputValue.privateState) $stream
        if ($stream.Length -gt 1048576) { throw 'oversize' }
        $reader = [System.IO.StreamReader]::new($stream, [System.Text.UTF8Encoding]::new($false), $true, 4096, $true)
        try { $result['text'] = $reader.ReadToEnd() } finally { $reader.Dispose() }
        Result $true 'safe' $result
      } finally { $stream.Dispose() }
      break
    }
    'remove-file' {
      if ($null -eq $inputValue.expectedText) { throw 'changed' }
      [void](Audit ([System.IO.Path]::GetDirectoryName($target)) 'directory' ([bool]$inputValue.privateState))
      $rights = [System.Security.AccessControl.FileSystemRights]::ReadData -bor
        [System.Security.AccessControl.FileSystemRights]::ReadPermissions -bor
        [System.Security.AccessControl.FileSystemRights]::Delete
      $stream = [System.IO.FileStream]::new($target, [System.IO.FileMode]::Open,
        $rights, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::None)
      try {
        [void](Audit $target 'file' ([bool]$inputValue.privateState) $stream)
        if ($stream.Length -gt 1048576) { throw 'oversize' }
        $reader = [System.IO.StreamReader]::new($stream, [System.Text.UTF8Encoding]::new($false), $true, 4096, $true)
        try { $actual = $reader.ReadToEnd() } finally { $reader.Dispose() }
        if ($actual -cne [string]$inputValue.expectedText) { throw 'changed' }
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CbsDeleteByHandle {
  [StructLayout(LayoutKind.Sequential)]
  public struct Disposition { [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile; }
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetFileInformationByHandle(SafeFileHandle handle, int informationClass,
    ref Disposition value, uint size);
}
'@
        $disposition = [CbsDeleteByHandle+Disposition]::new()
        $disposition.DeleteFile = $true
        if (![CbsDeleteByHandle]::SetFileInformationByHandle($stream.SafeFileHandle, 4,
          [ref]$disposition, [uint32][Runtime.InteropServices.Marshal]::SizeOf($disposition))) {
          throw 'security_error'
        }
      } finally { $stream.Dispose() }
      Result $true 'safe' @{ ownerMatches = $true; localNtfs = $true; noReparse = $true;
        daclSafe = $true; currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
      break
    }
    'trusted-tool' { Result $true 'safe' (AuditTool $target $inputValue.programFiles); break }
    default { throw 'action' }
  }
} catch {
  $code = if ($_.Exception.Message -in @('unsafe_path','volume','reparse','missing','owner','dacl',
      'not_directory','exists','oversize','action','recovery_required','unsafe_tool','changed','ancestor')) { $_.Exception.Message } else { 'security_error' }
  Result $false $code
}
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

let nativePromise;
async function nativeWindows() {
  if (process.platform !== 'win32') throw new Error('native_windows_unproved');
  if (process.arch !== 'x64') throw new Error('unsupported_windows_arch');
  nativePromise ??= (async () => {
    const file = fileURLToPath(nativeFile);
    const bytes = await fs.readFile(file);
    if (createHash('sha256').update(bytes).digest('hex') !== WINDOWS_NATIVE_SHA256 ||
        windowsPathKey(file) !== windowsPathKey(await fs.realpath(file))) {
      throw new Error('unsafe_windows_native');
    }
    const native = requireNative(file);
    if (typeof native.locations !== 'function' || typeof native.acquire !== 'function' ||
        typeof native.release !== 'function') throw new Error('unsafe_windows_native');
    return native;
  })();
  return nativePromise;
}

let systemLocationsPromise;
async function systemLocations() {
  systemLocationsPromise ??= (async () => {
    const { windows, programFiles, programFilesX86 } = (await nativeWindows()).locations();
    const values = [windows, programFiles, programFilesX86].map(windowsPathKey);
    if (new Set(values).size !== 3) throw new Error('unsafe_windows_native');
    return { windows: values[0], programFiles: values[1], programFilesX86: values[2] };
  })();
  return systemLocationsPromise;
}

async function powershellExe() {
  const { windows } = await systemLocations();
  return path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function powershellArgs(program) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(program, 'utf16le').toString('base64')];
}

async function invoke(action, file, extra = {}) {
  if (process.platform !== 'win32') return { ok: false, code: 'native_windows_unproved' };
  windowsPathKey(file);
  const command = await powershellExe();
  const { windows } = await systemLocations();
  const args = powershellArgs(WINDOWS_SECURITY_PROGRAM);
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: { SystemRoot: windows, WINDIR: windows, TEMP: os.tmpdir(), PATH: '' } });
    const timer = setTimeout(() => child.kill(), 7000);
    child.stdin.once('error', () => resolve({ ok: false, code: 'security_helper_failed' }));
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 2 * 1024 * 1024) child.kill(); });
    child.once('error', () => resolve({ ok: false, code: 'security_helper_failed' }));
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, code: 'security_helper_failed' });
      if (action === 'trusted-tool') {
        try {
          const result = JSON.parse(output.trim());
          return resolve(result?.ok === true && result?.code === 'safe' && result?.trustedTool === true
            ? result : { ok: false, code: result?.code ?? 'invalid_response' });
        } catch { return resolve({ ok: false, code: 'invalid_response' }); }
      }
      resolve(parseWindowsSecurityResult(output.trim()));
    });
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

export function windowsCodexPluginInstalled(output) {
  return typeof output === 'string' && output.split(/\r?\n/).some(line => {
    const fields = line.trim().split(/\s+/);
    return fields.includes('claude-mem@claude-mem-local') &&
      fields.some(field => field.toLowerCase() === 'installed') &&
      !fields.some(field => /workspace[.-]managed/i.test(field));
  });
}

export async function removeWindowsPrivateFile(file, expectedText, { privateState = true } = {}) {
  if (typeof expectedText !== 'string' || Buffer.byteLength(expectedText, 'utf8') > 1024 * 1024) {
    return { ok: false, code: 'changed' };
  }
  return invoke('remove-file', file, { expectedText, privateState });
}

export async function probeWindowsCodexPlugin(root, productRoot) {
  try {
    const executable = await resolveWindowsExecutable('codex.exe', [root, productRoot]);
    const { windows } = await systemLocations();
    const { stdout } = await runFile(executable, ['plugin', 'list'], { cwd: root, timeout: 5000,
      maxBuffer: 1024 * 1024, windowsHide: true,
      env: { ...process.env, SystemRoot: windows, WINDIR: windows, PATH: path.win32.dirname(executable) } });
    return { ok: true, installed: windowsCodexPluginInstalled(stdout) };
  } catch { return { ok: false, code: 'unsafe_tool' }; }
}

export async function resolveWindowsExecutable(name, forbiddenRoots = []) {
  if (process.platform !== 'win32' || !['git.exe', 'codex.exe'].includes(name)) throw new Error('unsafe_windows_tool');
  const locations = await systemLocations();
  const where = path.win32.join(locations.windows, 'System32', 'where.exe');
  const { stdout } = await runFile(where, [name], { timeout: 5000, maxBuffer: 65536,
    windowsHide: true, env: { SystemRoot: locations.windows, PATH: process.env.PATH ?? '' } });
  for (const candidate of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const key = windowsPathKey(candidate);
      if (key !== windowsPathKey(await fs.realpath(candidate)) || forbiddenRoots.some(root => {
        const prefix = windowsPathKey(root);
        return key === prefix || key.startsWith(prefix + '\\');
      })) continue;
      const result = await invoke('trusted-tool', candidate,
        { programFiles: [locations.programFiles, locations.programFilesX86] });
      if (result.ok) return candidate;
    } catch { /* Reject this PATH entry and inspect the next one. */ }
  }
  throw new Error('unsafe_windows_tool');
}

const localLocks = new Map();
export async function withWindowsLock(key, callback) {
  if (process.platform !== 'win32' || typeof callback !== 'function') throw new Error('native_windows_unproved');
  const native = await nativeWindows();
  const digest = createHash('sha256').update(key).digest('hex');
  const previous = localLocks.get(digest) ?? Promise.resolve();
  let next;
  const pending = new Promise(resolve => { next = resolve; });
  localLocks.set(digest, pending);
  await previous;
  let lease;
  let held = false;
  try {
    lease = native.acquire(digest);
    held = true;
    const assertHeld = () => { if (!held) throw new Error('windows_lock_lost'); };
    const result = await callback(assertHeld);
    assertHeld();
    return result;
  } finally {
    try {
      if (held) {
        held = false;
        if (native.release(lease) !== true) throw new Error('windows_lock_release_failed');
      }
    } finally {
      next();
      if (localLocks.get(digest) === pending) localLocks.delete(digest);
    }
  }
}
