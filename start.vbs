Set WshShell = CreateObject("WScript.Shell")
strFolder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WshShell.Run "cmd /c cd /d """ & strFolder & """ && node app.js", 0, False
WScript.Sleep 2500
WshShell.Run "http://localhost:3000", 0, False
