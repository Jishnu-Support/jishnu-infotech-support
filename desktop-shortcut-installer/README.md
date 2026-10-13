# Jishnu Infotech Support desktop shortcut installer

`JishnuSupportDesktopInstaller.exe` creates **Jishnu Infotech Support** on the current Windows user's Desktop, using the supplied company logo for the installer and shortcut icon. Double-clicking the shortcut opens `https://jitsupport.jishnuinfotech.com` in the user's default browser. It does not require administrator access.

## Install

1. Download `JishnuSupportDesktopInstaller.exe` to the user's Windows computer.
2. Double-click the EXE and wait for the success message.
3. Double-click **Jishnu Infotech Support** on the Desktop to open the portal login page.

The installer creates or replaces that desktop shortcut and stores the shortcut icon in `%LOCALAPPDATA%\Jishnu Infotech Support` so it remains available after the installer is removed. It does not install a browser add-on or collect user data. The portal URL is set in `Installer.cs`.
