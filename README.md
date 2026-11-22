# All In One NR2003

An overlay, race control and AI companion for **NASCAR Racing 2003 Season**. It brings several community-made NR2003 tools together in one Windows app:
- broadcast-style overlays;
- stage racing and a season tracker;
- race control (cautions, pace car, qualifying);
- AI pit strategy;
- AI Enhanced;
- an automatic TV director;
- Dynamic Rubber;
- support for RaceLab.

This is an **unofficial, community-made build**. It is not the original Project SteelFire Overlays, and it is not made or supported by the authors of the tools it is built from. Please see the credits and support the original authors.

You need your own installed copy of NASCAR Racing 2003 Season.

## Download

Get the installer from **[Releases](../../releases)**. The latest is `All_In_One_NR2003_BETA-2.exe`.

The installer is not code-signed, so Windows SmartScreen may warn about it: click *More info*, then *Run anyway*. The app runs as administrator, because it reads the game's memory.

Full instructions are in [`extra/root/README.txt`](extra/root/README.txt), which is also installed with the app. It covers installing, launching a race, every feature, RaceLab, Dynamic Rubber, CrashCatch, troubleshooting and credits.

## What's in this repository

| Path | What it is |
|---|---|
| `app/` | The Electron app: main process, pages, overlays and the feature modules (race control, AIMOD, TV director, season tracker, Dynamic Rubber...) |
| `extra/root/` | Files installed next to the app: series, tracks, sounds, images, fonts, `CrashCatch`, the README and the licenses |
| `extra/resources/` | The data bridge and shim that feed the overlays |
| `package.json` | The electron-builder configuration for the NSIS installer |

NR2003's own `NR2003.exe` is **not** included in this repository.

## Building the installer

```
npm install
npx electron-builder --win nsis --x64
```

The installer is written to `dist/`.

## Crash and freeze reports

If NR2003 crashes or freezes, run CrashCatch: in the installed app's `CrashCatch` folder, double-click `Start CrashCatch.cmd`. Then send the report from `Documents\NR2003 CrashCatch`. See `extra/root/CrashCatch/How to use CrashCatch.txt`.

## Credits

All credit for the original work goes to its authors:
- **Papyrus Design Group / Sierra:** NASCAR Racing 2003 Season.
- **steelhorselive:** Project SteelFire Overlays (the overlays, data bridge and shim). [Twitch](https://twitch.tv/steelhorselive) · [X](https://x.com/SteelHorseLive) · [Discord](https://discord.gg/eYZEwpA49j)
- **Jonathon Thomas:** [RaceControl](https://github.com/NR2003-JT/RaceControl), [QualControl](https://github.com/NR2003-JT/QualControl), [RaceVision](https://github.com/NR2003-JT/RaceVision) and [AIMOD](https://github.com/NR2003-JT/AIMOD) v2 (MIT).
- **Adolfo Delgado:** the original AIMOD v1.0.4.
- **[NR2003_Ryan](https://www.reddit.com/user/NR2003_Ryan/):** AI Enhanced.
- **MMCS:** NR2003 Dynamic Rubber. It uses [ReShade](https://reshade.me/) and [d3d8to9](https://github.com/crosire/d3d8to9) by crosire (Patrick Mours), and Mark Adler's blast decompressor.
- **NCRDesigns / MiaSquirtle:** NR2003 Background.
- **Tight_Principle9572:** RaceLab ([YouTube](https://youtube.com/@mysimracinggame)). RaceLab is not included.

The full credits, and the series, paint and track credits, are in [`extra/root/README.txt`](extra/root/README.txt). The license texts are in [`extra/root/licenses`](extra/root/licenses).
