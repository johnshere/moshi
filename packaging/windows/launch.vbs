' moshi silent launcher (V-03). Runs moshi.cmd with the given verb without a console.
' Kept ASCII-only: WSH decodes UTF-8 scripts without BOM as ANSI.
Option Explicit
Dim fso, sh, dir, verb, args, cmd, i
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
verb = "init"
If WScript.Arguments.Count > 0 Then verb = WScript.Arguments(0)
args = ""
For i = 1 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next
cmd = """" & dir & "\moshi.cmd"" " & verb & args
sh.Run cmd, 0, False
