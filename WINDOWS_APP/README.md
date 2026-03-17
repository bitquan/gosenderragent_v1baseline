# Windows app bundle

This folder is where packaged Windows installers and unpacked validation builds will be copied when they exist.

If there is no `.exe` or `.msi` here yet, run the source bundle first:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\bootstrap.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\windows\dev.ps1
```

Then package a Windows build on the PC with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\package.ps1
```

For the current target machine, the default packaging path is the x64 build for an i9 / 32 GB Windows PC.
