import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const runFile = promisify(execFile);
const nativeFile = new URL('./bin/windows-native-x64.node', import.meta.url);
const requireNative = createRequire(import.meta.url);
export const WINDOWS_NATIVE_SHA256 = '03c857bd73e4457d2132782656454702254b4c1d6052dda10bf1f3754aa3ed9e';

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
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class CbsFileHandle {
  [StructLayout(LayoutKind.Sequential)]
  public struct FileTime { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)]
  public struct Information {
    public uint Attributes;
    public FileTime Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct Disposition { [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct RenameInfo {
    public uint Flags;
    public IntPtr RootDirectory;
    public uint FileNameLength;
    public char FileName;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Information value);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int informationClass,
    ref Disposition value, uint size);
  [DllImport("kernel32.dll", EntryPoint="SetFileInformationByHandle", SetLastError=true)]
  static extern bool SetFileInformationByHandleRaw(SafeFileHandle handle, int informationClass,
    IntPtr value, uint size);
  public static string Identity(SafeFileHandle handle) {
    Information value;
    if (!GetFileInformationByHandle(handle, out value)) throw new InvalidOperationException("identity");
    return value.Volume.ToString("x8") + ":" + value.IndexHigh.ToString("x8") + value.IndexLow.ToString("x8");
  }
  public static void Delete(SafeFileHandle handle) {
    Disposition value = new Disposition { DeleteFile = true };
    if (!SetFileInformationByHandle(handle, 4, ref value, (uint)Marshal.SizeOf(typeof(Disposition))))
      throw new InvalidOperationException("delete");
  }
  public static int RenameNew(SafeFileHandle handle, string target) {
    // kernel32 reads FileName as a NUL-terminated string and FileRenameInfo ignores the
    // long-path opt-in: without the terminator, heap bytes were appended to the target name.
    byte[] name = Encoding.Unicode.GetBytes(@"\\?\" + target);
    int root = Marshal.OffsetOf(typeof(RenameInfo), "RootDirectory").ToInt32();
    int length = Marshal.OffsetOf(typeof(RenameInfo), "FileNameLength").ToInt32();
    int offset = Marshal.OffsetOf(typeof(RenameInfo), "FileName").ToInt32();
    IntPtr value = Marshal.AllocHGlobal(offset + name.Length + 2);
    try {
      Marshal.WriteInt32(value, 0, 0);
      Marshal.WriteIntPtr(value, root, IntPtr.Zero);
      Marshal.WriteInt32(value, length, name.Length);
      Marshal.Copy(name, 0, IntPtr.Add(value, offset), name.Length);
      Marshal.WriteInt16(value, offset + name.Length, 0);
      return SetFileInformationByHandleRaw(handle, 3, value, (uint)(offset + name.Length + 2))
        ? 0 : Marshal.GetLastWin32Error();
    } finally { Marshal.FreeHGlobal(value); }
  }
}
'@
function ExactVersion([System.IO.FileStream]$stream) {
  if ($stream.Length -gt 1048576) { throw 'oversize' }
  $stream.Position = 0
  $bytes = [byte[]]::new([int]$stream.Length)
  $offset = 0
  while ($offset -lt $bytes.Length) {
    $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
    if ($count -le 0) { throw 'security_error' }
    $offset += $count
  }
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {
    throw 'invalid_text'
  }
  try { $decoded = [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes) }
  catch [System.Text.DecoderFallbackException] { throw 'invalid_text' }
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try { $digest = [BitConverter]::ToString($hasher.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
  finally { $hasher.Dispose() }
  return @{ text = $decoded; sha256 = $digest; fileId = [CbsFileHandle]::Identity($stream.SafeFileHandle) }
}
function RemoveVersioned([string]$value, [string]$expectedHash, [string]$expectedId,
    [bool]$privateState = $true) {
  $rights = [System.Security.AccessControl.FileSystemRights]::ReadData -bor
    [System.Security.AccessControl.FileSystemRights]::ReadPermissions -bor
    [System.Security.AccessControl.FileSystemRights]::Delete
  $stream = [System.IO.FileStream]::new($value, [System.IO.FileMode]::Open,
    $rights, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::None)
  try {
    [void](Audit $value 'file' $privateState $stream)
    $version = ExactVersion $stream
    if ($version.sha256 -cne $expectedHash -or $version.fileId -cne $expectedId) { throw 'changed' }
    [CbsFileHandle]::Delete($stream.SafeFileHandle)
  } finally { $stream.Dispose() }
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
  # Outside private state only integrity matters: a read/execute-only grant to another
  # principal (e.g. CodexSandboxUsers inherited under the profile) cannot alter the object.
  $mutating = [int64]([System.Security.AccessControl.FileSystemRights]'WriteData,AppendData,WriteExtendedAttributes,WriteAttributes,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership') -bor
    [int64]0x10000000 -bor [int64]0x40000000
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  $ownerRead = $false
  $ownerWrite = $false
  foreach ($rule in $rules) {
    # A deny entry can only narrow access, so it cannot weaken an integrity-only audit.
    if (!$privateState -and
        $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny) { continue }
    if (!$privateState -and
        $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        $rule.IdentityReference.Value -notin $allowed -and
        (([int64]$rule.FileSystemRights -band $mutating) -eq 0)) { continue }
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
function Invoke-CbsRequest([string]$raw) {
try {
  $inputValue = $raw | ConvertFrom-Json
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
      if ($inputValue.replace) { throw 'unsupported_windows_replace' }
      if ([System.IO.File]::Exists($target)) { throw 'exists' }
      try { $bytes = [System.Text.UTF8Encoding]::new($false, $true).GetBytes([string]$inputValue.text) }
      catch [System.Text.EncoderFallbackException] { throw 'invalid_text' }
      $temp = [System.IO.Path]::Combine($parent, ([System.IO.Path]::GetFileName($target) + '.' + [guid]::NewGuid().ToString('N') + '.tmp'))
      $rights = [System.Security.AccessControl.FileSystemRights]::ReadData -bor
        [System.Security.AccessControl.FileSystemRights]::WriteData -bor
        [System.Security.AccessControl.FileSystemRights]::ReadPermissions -bor
        [System.Security.AccessControl.FileSystemRights]::Delete
      $stream = [System.IO.FileStream]::new($temp, [System.IO.FileMode]::CreateNew,
        $rights,
        [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::WriteThrough,
        (PrivateSecurity $false))
      try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        [void](Audit $temp 'file' $true $stream)
        $tempVersion = ExactVersion $stream
        if ($tempVersion.text -cne [string]$inputValue.text) { throw 'recovery_required' }
        $renamed = [CbsFileHandle]::RenameNew($stream.SafeFileHandle, $target)
        if ($renamed -ne 0) {
          try { [CbsFileHandle]::Delete($stream.SafeFileHandle) }
          catch { throw 'recovery_required' }
          if ([System.IO.File]::Exists($target)) { throw 'exists' }
          throw 'security_error'
        }
        $verified = Audit $target 'file' ([bool]$inputValue.privateState) $stream
        $version = ExactVersion $stream
        if ($version.fileId -cne $tempVersion.fileId -or $version.sha256 -cne $tempVersion.sha256) {
          throw 'recovery_required'
        }
        Result $true 'safe' ($verified + @{ sha256 = $version.sha256; fileId = $version.fileId })
      } finally { $stream.Dispose() }
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
        $version = ExactVersion $stream
        Result $true 'safe' ($result + $version)
      } finally { $stream.Dispose() }
      break
    }
    'remove-file' {
      if ($inputValue.expectedSha256 -notmatch '^[a-f0-9]{64}$' -or
          $inputValue.expectedFileId -notmatch '^[a-f0-9]{8}:[a-f0-9]{16}$') { throw 'changed' }
      [void](Audit ([System.IO.Path]::GetDirectoryName($target)) 'directory' ([bool]$inputValue.privateState))
      if ([System.IO.File]::Exists($target + '.cbs-replace-intent')) { throw 'recovery_required' }
      RemoveVersioned $target ([string]$inputValue.expectedSha256) ([string]$inputValue.expectedFileId) ([bool]$inputValue.privateState)
      Result $true 'safe' @{ ownerMatches = $true; localNtfs = $true; noReparse = $true;
        daclSafe = $true; currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
      break
    }
    'trusted-tool' { Result $true 'safe' (AuditTool $target $inputValue.programFiles); break }
    default { throw 'action' }
  }
} catch {
  $code = if ($_.Exception.Message -in @('unsafe_path','volume','reparse','missing','owner','dacl',
      'not_directory','exists','oversize','action','recovery_required','unsafe_tool','changed','ancestor',
      'invalid_text','unsupported_windows_replace')) { $_.Exception.Message } else { 'security_error' }
  Result $false $code
}
}
# One single-line JSON request per stdin line, one single-line JSON result per request.
while ($null -ne ($cbsRequest = [Console]::In.ReadLine())) {
  Invoke-CbsRequest $cbsRequest
  [Console]::Out.Flush()
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

export function parseWindowsSecurityResult(raw, { version = false, text = true } = {}) {
  let result;
  try { result = JSON.parse(raw); } catch { return { ok: false, code: 'invalid_response' }; }
  if (result?.ok !== true || result.code !== 'safe' || result.ownerMatches !== true ||
      result.localNtfs !== true || result.noReparse !== true || result.daclSafe !== true ||
      !/^S-\d+(?:-\d+){2,}$/.test(result.currentSid ?? '')) {
    return { ok: false, code: typeof result?.code === 'string' ? result.code : 'invalid_response' };
  }
  if (version && ((text && typeof result.text !== 'string') || !/^[a-f0-9]{64}$/.test(result.sha256 ?? '') ||
      !/^[a-f0-9]{8}:[a-f0-9]{16}$/.test(result.fileId ?? ''))) {
    return { ok: false, code: 'invalid_response' };
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
    if (['locations', 'acquire', 'release', 'readPrivate', 'fileLock', 'fileUnlock',
      'publishNew', 'rewriteExisting', 'deleteExpected', 'holdPrivate', 'releasePrivate',
      'hashPrivate', 'holdHash']
      .some(name => typeof native[name] !== 'function')) throw new Error('unsafe_windows_native');
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

export const windowsSystemLocations = systemLocations;

async function powershellExe() {
  const { windows } = await systemLocations();
  return path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// The encoded program exceeds the 32,767-char Windows command line (ENAMETOOLONG),
// so argv carries only a bootstrap that reads the program from the first stdin line.
const POWERSHELL_BOOTSTRAP = '$cbsProgram = [Console]::In.ReadLine(); ' +
  '. ([ScriptBlock]::Create([System.Text.Encoding]::UTF8.GetString(' +
  '[System.Convert]::FromBase64String($cbsProgram))))';
const HELPER_REQUEST_TIMEOUT_MS = 7000;
const HELPER_OUTPUT_LIMIT = 2 * 1024 * 1024;

function powershellArgs() {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(POWERSHELL_BOOTSTRAP, 'utf16le').toString('base64')];
}

// One helper per Node process: PowerShell startup plus Add-Type cost ~0.65 s per spawn,
// which made a single outbox enqueue take ~24 s. Requests are serialized over the same
// private pipes; a timeout, oversized output or exit discards the helper for a fresh one.
let helper = null;
let helperTurn = Promise.resolve();

async function startHelper() {
  const command = await powershellExe();
  const { windows } = await systemLocations();
  const child = spawn(command, powershellArgs(), { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    env: { SystemRoot: windows, WINDIR: windows, TEMP: os.tmpdir(), PATH: '' } });
  const state = { child, buffer: '', waiting: null, dead: false };
  const fail = () => {
    state.dead = true;
    if (helper === state) helper = null;
    state.waiting?.(null);
    state.waiting = null;
  };
  child.once('error', fail);
  child.once('close', fail);
  child.stdin.on('error', fail);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    state.buffer += chunk;
    if (state.buffer.length > HELPER_OUTPUT_LIMIT) { child.kill(); return; }
    const end = state.buffer.indexOf('\n');
    if (end < 0 || !state.waiting) return;
    const line = state.buffer.slice(0, end);
    state.buffer = state.buffer.slice(end + 1);
    const deliver = state.waiting;
    state.waiting = null;
    deliver(line);
  });
  child.stdin.write(Buffer.from(WINDOWS_SECURITY_PROGRAM, 'utf8').toString('base64') + '\n');
  return state;
}

function setHelperRef(state, active) {
  for (const handle of [state.child, state.child.stdin, state.child.stdout]) {
    if (active) handle.ref?.(); else handle.unref?.();
  }
}

async function helperRequest(request) {
  if (!helper || helper.dead) helper = await startHelper();
  const state = helper;
  setHelperRef(state, true);
  try {
    return await new Promise(resolve => {
      const timer = setTimeout(() => { state.child.kill(); }, HELPER_REQUEST_TIMEOUT_MS);
      state.waiting = line => { clearTimeout(timer); resolve(line); };
      if (state.dead) { state.waiting(null); return; }
      state.child.stdin.write(request + '\n');
    });
  } finally { if (!state.dead) setHelperRef(state, false); }
}

async function invoke(action, file, extra = {}) {
  if (process.platform !== 'win32') return { ok: false, code: 'native_windows_unproved' };
  windowsPathKey(file);
  const request = JSON.stringify({ action, path: file, ...extra });
  const previous = helperTurn;
  let release;
  helperTurn = new Promise(resolve => { release = resolve; });
  await previous;
  let output;
  try { output = await helperRequest(request); }
  catch { output = null; }
  finally { release(); }
  if (output === null) return { ok: false, code: 'security_helper_failed' };
  if (action === 'trusted-tool') {
    try {
      const result = JSON.parse(output.trim());
      return result?.ok === true && result?.code === 'safe' && result?.trustedTool === true
        ? result : { ok: false, code: result?.code ?? 'invalid_response' };
    } catch { return { ok: false, code: 'invalid_response' }; }
  }
  return parseWindowsSecurityResult(output.trim(), { version: action === 'read-file' || action === 'write-file',
    text: action === 'read-file' });
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

export async function writeWindowsPrivateFile(file, text, { replace = false, privateState = true } = {}) {
  if (replace) return { ok: false, code: 'unsupported_windows_replace' };
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
    return { ok: false, code: 'oversize' };
  }
  return invoke('write-file', file, { text, replace: false, privateState });
}

export async function readWindowsPrivateFile(file, { privateState = true } = {}) {
  return invoke('read-file', file, { privateState });
}

async function checkedWindowsParent(file, privateState = true) {
  windowsPathKey(file);
  const parent = path.win32.dirname(file);
  const result = await inspectWindowsPath(parent, 'directory', { privateState });
  if (!result.ok) throw new Error('unsafe_windows_parent');
  if (windowsPathKey(parent) !== windowsPathKey(await fs.realpath(parent))) {
    throw new Error('unsafe_windows_parent');
  }
}

export async function readWindowsBinary(file, { offset = 0, length = 4 * 1024 * 1024,
  privateState = true } = {}) {
  await checkedWindowsParent(file, privateState);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) ||
      length < 0 || length > 16 * 1024 * 1024) throw new Error('windows_read_args');
  const result = (await nativeWindows()).readPrivate(file, offset, length, privateState);
  if (!Buffer.isBuffer(result.bytes) || !/^[a-f0-9]{8}:[a-f0-9]{16}$/.test(result.fileId) ||
      !Number.isSafeInteger(result.size) || result.size < 0 ||
      !Number.isSafeInteger(result.allocatedBytes) || result.allocatedBytes < 0 ||
      windowsPathKey(file) !== windowsPathKey(await fs.realpath(file))) {
    throw new Error('unsafe_windows_read');
  }
  return result;
}

export async function publishWindowsBinary(file, bytes, onTempFlushed) {
  await checkedWindowsParent(file);
  if (!Buffer.isBuffer(bytes) || bytes.length > 16 * 1024 * 1024 ||
      (onTempFlushed !== undefined && typeof onTempFlushed !== 'function')) {
    throw new Error('windows_publish_args');
  }
  const temporary = path.win32.join(path.win32.dirname(file), `.${randomUUID()}.tmp`);
  const native = await nativeWindows();
  const result = onTempFlushed === undefined
    ? native.publishNew(temporary, file, bytes)
    : native.publishNew(temporary, file, bytes, onTempFlushed);
  const observed = await readWindowsBinary(file, { length: bytes.length });
  if (observed.fileId !== result.fileId || observed.size !== bytes.length ||
      !observed.bytes.equals(bytes)) {
    throw new Error('windows_publish_changed');
  }
  return result;
}

export async function rewriteWindowsBinary(file, fileId, oldBytes, newBytes) {
  await checkedWindowsParent(file);
  if (!Buffer.isBuffer(oldBytes) || !Buffer.isBuffer(newBytes)) throw new Error('windows_rewrite_args');
  return (await nativeWindows()).rewriteExisting(file, fileId, oldBytes, newBytes);
}

export async function deleteWindowsBinary(file, fileId, expectedBytes) {
  await checkedWindowsParent(file);
  if (!Buffer.isBuffer(expectedBytes)) throw new Error('windows_delete_args');
  return (await nativeWindows()).deleteExpected(file, fileId, expectedBytes);
}

export async function holdWindowsPrivate(file, fileId, expectedBytes) {
  await checkedWindowsParent(file);
  if (!Buffer.isBuffer(expectedBytes)) throw new Error('windows_hold_args');
  const native = await nativeWindows();
  const lease = native.holdPrivate(file, fileId, expectedBytes);
  return () => native.releasePrivate(lease);
}

export async function hashWindowsFile(file, { privateState = true } = {}) {
  await checkedWindowsParent(file, privateState);
  const result = (await nativeWindows()).hashPrivate(file, privateState);
  if (!/^[a-f0-9]{64}$/.test(result.sha256) ||
      windowsPathKey(file) !== windowsPathKey(await fs.realpath(file))) {
    throw new Error('unsafe_windows_hash');
  }
  return result;
}

export async function holdWindowsHash(file, fileId, sha256, { privateState = true } = {}) {
  await checkedWindowsParent(file, privateState);
  const native = await nativeWindows();
  const lease = native.holdHash(file, fileId, sha256, privateState);
  return () => native.releasePrivate(lease);
}

const windowsFileQueues = new Map();
export async function withWindowsLockQueue(file, callback, timeoutMs = 200) {
  if (typeof callback !== 'function') throw new Error('windows_file_lock_args');
  const key = windowsPathKey(file);
  const previous = windowsFileQueues.get(key) ?? Promise.resolve();
  let done;
  const pending = new Promise(resolve => { done = resolve; });
  const turn = previous.then(() => pending);
  windowsFileQueues.set(key, turn);
  const deadline = Date.now() + timeoutMs;
  let timer;
  let entered = false;
  try {
    await Promise.race([previous, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('windows_file_lock_busy')),
        Math.max(0, deadline - Date.now()));
    })]);
    if (Date.now() >= deadline) throw new Error('windows_file_lock_busy');
    entered = true;
    return await callback(deadline);
  } finally {
    clearTimeout(timer);
    if (entered) done();
    else previous.then(done);
    turn.then(() => {
      if (windowsFileQueues.get(key) === turn) windowsFileQueues.delete(key);
    });
  }
}

