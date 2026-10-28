; AI Compliance Logger - custom NSIS uninstall logic.
;
; electron-builder auto-includes build/installer.nsh (the buildResources dir) and
; invokes the macros it defines. We override customUnInstall to finish the
; clean-removal story the default oneClick uninstaller leaves open:
;
;   1. De-register autostart. Electron's setLoginItemSettings writes an HKCU Run
;      value; main.ts pins its name to "AI Compliance Logger" so we can delete exactly
;      that value here. Without this, uninstalling leaves a dangling Run entry
;      pointing at a deleted exe (a real Windows orphan / startup error).
;
;   2. Offer an explicit, opt-in purge of local app data. Default is KEEP
;      (data-minimization: never silently destroy captured AI turns still queued
;      for upload, or the saved connection). The silent uninstall the installer
;      runs during an app self-update always keeps data.

!macro customUnInstall
  DetailPrint "Removing AI Compliance Logger autostart entry..."
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AI Compliance Logger"

  ; Silent uninstall (app self-update replaces the install): never prompt, keep data.
  IfSilent aic_keepdata

  ; userData lives at $APPDATA\<productName> - the same path electron-builder's own
  ; deleteAppDataOnUninstall would target. Default answer is No (keep data).
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Also remove AI Compliance data stored on this PC?$\r$\n$\r$\nThis deletes any captured AI turns still waiting to upload and your saved connection to the firm account. Choose No to keep them." \
    /SD IDNO IDNO aic_keepdata
  DetailPrint "Removing local AI Compliance data..."
  RMDir /r "$APPDATA\AI Compliance Logger"

  aic_keepdata:
!macroend
