; Windows installer for Khmer Voice AI (Inno Setup 6). Built by .github/workflows/build-apps.yml:
;   iscc /DAppVersion=1.1.0 /DSourceDir=<the assembled "Khmer Voice AI" folder> installer.iss
; Installs for the current user only (no administrator needed). Projects and settings in
; %LOCALAPPDATA%\Khmer Voice AI are kept when the app is uninstalled.
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{7A0C2E2B-4D8B-4E58-9C3A-6C1B9E6F2A11}
AppName=Khmer Voice AI
AppVersion={#AppVersion}
AppVerName=Khmer Voice AI {#AppVersion}
AppPublisher=VoiceNova AI
AppPublisherURL=https://github.com/chydevit/VoiceNova-AI
AppSupportURL=https://github.com/chydevit/VoiceNova-AI/issues
DefaultDirName={localappdata}\Programs\Khmer Voice AI
DefaultGroupName=Khmer Voice AI
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=Khmer-Voice-AI-Setup-{#AppVersion}-windows-x64
OutputDir=Output
SetupIconFile=Launcher\app.ico
UninstallDisplayIcon={app}\Khmer Voice AI.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\Khmer Voice AI"; Filename: "{app}\Khmer Voice AI.exe"
Name: "{autodesktop}\Khmer Voice AI"; Filename: "{app}\Khmer Voice AI.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Khmer Voice AI.exe"; Description: "Open Khmer Voice AI now"; Flags: nowait postinstall skipifsilent
