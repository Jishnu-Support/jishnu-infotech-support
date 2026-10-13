using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal static class Installer
{
    private const string PortalUrl = "https://jitsupport.jishnuinfotech.com";

    [STAThread]
    private static void Main()
    {
        object shell = null;
        object shortcut = null;

        try
        {
            var shellType = Type.GetTypeFromProgID("WScript.Shell", true);
            shell = Activator.CreateInstance(shellType);

            var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            var shortcutPath = Path.Combine(desktop, "Jishnu Infotech Support.lnk");
            var systemDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System);
            var browserLauncher = Path.Combine(systemDirectory, "rundll32.exe");

            shortcut = shellType.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod,
                null, shell, new object[] { shortcutPath });
            var shortcutType = shortcut.GetType();
            shortcutType.InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty,
                null, shortcut, new object[] { browserLauncher });
            shortcutType.InvokeMember("Arguments", System.Reflection.BindingFlags.SetProperty,
                null, shortcut, new object[] { "url.dll,FileProtocolHandler \"" + PortalUrl + "\"" });
            shortcutType.InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty,
                null, shortcut, new object[] { systemDirectory });
            shortcutType.InvokeMember("Description", System.Reflection.BindingFlags.SetProperty,
                null, shortcut, new object[] { "Open the Jishnu Infotech Support Portal" });
            shortcutType.InvokeMember("IconLocation", System.Reflection.BindingFlags.SetProperty,
                null, shortcut, new object[] { Path.Combine(systemDirectory, "shell32.dll") + ",220" });
            shortcutType.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod,
                null, shortcut, null);

            MessageBox.Show(
                "The Jishnu Infotech Support shortcut has been added to your Desktop.\n\nDouble-click it to open the portal in your default browser.",
                "Jishnu Infotech Support installed",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "The desktop shortcut could not be created.\n\n" + error.Message,
                "Jishnu Infotech Support installer",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Environment.ExitCode = 1;
        }
        finally
        {
            if (shortcut != null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
            if (shell != null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
        }
    }
}
