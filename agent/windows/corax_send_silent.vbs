' Hidden launcher: Task Scheduler and double-click. WindowStyle 0 = no console.
' Sets CORAX_HIDDEN so corax_send.bat does not re-launch this script.
' Desktop shortcut «Оставить заявку» is still created by the PowerShell client.
Option Explicit
Dim sh, fso, here, bat
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
bat = here & "\corax_send.bat"
If Not fso.FileExists(bat) Then
  WScript.Quit 2
End If
sh.CurrentDirectory = here
sh.Environment("Process")("CORAX_HIDDEN") = "1"
Dim code
code = sh.Run("""" & bat & """ nopause hidden", 0, True)
WScript.Quit code
