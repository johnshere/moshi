; 默识（moshi）Windows 安装器（V-03）。
;
; 设计口径（用户 2026-11-08 拍板）：安装包只带默识自己的程序，不带 Node.js /
; Python / 模型权重；依赖在安装阶段按需下载（Node.js），Python 组件安装后可选。
; 默认按当前用户安装到 %LOCALAPPDATA%\Programs\moshi，不需要管理员权限。
;
; 构建入口：node scripts/build-installer.mjs（传入 APP_VERSION / NODE_VERSION /
; STAGE_DIR / PACKAGING_DIR / OUT_FILE）。

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif
!ifndef APP_VERSION4
  !define APP_VERSION4 "0.0.0.0"
!endif
!ifndef NODE_VERSION
  !define NODE_VERSION "22.19.0"
!endif
!ifndef MIN_NODE
  !define MIN_NODE "22.18.0"
!endif
!ifndef STAGE_DIR
  !error "缺少 STAGE_DIR"
!endif
!ifndef PACKAGING_DIR
  !error "缺少 PACKAGING_DIR"
!endif
!ifndef OUT_FILE
  !error "缺少 OUT_FILE"
!endif

Name "默识（moshi）"
Caption "默识 ${APP_VERSION} 安装"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\moshi"
InstallDirRegKey HKCU "Software\moshi" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 32
BrandingText "默识 · 本机记忆"

VIProductVersion "${APP_VERSION4}"
VIAddVersionKey "ProductName" "默识（moshi）"
VIAddVersionKey "FileDescription" "默识安装程序"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"

Var DownloadNode
Var AutoStart
Var NodeStatus
Var NodeNeeded
Var InstallPython
Var hNodeCheck
Var hAutoStart
Var hPython

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "安装默识（moshi）"
!define MUI_WELCOMEPAGE_TEXT "默识是本机环境状态的客户端记忆系统。$\r$\n$\r$\n安装包只包含默识自身的程序；运行所需的 Node.js 由本机提供，缺失时可在安装阶段下载。Python 组件（向量召回与图神经网络）是可选项，安装完成后可随时安装。"
!define MUI_FINISHPAGE_RUN "$SYSDIR\wscript.exe"
!define MUI_FINISHPAGE_RUN_FUNCTION RunMoshi
!define MUI_FINISHPAGE_RUN_TEXT "立即运行默识（打开浏览器界面）"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom DependenciesPageShow DependenciesPageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  SetShellVarContext current
  StrCpy $DownloadNode "auto"
  StrCpy $AutoStart "1"
  StrCpy $NodeNeeded "0"
  StrCpy $InstallPython "0"
  ; 静默安装可用 /PYTHON=1 指定安装 Python 组件（约 500MB，默认不装）
  ${GetOptions} $CMDLINE "/PYTHON=" $0
  ${If} $0 == "1"
    StrCpy $InstallPython "1"
  ${EndIf}
  InitPluginsDir
  File /oname=$PLUGINSDIR\check-node.ps1 "${PACKAGING_DIR}\check-node.ps1"
FunctionEnd

Function RunMoshi
  Exec '"$SYSDIR\wscript.exe" //nologo "$INSTDIR\launch.vbs" init'
FunctionEnd

; 调 check-node.ps1，结果写 $NodeStatus（OK <ver> / OLD <ver> / MISSING）
Function CheckNode
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\check-node.ps1"'
  Pop $0
  Pop $NodeStatus
  ${If} $0 != "0"
    StrCpy $NodeStatus "MISSING"
  ${EndIf}
FunctionEnd

Function DependenciesPageShow
  !insertmacro MUI_HEADER_TEXT "依赖组件" "默识运行需要 Node.js ${MIN_NODE} 或更高版本"

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 32u "安装包只包含默识自身的程序文件。运行所需的 Node.js 由本机提供；本机没有可用版本时，可在安装阶段下载官方运行时（约 30MB）。"
  Pop $0

  Call CheckNode
  StrCpy $1 $NodeStatus 2
  ${If} $1 == "OK"
    StrCpy $NodeNeeded "0"
    ${NSD_CreateLabel} 0 38u 100% 18u "Node.js 运行时：已检测到可用版本（$NodeStatus）"
    Pop $0
    ${NSD_CreateCheckBox} 0 58u 100% 12u "本机已满足，无需下载"
    Pop $hNodeCheck
    ${NSD_Uncheck} $hNodeCheck
    EnableWindow $hNodeCheck 0
  ${Else}
    StrCpy $NodeNeeded "1"
    ${NSD_CreateLabel} 0 38u 100% 18u "Node.js 运行时：未检测到可用版本（需要 ${MIN_NODE}+）"
    Pop $0
    ${NSD_CreateCheckBox} 0 58u 100% 12u "安装阶段下载并安装 Node.js ${NODE_VERSION}（官方源，约 30MB）"
    Pop $hNodeCheck
    ${NSD_Check} $hNodeCheck
  ${EndIf}

  ${NSD_CreateLabel} 0 78u 100% 16u "Python 组件（向量召回与图神经网络，可选）：不勾选时默识仍可完整使用（纯符号模式）。"
  Pop $0
  ${NSD_CreateCheckBox} 0 94u 100% 18u "安装 Python 组件（下载 Python/依赖/模型，约 500MB，需联网；耗时数分钟）"
  Pop $hPython
  ${If} $InstallPython == "1"
    ${NSD_Check} $hPython
  ${EndIf}

  ${NSD_CreateCheckBox} 0 118u 100% 12u "开机自动启动默识（推荐）"
  Pop $hAutoStart
  ${If} $AutoStart == "1"
    ${NSD_Check} $hAutoStart
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function DependenciesPageLeave
  ${If} $NodeNeeded == "1"
    ${NSD_GetState} $hNodeCheck $0
    StrCpy $DownloadNode "$0"
  ${Else}
    StrCpy $DownloadNode "0"
  ${EndIf}
  ${NSD_GetState} $hAutoStart $0
  StrCpy $AutoStart "$0"
  ${NSD_GetState} $hPython $0
  StrCpy $InstallPython "$0"
