Unicode true
SetCompressor /SOLID lzma
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "StrFunc.nsh"
${StrStr}
${StrCase}
Name "Axis"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Axis"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Axis" "InstallLocation"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show
Var Sandbox
Var Port
Var Arguments
Var Runtime
Var OverrideRuntime
Var OverrideCep
Var OverrideData
Var OverrideWorkspace
Var OverrideBridge
Var SkipRegistry
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TEXT "Axis is installed. Restart Premiere Pro, then open Window > Extensions > Axis. Choose Accounts to install a provider and sign in. Node and Git are included. Transcription setup is optional. Your accounts and conversations are retained during upgrades and uninstall."
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

!macro SandboxGuard PREFIX
Function ${PREFIX}ValidateSandbox
  ${If} $Sandbox != ""
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File /oname=axis-guard-node.exe "${PAYLOAD}\node\node.exe"
    File /oname=axis-sandbox-paths.mjs "${PAYLOAD}\scripts\axis-sandbox-paths.mjs"
    !if "${PREFIX}" == ""
      nsExec::ExecToLog '"$PLUGINSDIR\axis-guard-node.exe" "$PLUGINSDIR\axis-sandbox-paths.mjs" --runtime "$INSTDIR" --port "$Port"'
    !else
      nsExec::ExecToLog '"$PLUGINSDIR\axis-guard-node.exe" "$PLUGINSDIR\axis-sandbox-paths.mjs" --runtime "$INSTDIR" --uninstall'
    !endif
    Pop $0
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "Sandbox paths failed validation. No Axis targets were changed." /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd
!macroend
!insertmacro SandboxGuard ""
!insertmacro SandboxGuard "un."

Function .onInit
  SetShellVarContext current
  StrCpy $Port "5739"
  ; Environment-based isolation survives Windows quoting of flags containing spaces.
  ; A sandbox request without its root must abort before extracting any files.
  ReadEnvStr $Sandbox "AXIS_SANDBOX_ROOT"
  ReadEnvStr $OverrideRuntime "AXIS_RUNTIME_DIR"
  ReadEnvStr $OverrideCep "AXIS_CEP_DIR"
  ReadEnvStr $OverrideData "AXIS_DATA_DIR"
  ReadEnvStr $OverrideWorkspace "AXIS_WORKSPACE_DIR"
  ReadEnvStr $OverrideBridge "AXIS_BRIDGE_DIR"
  ReadEnvStr $SkipRegistry "AXIS_SKIP_REGISTRY"
  ${If} $Sandbox == ""
    ${If} $OverrideRuntime != ""
    ${OrIf} $OverrideCep != ""
    ${OrIf} $OverrideData != ""
    ${OrIf} $OverrideWorkspace != ""
    ${OrIf} $OverrideBridge != ""
    ${OrIf} $SkipRegistry != ""
      SetErrorLevel 2
      Abort
    ${EndIf}
  ${EndIf}
  ${StrCase} $0 $CMDLINE "U"
  ${StrStr} $0 $0 "/SANDBOX"
  ${If} $0 != ""
  ${AndIf} $Sandbox == ""
    MessageBox MB_OK|MB_ICONSTOP "Sandbox mode requires AXIS_SANDBOX_ROOT. No files were installed." /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  ${GetParameters} $Arguments
  ${GetOptions} $Arguments "/PORT=" $Port
  ${If} $Port == ""
    StrCpy $Port "5739"
  ${EndIf}
  ${If} $Sandbox != ""
    ReadEnvStr $OverrideRuntime "AXIS_RUNTIME_DIR"
    ReadEnvStr $OverrideCep "AXIS_CEP_DIR"
    ReadEnvStr $OverrideData "AXIS_DATA_DIR"
    ReadEnvStr $OverrideWorkspace "AXIS_WORKSPACE_DIR"
    ReadEnvStr $OverrideBridge "AXIS_BRIDGE_DIR"
    ReadEnvStr $SkipRegistry "AXIS_SKIP_REGISTRY"
    ${If} $OverrideRuntime == ""
    ${OrIf} $OverrideCep == ""
    ${OrIf} $OverrideData == ""
    ${OrIf} $OverrideWorkspace == ""
    ${OrIf} $OverrideBridge == ""
    ${OrIf} $SkipRegistry != "1"
      MessageBox MB_OK|MB_ICONSTOP "Sandbox mode requires explicit runtime, CEP, data, workspace, bridge and registry overrides. No files were installed." /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
    StrCpy $INSTDIR "$OverrideRuntime"
    Call ValidateSandbox
  ${EndIf}
FunctionEnd

