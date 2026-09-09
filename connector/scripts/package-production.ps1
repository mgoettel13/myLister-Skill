param([Parameter(Mandatory = $true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$source = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../plugins/mylister-production'))
$manifest = Get-Content -LiteralPath (Join-Path $source '.codex-plugin/plugin.json') -Raw | ConvertFrom-Json
if ($manifest.name -ne 'mylister-production' -or $manifest.version -notmatch '^[a-zA-Z0-9.+-]+$') {
    throw 'Unexpected production manifest'
}
$mcp = Get-Content -LiteralPath (Join-Path $source '.mcp.json') -Raw | ConvertFrom-Json
if ($mcp.mcpServers.'mylister-production'.url -ne 'https://mcp.mylister.dev/mcp') {
    throw 'Production endpoint mismatch'
}
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($output) | Out-Null
$bundles = @(
    @{ Name = "mylister-production-$($manifest.version).zip"; Files = @('.codex-plugin/plugin.json', '.mcp.json', 'assets/logo.png', 'skills/mylister/SKILL.md'); Prefix = '' },
    @{ Name = "mylister-skills-$($manifest.version).zip"; Files = @('skills/mylister/SKILL.md'); Prefix = 'skills/' }
)
foreach ($bundle in $bundles) {
    $destination = Join-Path $output $bundle.Name
    if (Test-Path -LiteralPath $destination) { throw "Refusing to overwrite $destination" }
    $zip = [System.IO.Compression.ZipFile]::Open($destination, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in $bundle.Files) {
            $entryName = $file.Substring($bundle.Prefix.Length)
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $source $file), $entryName) | Out-Null
        }
    } finally { $zip.Dispose() }
    $zip = [System.IO.Compression.ZipFile]::OpenRead($destination)
    try {
        if ($zip.Entries.Count -ne $bundle.Files.Count) { throw 'Unexpected archive contents' }
        foreach ($file in $bundle.Files) {
            $entry = $zip.GetEntry($file.Substring($bundle.Prefix.Length))
            if ($null -eq $entry) { throw "Missing archive entry: $file" }
            $stream = $entry.Open()
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try { $hash = [Convert]::ToHexString($sha.ComputeHash($stream)) }
            finally { $stream.Dispose(); $sha.Dispose() }
            if ($hash -ne (Get-FileHash -LiteralPath (Join-Path $source $file) -Algorithm SHA256).Hash) {
                throw "Archive byte mismatch: $file"
            }
        }
    } finally { $zip.Dispose() }
    Get-FileHash -LiteralPath $destination -Algorithm SHA256 | Select-Object Path, Hash
}
