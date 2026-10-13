$ErrorActionPreference = "Stop"

$portalUrl = "https://jitsupport.jishnuinfotech.com"
$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "Jishnu Infotech Support.lnk"
$rundll32Path = Join-Path $env:WINDIR "System32\rundll32.exe"

if (-not (Test-Path -LiteralPath $rundll32Path)) {
  throw "Windows could not find the default browser launcher."
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $rundll32Path
$shortcut.Arguments = "url.dll,FileProtocolHandler `"$portalUrl`""
$shortcut.Description = "Open the Jishnu Infotech Support Portal"
$shortcut.IconLocation = "$env:WINDIR\System32\shell32.dll,220"
$shortcut.Save()

Write-Host "Desktop shortcut installed: $shortcutPath" -ForegroundColor Green
Write-Host "Double-click Jishnu Infotech Support to open the portal login page."
