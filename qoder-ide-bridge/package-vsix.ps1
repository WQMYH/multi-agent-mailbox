param([string]$OutputPath = (Join-Path $PSScriptRoot 'dist\qoder-ide-command-bridge-0.2.0.vsix'))

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("qoder-ide-vsix-" + [guid]::NewGuid().ToString('N'))
$resolvedTemp = [IO.Path]::GetFullPath($temporaryRoot)
$allowedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $resolvedTemp.StartsWith($allowedTemp, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe temporary path' }

try {
  New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
  $output = [IO.Path]::GetFullPath($OutputPath)
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($output)) | Out-Null
  if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output }
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $stream = [IO.File]::Open($output, [IO.FileMode]::CreateNew)
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
  try {
    $extensionRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'extension'))
    foreach ($file in Get-ChildItem -File -Recurse -LiteralPath $extensionRoot) {
      $relative = $file.FullName.Substring($extensionRoot.Length).TrimStart('\').Replace('\', '/')
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, "extension/$relative") | Out-Null
    }
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,
      (Join-Path $PSScriptRoot 'extension.vsixmanifest'), 'extension.vsixmanifest') | Out-Null
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,
      (Join-Path $PSScriptRoot '[Content_Types].xml'), '[Content_Types].xml') | Out-Null
  } finally {
    $archive.Dispose()
    $stream.Dispose()
  }
  $output
} finally {
  if (Test-Path -LiteralPath $resolvedTemp) { Remove-Item -Recurse -Force -LiteralPath $resolvedTemp }
}