// Each operation under the lock spawns the PowerShell security helper (~0.65 s measured on
// Windows 11), so the Linux-sized 200 ms budget expired before the first acquisition attempt.
export const WINDOWS_FILE_LOCK_TIMEOUT_MS = 10000;

export async function withWindowsFileLock(file, callback,
  { timeoutMs = WINDOWS_FILE_LOCK_TIMEOUT_MS } = {}) {
  if (typeof callback !== 'function') throw new Error('windows_file_lock_args');
  return withWindowsLockQueue(file, async () => {
    // Parent validation is not contention: the acquisition budget starts after it.
    await checkedWindowsParent(file);
    const native = await nativeWindows();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() >= deadline) throw new Error('windows_file_lock_busy');
      let held;
      try { held = native.fileLock(file); }
      catch (error) {
        if (error.message !== 'windows_file_lock_busy') throw error;
        if (Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
        continue;
      }
      try { return await callback({ fileId: held.fileId }); }
      finally { native.fileUnlock(held.lease); }
    }
  }, timeoutMs);
}

export function windowsCodexPluginInstalled(output) {
  return typeof output === 'string' && output.split(/\r?\n/).some(line => {
    const fields = line.trim().split(/\s+/);
    return fields.includes('claude-mem@claude-mem-local') &&
      fields.some(field => field.toLowerCase() === 'installed') &&
      !fields.some(field => /workspace[.-]managed/i.test(field));
  });
}

export async function removeWindowsPrivateFile(file, expectedVersion, { privateState = true } = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedVersion?.sha256 ?? '') ||
      !/^[a-f0-9]{8}:[a-f0-9]{16}$/.test(expectedVersion?.fileId ?? '')) {
    return { ok: false, code: 'changed' };
  }
  return invoke('remove-file', file, { expectedSha256: expectedVersion.sha256,
    expectedFileId: expectedVersion.fileId, privateState });
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
