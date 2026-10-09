param(
  [string]$ReportPath = (Join-Path $env:TEMP ('cbs-memoria-windows-' + [guid]::NewGuid().ToString('N') + '.json')),
  [string]$ClaudeExecutable,
  [string]$ClaudeSha256,
  [string]$CodexExecutable,
  [string]$CodexSha256,
  [string]$PythonExecutable,
  [string]$PythonSha256,
  [string]$QdrantUrl,
  [string]$QdrantCollection,
  [string]$QdrantKeyEnv,
  [string]$ModelPath,
  [string]$TokenizerPath,
  [string]$ClaudeMemPluginSource,
  [string]$ClaudeMemPluginTreeSha256,
  [string]$ClaudeMemMarketplaceSource,
  [string]$ClaudeMemMarketplaceTreeSha256,
  [switch]$RunInteractiveCli,
  [switch]$RunExtraction,
  [switch]$RunReview,
  [switch]$RunRuntime,
  [switch]$RunCrashRemote
)

$ErrorActionPreference = 'Stop'
$reportFull = [System.IO.Path]::GetFullPath($ReportPath)
if (Test-Path -LiteralPath $reportFull) { throw 'ReportPath must be a new file' }
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw 'Native Windows/NTFS is required; this script never reports Linux or Wine as Windows PASS'
}
if ([IntPtr]::Size -ne 8) { throw 'Windows x64 is required' }

foreach ($pair in @(
  @($ClaudeExecutable, $ClaudeSha256), @($CodexExecutable, $CodexSha256),
  @($PythonExecutable, $PythonSha256)
)) {
  if (([bool]$pair[0]) -ne ([bool]$pair[1])) { throw 'Each executable requires its explicit SHA-256' }
  if ($pair[1] -and $pair[1] -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid SHA-256' }
  if ($pair[0] -and (![System.IO.Path]::IsPathRooted($pair[0]) -or
      !$pair[0].EndsWith('.exe', [System.StringComparison]::OrdinalIgnoreCase))) {
    throw 'Executables must be absolute .exe paths'
  }
}
if (($ModelPath -and !$TokenizerPath) -or ($TokenizerPath -and !$ModelPath)) {
  throw 'Model and tokenizer must be supplied together'
}
if ($QdrantKeyEnv -and $QdrantKeyEnv -notmatch '^[A-Z][A-Z0-9_]*$') {
  throw 'Invalid Qdrant key environment variable name'
}
if (($ClaudeMemPluginSource -and !$ClaudeMemPluginTreeSha256) -or
    ($ClaudeMemPluginTreeSha256 -and !$ClaudeMemPluginSource)) {
  throw 'Plugin source and tree SHA-256 must be supplied together'
}
if ($ClaudeMemPluginTreeSha256 -and $ClaudeMemPluginTreeSha256 -notmatch '^[a-fA-F0-9]{64}$') {
  throw 'Invalid plugin tree SHA-256'
}
if (($ClaudeMemMarketplaceSource -and !$ClaudeMemMarketplaceTreeSha256) -or
    ($ClaudeMemMarketplaceTreeSha256 -and !$ClaudeMemMarketplaceSource)) {
  throw 'Marketplace source and tree SHA-256 must be supplied together'
}
if ($ClaudeMemMarketplaceTreeSha256 -and
    $ClaudeMemMarketplaceTreeSha256 -notmatch '^[a-fA-F0-9]{64}$') {
  throw 'Invalid marketplace tree SHA-256'
}
foreach ($source in @($ClaudeMemPluginSource, $ClaudeMemMarketplaceSource)) {
  if ($source -and ![System.IO.Path]::IsPathRooted($source)) {
    throw 'Plugin and marketplace sources must be absolute paths'
  }
}
if ($RunCrashRemote) {
  $confirmation = Read-Host 'Private Qdrant fixture: type APPROVE FIXTURE FACT to permit the synthetic sourced remote-add crash control'
  if ($confirmation -cne 'APPROVE FIXTURE FACT') { throw 'Synthetic fixture source was not approved' }
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot 'memoria-windows-native-fixture.mjs'
if (!(Test-Path -LiteralPath $script)) { throw 'Fixture implementation is missing' }
$claudeHash = if ($ClaudeSha256) { $ClaudeSha256.ToLowerInvariant() } else { '' }
$codexHash = if ($CodexSha256) { $CodexSha256.ToLowerInvariant() } else { '' }
$pythonHash = if ($PythonSha256) { $PythonSha256.ToLowerInvariant() } else { '' }
$pluginHash = if ($ClaudeMemPluginTreeSha256) { $ClaudeMemPluginTreeSha256.ToLowerInvariant() } else { '' }
$marketplaceHash = if ($ClaudeMemMarketplaceTreeSha256) { $ClaudeMemMarketplaceTreeSha256.ToLowerInvariant() } else { '' }
$config = @{
  tools = @{
    claude = @{ executable = $ClaudeExecutable; sha256 = $claudeHash }
    codex = @{ executable = $CodexExecutable; sha256 = $codexHash }
    python = @{ executable = $PythonExecutable; sha256 = $pythonHash }
  }
  destination = @{ url = $QdrantUrl; collection = $QdrantCollection; apiKeyEnv = $QdrantKeyEnv }
  runtime = @{ model = $ModelPath; tokenizer = $TokenizerPath }
  plugin = @{ source = $ClaudeMemPluginSource; treeSha256 = $pluginHash;
    marketplaceSource = $ClaudeMemMarketplaceSource;
    marketplaceTreeSha256 = $marketplaceHash }
  runInteractiveCli = [bool]$RunInteractiveCli
  runExtraction = [bool]$RunExtraction
  runReview = [bool]$RunReview
  runRuntime = [bool]$RunRuntime
  runCrashRemote = [bool]$RunCrashRemote
}
$previous = [System.Environment]::GetEnvironmentVariable('CBS_WINDOWS_FIXTURE_CONFIG_JSON', 'Process')
try {
  [System.Environment]::SetEnvironmentVariable('CBS_WINDOWS_FIXTURE_CONFIG_JSON',
    ($config | ConvertTo-Json -Depth 8 -Compress), 'Process')
  & $node $script $reportFull
  if ($LASTEXITCODE -ne 0) { throw "Fixture process failed with exit code $LASTEXITCODE" }
} finally {
  [System.Environment]::SetEnvironmentVariable('CBS_WINDOWS_FIXTURE_CONFIG_JSON', $previous, 'Process')
}
