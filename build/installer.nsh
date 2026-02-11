; Custom NSIS installer script for PDF Manager
; Ensures shortcuts always point to the correct version after upgrade

!macro customInit
  ; During upgrade: remove stale shortcuts that may point to old install paths
  ; This runs BEFORE the new files are installed

  ; Remove old desktop shortcut (may point to previous install directory)
  Delete "$DESKTOP\PDF Manager.lnk"

  ; Remove old Start Menu shortcuts
  RMDir /r "$SMPROGRAMS\PDF Manager"

  ; Also clean up any per-user shortcuts if installed per-machine previously
  SetShellVarContext current
  Delete "$DESKTOP\PDF Manager.lnk"
  RMDir /r "$SMPROGRAMS\PDF Manager"
  SetShellVarContext all
  Delete "$DESKTOP\PDF Manager.lnk"
  RMDir /r "$SMPROGRAMS\PDF Manager"

  ; Restore to appropriate context (electron-builder handles this, but reset to be safe)
  SetShellVarContext current
!macroend

!macro customInstall
  ; After files are installed: create fresh shortcuts pointing to the new exe location

  ; Desktop shortcut
  CreateShortCut "$DESKTOP\PDF Manager.lnk" "$INSTDIR\PDF Manager.exe" "" "$INSTDIR\PDF Manager.exe" 0

  ; Start Menu folder + shortcut
  CreateDirectory "$SMPROGRAMS\PDF Manager"
  CreateShortCut "$SMPROGRAMS\PDF Manager\PDF Manager.lnk" "$INSTDIR\PDF Manager.exe" "" "$INSTDIR\PDF Manager.exe" 0
  CreateShortCut "$SMPROGRAMS\PDF Manager\Uninstall PDF Manager.lnk" "$INSTDIR\Uninstall PDF Manager.exe"

  ; Register .pdf file association refresh
  ; Notify the shell that file associations have changed
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0x0000, p 0, p 0)'
!macroend

!macro customUnInstall
  ; Clean up ALL shortcuts during uninstall

  ; Desktop shortcut
  SetShellVarContext current
  Delete "$DESKTOP\PDF Manager.lnk"
  SetShellVarContext all
  Delete "$DESKTOP\PDF Manager.lnk"

  ; Start Menu
  SetShellVarContext current
  RMDir /r "$SMPROGRAMS\PDF Manager"
  SetShellVarContext all
  RMDir /r "$SMPROGRAMS\PDF Manager"

  ; Notify shell
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0x0000, p 0, p 0)'
!macroend
