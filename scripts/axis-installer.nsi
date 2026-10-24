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
!define MUI_FINISHPAGE_TEXT "Axis is installed. Restart Premiere Pro, then open Window > Extensions > Axis. Your accounts and conversations are retained during upgrades and uninstall."
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
    MessageBox MB_OK|MB_ICONSTOP "Axis could not be configured. See the installation log. Your data was retained." /SD IDOK
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
  StrCpy $Arguments '"$Runtime\node\node.exe" "$Runtime\scripts\axis-install.mjs" --install-root "$INSTDIR" --uninstall'
  nsExec::ExecToLog $Arguments
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Axis could not be removed. See the uninstall log. Your data was retained." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  ; Each owned release has its own marker. Leave unrelated files in a custom /D directory alone.
  ClearErrors
  FindFirst $1 $2 "$INSTDIR\app-*"
  ${DoWhile} $2 != ""
    ${If} ${FileExists} "$INSTDIR\$2\release.json"
      RMDir /r "$INSTDIR\$2"
    ${EndIf}
    FindNext $1 $2
  ${Loop}
  FindClose $1
  ClearErrors
  IfFileExists "$Runtime\node\node.exe" 0 +2
    SetErrors
  ${If} ${Errors}
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
