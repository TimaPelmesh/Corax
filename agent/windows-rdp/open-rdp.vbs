Option Explicit
Dim spec, host, sh, i, ch, decoded, ok
If WScript.Arguments.Count < 1 Then WScript.Quit 1
spec = Trim(WScript.Arguments(0))
If Len(spec) >= 2 Then
  If Left(spec, 1) = Chr(34) And Right(spec, 1) = Chr(34) Then spec = Mid(spec, 2, Len(spec) - 2)
End If
If LCase(Left(spec, 10)) = "corax-rdp:" Then spec = Mid(spec, 11)
Do While Left(spec, 1) = "/"
  spec = Mid(spec, 2)
Loop
If Right(spec, 1) = "/" Then spec = Left(spec, Len(spec) - 1)

decoded = ""
i = 1
Do While i <= Len(spec)
  ch = Mid(spec, i, 1)
  If ch = "%" And i + 2 <= Len(spec) Then
    On Error Resume Next
    decoded = decoded & Chr(CLng("&H" & Mid(spec, i + 1, 2)))
    If Err.Number <> 0 Then
      Err.Clear
      decoded = decoded & ch
      i = i + 1
    Else
      i = i + 3
    End If
    On Error GoTo 0
  Else
    decoded = decoded & ch
    i = i + 1
  End If
Loop

host = Trim(decoded)
If host = "" Or Len(host) > 255 Then WScript.Quit 1
If InStr(host, "..") > 0 Then WScript.Quit 1
ok = True
For i = 1 To Len(host)
  ch = Mid(host, i, 1)
  If InStr("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-", ch) = 0 Then ok = False
Next
If Not ok Then WScript.Quit 1
ch = Left(host, 1)
If InStr("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", ch) = 0 Then WScript.Quit 1
ch = Right(host, 1)
If InStr("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", ch) = 0 Then WScript.Quit 1

Set sh = CreateObject("WScript.Shell")
sh.Run "mstsc.exe /v:" & host, 1, False
