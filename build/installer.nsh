; Custom NSIS hooks for MoritApp
; - Auto-start with Windows (current user Run key)
; - Clean removal on uninstall

!macro customInstall
  ; Start MoritApp when the user logs into Windows
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MoritApp" '"$INSTDIR\MoritApp.exe"'
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MoritApp"
!macroend
