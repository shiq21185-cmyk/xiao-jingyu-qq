' 用 wscript 起一个后台进程：0 = 窗口完全隐藏，不进任务栏。
'
' 为什么要绕过一层 VBS：cmd /c 或 Start-Process -WindowStyle Hidden 起
' 控制台程序（node.exe 就是）时，窗口多半还是会闪一下，而且有些情况下
' 仍然会在任务栏留一个条目。wscript 的 Run(..., 0, ...) 是唯一
' "连闪都不闪、连图标都不出现" 的标准做法。
'
' 参数：<工作目录> <可执行文件> <脚本路径>
' 三个都要，缺一个就什么也不做（宁可不起，也不要起错地方）。

If WScript.Arguments.Count < 3 Then
    WScript.Quit 2
End If

Dim workDir, exePath, scriptPath
workDir = WScript.Arguments(0)
exePath = WScript.Arguments(1)
scriptPath = WScript.Arguments(2)

Dim sh
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = workDir

' 0 = 隐藏窗口，False = 不等待它结束（wscript 自己立刻退出）
sh.Run """" & exePath & """ """ & scriptPath & """", 0, False