FunctionEnd

Section "默识主程序" SEC_APP
  SectionIn RO
  ; 覆盖安装/升级前先停掉正在运行的 daemon，否则 .node 与数据库文件被锁
  IfFileExists "$INSTDIR\tools\stop-moshi.ps1" 0 no_previous_install
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\tools\stop-moshi.ps1"'
  Pop $0
  no_previous_install:

  SetOutPath "$INSTDIR"
  File /r "${STAGE_DIR}\*.*"

  CreateDirectory "$SMPROGRAMS\默识"
  CreateShortCut "$SMPROGRAMS\默识\默识.lnk" "$SYSDIR\wscript.exe" '//nologo "$INSTDIR\launch.vbs" init' "$INSTDIR\moshi.cmd" 0

  WriteRegStr HKCU "Software\moshi" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ${If} $AutoStart == "1"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "moshi" '"$SYSDIR\wscript.exe" //nologo "$INSTDIR\launch.vbs" daemon'
  ${Else}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "moshi"
  ${EndIf}
SectionEnd

Section "运行环境（Node.js）" SEC_DEPS
  ${If} $DownloadNode != "0"
    ; 静默安装不会走依赖页；这里重新探测一次再决定是否下载
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\tools\check-node.ps1"'
    Pop $0
    Pop $1
    StrCpy $1 $1 2
    ${If} $1 != "OK"
      DetailPrint "正在下载 Node.js ${NODE_VERSION}（约 30MB）…"
      nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\tools\install-node.ps1" -Version "${NODE_VERSION}"'
      Pop $0
      ${If} $0 != "0"
        MessageBox MB_ICONEXCLAMATION "Node.js 安装未完成（退出码 $0）。默识已安装，但需要 Node.js ${MIN_NODE}+ 才能运行；可重新运行安装包重试。"
      ${Else}
        DetailPrint "Node.js ${NODE_VERSION} 已安装到 %LOCALAPPDATA%\moshi\node"
      ${EndIf}
    ${Else}
      DetailPrint "已检测到可用的 Node.js，跳过下载"
    ${EndIf}
  ${Else}
    DetailPrint "按用户选择跳过 Node.js 下载"
  ${EndIf}
SectionEnd

Section "Python 组件（可选）" SEC_PYTHON
  ${If} $InstallPython == "1"
    DetailPrint "正在安装 Python 组件（下载解释器/依赖/模型，约 500MB，可能需要数分钟）…"
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\tools\install-python.ps1" -VenvDir "$INSTDIR\sidecar\.venv" -SidecarDir "$INSTDIR\sidecar"'
    Pop $0
    ${If} $0 != "0"
      MessageBox MB_ICONEXCLAMATION "Python 组件安装未完成（退出码 $0）。默识主程序已安装，仍可纯符号使用；可重新运行安装包勾选 Python 组件重试。"
    ${Else}
      DetailPrint "Python 组件已安装（venv: $INSTDIR\sidecar\.venv）"
    ${EndIf}
  ${Else}
    DetailPrint "按用户选择跳过 Python 组件（之后可重新运行安装包安装）"
  ${EndIf}
SectionEnd

Function un.onInit
  SetShellVarContext current
  IfFileExists "$INSTDIR\tools\stop-moshi.ps1" 0 un_no_stop
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\tools\stop-moshi.ps1"'
  Pop $0
  un_no_stop:
FunctionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\默识\默识.lnk"
  RMDir "$SMPROGRAMS\默识"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "moshi"
  DeleteRegKey HKCU "Software\moshi"
  RMDir /r "$INSTDIR"

  ${IfNot} ${Silent}
    MessageBox MB_ICONINFORMATION "默识已卸载。$\r$\n$\r$\n数据目录 $PROFILE\.moshi 已保留（如需彻底删除请手动删除）。"
  ${EndIf}
SectionEnd
