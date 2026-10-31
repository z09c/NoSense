param(
  [string]$Out,
  [string]$Source = ''
)

# Windows 通知中心数据库被 WpnSystemService 独占，普通复制会失败。
# 这里用 FileShareReadWrite 打开原始文件流并复制一份到临时位置，
# 再由 Node 的 node:sqlite 以只读方式解析（不写回，绝不破坏系统通知库）。
$ErrorActionPreference = 'Stop'
$result = [ordered]@{ ok = $true; at = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); error = ''; files = @() }

if ($Source -eq '') {
  $Source = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Notifications\wpndatabase.db'
}

try {
  $base = [System.IO.Path]::GetFileNameWithoutExtension($Out)
  foreach ($suffix in @('', '-wal', '-shm')) {
    $src = $Source + $suffix
    if (-not (Test-Path -LiteralPath $src)) { continue }
    $fsIn = [System.IO.File]::Open($src, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read,
             [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
    $dst = $Out + $suffix
    $fsOut = [System.IO.File]::Create($dst)
    $fsIn.CopyTo($fsOut)
    $fsOut.Close(); $fsOut = $null
    $fsIn.Close(); $fsIn = $null
    $result.files += [ordered]@{ path = $dst; size = (Get-Item -LiteralPath $dst).Length }
  }
  if ($result.files.Count -eq 0) { $result.ok = $false; $result.error = 'not found: ' + $Source }
}
catch {
  $result.ok = $false
  $result.error = $_.Exception.Message
}

$json = $result | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText($Out + '.meta', $json, (New-Object System.Text.UTF8Encoding($false)))