Section "Axis"
  ; The directory page and /D can change INSTDIR after .onInit.
  Call ValidateSandbox
  ; Use a private bootstrap so same-version reinstalls can release a running node.exe
  ; before NSIS overwrites it, even if the installed Node was quarantined.
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=node.exe "${PAYLOAD}\node\node.exe"
  File "${PAYLOAD}\scripts\axis-install.mjs"
  File "${PAYLOAD}\scripts\axis-install-port.mjs"
  File "${PAYLOAD}\scripts\axis-adobe-settings.mjs"
  File "${PAYLOAD}\scripts\axis-sandbox-paths.mjs"
  IfFileExists "$INSTDIR\install-record.json" 0 axis_extract
  nsExec::ExecToLog '"$PLUGINSDIR\node.exe" "$PLUGINSDIR\axis-install.mjs" --install-root "$INSTDIR" --prepare-upgrade --port "$Port"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Close Premiere and retry. Axis could not stop its previous backend for upgrade. Your data was retained." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  axis_extract:
  SetOutPath "$INSTDIR\app-${BUILD_ID}"
  SetOverwrite ifdiff
  File /r "${PAYLOAD}\*"
  StrCpy $Runtime "$INSTDIR\app-${BUILD_ID}"
  StrCpy $Arguments '"$Runtime\node\node.exe" "$Runtime\scripts\axis-install.mjs" --install-root "$INSTDIR" --port "$Port"'
  ${If} $Sandbox != ""
    StrCpy $Arguments '$Arguments --sandbox-root "$Sandbox"'
  ${EndIf}
  nsExec::ExecToLog $Arguments
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Axis could not be configured. Close Premiere and retry. If a runtime file is missing, check Windows Security > Protection history and reinstall from your trusted installer. See the installation log for details. Your data was retained." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  WriteINIStr "$INSTDIR\install.ini" "Axis" "Runtime" "$Runtime"
  WriteINIStr "$INSTDIR\install.ini" "Axis" "Sandbox" "$Sandbox"
  WriteUninstaller "$INSTDIR\Uninstall Axis.exe"
  ${If} $Sandbox == ""
  ${AndIf} $SkipRegistry != "1"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Axis" "DisplayName" "Axis"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Axis" "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Axis" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Axis" "UninstallString" '$\"$INSTDIR\Uninstall Axis.exe$\"'
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Axis" "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Axis" "NoRepair" 1
  ${EndIf}
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  ReadINIStr $Runtime "$INSTDIR\install.ini" "Axis" "Runtime"
  ReadINIStr $Sandbox "$INSTDIR\install.ini" "Axis" "Sandbox"
  ReadEnvStr $SkipRegistry "AXIS_SKIP_REGISTRY"
  Call un.ValidateSandbox
  ; The uninstaller must also work after the installed runtime was quarantined.
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=node.exe "${PAYLOAD}\node\node.exe"
  File "${PAYLOAD}\scripts\axis-install.mjs"
  File "${PAYLOAD}\scripts\axis-install-port.mjs"
  File "${PAYLOAD}\scripts\axis-adobe-settings.mjs"
  File "${PAYLOAD}\scripts\axis-sandbox-paths.mjs"
  StrCpy $Arguments '"$PLUGINSDIR\node.exe" "$PLUGINSDIR\axis-install.mjs" --install-root "$INSTDIR" --runtime-root "$Runtime" --uninstall'
  nsExec::ExecToLog $Arguments
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Axis could not be removed. See the uninstall log. Your data was retained." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  ; Each owned release has its own marker. Leave unrelated files in a custom /D directory alone.
  StrCpy $0 "0"
  ClearErrors
  FindFirst $1 $2 "$INSTDIR\app-*"
  ${DoWhile} $2 != ""
    ${If} ${FileExists} "$INSTDIR\$2\release.json"
      CopyFiles /SILENT "$INSTDIR\$2\release.json" "$PLUGINSDIR\axis-release.json"
      ${If} ${Errors}
        StrCpy $0 "1"
        ${Break}
      ${EndIf}
      RMDir /r "$INSTDIR\$2"
      ${If} ${FileExists} "$INSTDIR\$2\*.*"
        ; Preserve ownership so a retry can finish removing a partially locked release.
        CopyFiles /SILENT "$PLUGINSDIR\axis-release.json" "$INSTDIR\$2\release.json"
        StrCpy $0 "1"
      ${EndIf}
      ClearErrors
    ${EndIf}
    FindNext $1 $2
  ${Loop}
  FindClose $1
  ${If} $0 == "1"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Some Axis runtime files are in use. Close Premiere and the Axis backend, then run the uninstaller again. Your data was retained." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  ${If} $Sandbox == ""
  ${AndIf} $SkipRegistry != "1"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Axis"
  ${EndIf}
  Delete "$INSTDIR\install-record.json"
  Delete "$INSTDIR\install.ini"
  Delete "$INSTDIR\Uninstall Axis.exe"
  RMDir "$INSTDIR"
SectionEnd
