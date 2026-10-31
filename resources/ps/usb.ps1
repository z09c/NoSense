param([string]$Out)

$ErrorActionPreference = 'Stop'
$now = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')

function Compact($obj) {
  $list = @()
  foreach ($p in $obj) { if ($null -ne $p) { $list += [pscustomobject]$p } }
  return $list
}

$result = [ordered]@{ ok = $true; at = $now; error = ''; usb = @(); drives = @() }
try {
  $usb = @(Get-CimInstance -ClassName Win32_DiskDrive -Filter "InterfaceType='USB'" -ErrorAction SilentlyContinue |
    ForEach-Object { [ordered]@{ id = "disk:$($_.DeviceID)"; name = $_.Caption; size = $_.Size } })

  $vols = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType=2" -ErrorAction SilentlyContinue |
    ForEach-Object { [ordered]@{ id = "vol:$($_.DeviceID)"; name = ("$($_.DeviceID) " + $_.VolumeName); free = $_.FreeSpace; size = $_.Size } })

  # 非存储类 USB 设备（键鼠/耳机/摄像头等）只做数量与新增指纹统计
  $others = @(Get-CimInstance -ClassName Win32_PnPEntity -Filter "PNPClass='USB'" -ErrorAction SilentlyContinue |
    Where-Object { $_.Status -eq 'OK' } |
    ForEach-Object { [ordered]@{ id = "pnp:$($_.DeviceID)"; name = $_.Name } })

  $result.usb = Compact ($usb + $others)
  $result.drives = Compact $vols
}
catch {
  $result.ok = $false
  $result.error = $_.Exception.Message
}

$json = $result | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
