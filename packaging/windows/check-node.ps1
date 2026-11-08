param()
# Prints one line: "OK <version>", "OLD <version>" or "MISSING".
# ASCII only: Windows PowerShell 5.1 decodes UTF-8 without BOM as ANSI.
$ErrorActionPreference = 'SilentlyContinue'
$raw = $null
try { $raw = (node --version) } catch { }
if ([string]::IsNullOrWhiteSpace($raw)) {
  Write-Output 'MISSING'
  exit 0
}
$text = $raw.Trim()
$version = $text.TrimStart('v')
$ok = $false
try { $ok = ([version]$version -ge [version]'22.18.0') } catch { $ok = $false }
if ($ok) { Write-Output ("OK " + $version) } else { Write-Output ("OLD " + $version) }
exit 0
