param(
  [string]$Out
)

# 读取 Windows 10 SMTC（全局媒体会话）。SMTC 拿不到时退回前台窗口标题。
# 结果以 UTF-8(无 BOM) JSON 写入 $Out，避免控制台代码页导致的中文乱码。
$ErrorActionPreference = 'Stop'
$result = [ordered]@{ ok = $true; at = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); source = ''; error = ''; sessions = @() }

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]

$script:asTaskOp = @([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and
                 $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($op, $resultType) {
  if ($null -eq $op) { return $null }
  $task = $script:asTaskOp.MakeGenericMethod($resultType).Invoke($null, [object[]]@($op))
  $null = $task.Wait(9000)
  if ($task.IsFaulted) { return $null }
  return $task.Result
}

try {
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
              ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

  if ($null -ne $mgr) {
    $result.source = 'smtc'
    foreach ($s in @($mgr.GetSessions())) {
      $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $play = $s.PlaybackSession
      $state = if ($null -ne $play) { "$($play.PlaybackState)" } else { 'Unknown' }
      $appId = "$($s.SourceApplicationUserModelId.AppUserId)"
      $app = "$($s.SourceApplicationDisplayInfo.DisplayName)"
      if ($app -eq '') { $app = ($appId -split '!')[0] }
      $result.sessions += [ordered]@{
        id       = $appId
        app      = $app
        title    = if ($props) { "$($props.Title)" } else { '' }
        artist   = if ($props) { "$($props.Artist)" } else { '' }
        album    = if ($props) { "$($props.AlbumTitle)" } else { '' }
        state    = $state
        playing  = ($state -eq 'Playing')
        paused   = ($state -eq 'Paused')
        stopped  = ($state -eq 'Stopped')
        duration = if ($null -ne $play) { [int64]$play.NaturalDuration.DurationMilliseconds } else { $null }
        position = if ($null -ne $play) { [int64]$play.Position.DurationMilliseconds } else { $null }
      }
    }
  }
}
catch {
  $result.error = $_.Exception.Message
}

if ($result.source -ne 'smtc') {
  # 退回方案：前台窗口标题（播放器/浏览器通常把曲目写进标题）
  try {
    $ErrorActionPreference = 'Stop'
    Add-Type -Namespace NSNoSense -Name FG -MemberDefinition @'
      [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
      [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
      [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
'@
    $hwnd = [NSNoSense.FG]::GetForegroundWindow()
    $winPid = 0
    $null = [NSNoSense.FG]::GetWindowThreadProcessId($hwnd, [ref]$winPid)
    $sb = New-Object System.Text.StringBuilder 512
    $null = [NSNoSense.FG]::GetWindowTextW($hwnd, $sb, $sb.Capacity)
    $proc = Get-Process -Id $winPid -ErrorAction SilentlyContinue
    $result.source = 'foreground'
    $result.sessions = @([ordered]@{
      id = 'fg:' + $proc.ProcessName; app = $proc.ProcessName; title = $sb.ToString()
      artist = ''; album = ''; state = 'Playing'; playing = $true; paused = $false; stopped = $false
      duration = $null; position = $null
    })
  }
  catch {
    $result.ok = $false
    $result.error = $_.Exception.Message
  }
}

$json = $result | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
