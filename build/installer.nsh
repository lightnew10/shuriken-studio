; Kiln comes with Shuriken Studio. A bundle build (npm run dist:bundle) carries Kiln's installer as
; resources\kiln\Kiln-Setup.exe. Once Shuriken Studio is installed, Kiln is installed silently, for this Windows user,
; in %LOCALAPPDATA%\Programs\Kiln (where Shuriken looks for it), unless a Kiln is already there or has run on this PC;
; then the bundled installer is deleted. Kiln stays when Shuriken Studio is uninstalled. A plain build (npm run dist)
; has no Kiln in it and skips all of this.
!macro customInstall
  IfFileExists "$INSTDIR\resources\kiln\Kiln-Setup.exe" 0 kiln_bundle_done
    IfFileExists "$LOCALAPPDATA\Programs\Kiln\Kiln.exe" kiln_bundle_cleanup
    IfFileExists "$APPDATA\Kiln\install.json" kiln_bundle_cleanup
    DetailPrint "Installing Kiln..."
    ExecWait '"$INSTDIR\resources\kiln\Kiln-Setup.exe" /S /D=$LOCALAPPDATA\Programs\Kiln'
    kiln_bundle_cleanup:
    Delete "$INSTDIR\resources\kiln\Kiln-Setup.exe"
    RMDir "$INSTDIR\resources\kiln"
  kiln_bundle_done:
!macroend
