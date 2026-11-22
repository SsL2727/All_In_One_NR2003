================================================================================
  ALL IN ONE NR2003  -  version 1.0.11
  An overlay, race control and AI companion for NASCAR Racing 2003 Season
================================================================================

All In One NR2003 brings several community-made NR2003 tools together in one
app: broadcast-style overlays, stage racing, a season tracker, race control
(cautions, pace car, qualifying), AI pit strategy, AI Enhanced, a TV director,
Dynamic Rubber and RaceLab.

It is an UNOFFICIAL, community-made build. It is NOT the original Project
SteelFire Overlays, and it is not made by, or supported by, the authors of the
tools it is built from. Please see CREDITS at the end of this file and support
the original authors.

You need your own installed copy of NASCAR Racing 2003 Season.


--------------------------------------------------------------------------------
  CONTENTS
--------------------------------------------------------------------------------
   1. Requirements
   2. Installing
   3. First start
   4. Launching a race
   5. Features
   6. Hotkeys
   7. Mobile (phone) access
   8. AI Enhanced
   9. RaceLab (included)
  10. Dynamic Rubber
  11. CrashCatch (crash and freeze reports)
  12. Where your settings are kept
  13. Troubleshooting
  14. Uninstalling
  15. CREDITS
  16. Licenses


--------------------------------------------------------------------------------
  1. REQUIREMENTS
--------------------------------------------------------------------------------
  - Windows 10 or 11, 64-bit.
  - NASCAR Racing 2003 Season, installed, with a player profile created in the
    game. The game must have been run at least once.
  - Administrator rights. NR2003 runs as administrator, and the app has to
    read the game's memory, so it asks for them too.


--------------------------------------------------------------------------------
  2. INSTALLING
--------------------------------------------------------------------------------
  1. Run All-In-One-NR2003-Setup-1.0.11.exe and accept the Windows prompt.
  2. Choose the install folder. The default works.
  3. Start All In One NR2003 from the desktop or Start menu shortcut.

  Updating from an older version: install over it. Your settings are kept
  (see section 12).

  The installer is not code-signed. Windows SmartScreen may show
  "Windows protected your PC". Click "More info", then "Run anyway".


--------------------------------------------------------------------------------
  3. FIRST START
--------------------------------------------------------------------------------
  1. On the main page, click the NR2003 path box and pick your game's EXE
     (usually NR2003.exe in the game folder).
  2. Pick your player profile from the player list. It is how the overlays
     know which car is yours.
  3. Switch the features you want on or off on the main page. Each card opens
     its own settings window.

  The install folder also has an "NR2003 game exe" folder with an NR2003.exe
  build that the memory features were made for. Only use it if your own EXE
  doesn't work with them. Keep a backup of your own EXE first.


--------------------------------------------------------------------------------
  4. LAUNCHING A RACE
--------------------------------------------------------------------------------
  Always start the game with the "Launch NR2003" button. The button:
    - starts the data shim and bridge that feed the overlays,
    - starts NR2003 (through RaceLab, if RaceLab is switched on),
    - opens your overlays once the game is up.

  If you start NR2003 some other way, the overlays and the bridge do not
  start. Close the game and launch it from the app instead.

  When NR2003 closes, the overlays close with it.


--------------------------------------------------------------------------------
  5. FEATURES
--------------------------------------------------------------------------------
  OVERLAYS
    Live timing tower, relative, track map, standings, leader board, points
    table, top 3, driver info banner, flags and more. Use the Layout Editor to
    place and size them, and Edit Mode to drag them on screen.

  STAGE RACING
    Set the number of stages and their lengths, and whether a stage ends with
    a caution or with no caution. Stage results and stage points go to the
    Season Tracker.

  SEASON TRACKER
    Points, stage points and season-long standings, with The Chase / playoffs.
    There are official points systems for NASCAR, IndyCar and F1, plus
    schedules, rivals, career stats and result cards. A race only counts when
    it is activated in the tracker.

  GUARANTEED STARTERS (Season Tracker, Schedule tab)
    - "The top 35 in owner points are locked into every race": the old
      NASCAR rule. The number can be changed. It counts from the second race
      on, once there are owner points.
    - Chartered cars: car numbers that start every race. Set them for the
      whole season, or for one race in the schedule's Charters column (a
      race's own list is used instead of the season's).
    How it works: every guaranteed car stays in the roster NR2003 picks the
    field from, and the other places are drawn at random, as the game does.
    With a qualifying field size set in RaceControl's qualifying, a
    guaranteed car is never cut and the other places go to the fastest of
    the rest. When a track takes fewer cars than there are chartered cars,
    the game picks the field from the chartered cars only. A guaranteed
    number that is not in your roster can't be added; RaceControl's Field
    section lists any that are missing. It applies to the active season.

  RACE CONTROL (from RaceControl and QualControl)
    Realistic cautions and mechanical-failure cautions, pace car pickup and
    pace laps, wave-arounds, lucky dog, one-to-go and restart order.
    Qualifying control: practice-order timing, keeping or re-applying saved
    results, and merging cars into the field.

  AIMOD & AI TWEAKS (AIMOD 2.2)
    AI pit strategy: crew chief decisions, fuel and tire calls, driver plans,
    racing intensity and rivals, a scanner radio with subtitles, and the pit
    board. AI Editing tweaks adjust AI driver values.

  AI ENHANCED
    Starts the original AI Enhanced program with the app (see section 8).

  RACEVISION / TV DIRECTOR
    An automatic TV director: camera switching, camera sets, broadcast
    graphics, replays with a tape transport, smart slow motion and replay
    wipes, highlights, an overlay editor and a phone remote.

  LAYOUT EDITOR
    Arrange and style the overlays. Layouts can be saved and switched.
    Its broadcast graphics panel has an on/off switch for every graphic
    shown over the game: RaceControl's cone board, caution panel,
    qualifying box, your-run banner and game paused card; AIMOD's pit board,
    rivals card and radio subtitles; and the TV director's driver tag,
    battle box, on-board dash, position changes, replay banner and replay
    wipe.

  DYNAMIC RUBBER
    Tire rubber builds up on every car's paint as a race goes on (see
    section 10).

  SERIES EDITOR
    Per-series data for the overlays: driver first and last names by car
    number, manufacturers and colors.

  NR2003 BACKGROUND
    Keeps the game's video and sound running when its window loses focus
    (when you alt-tab). Switch on "Keep NR2003 Running in the Background" on
    the main page. Run NR2003 windowed or borderless. Use "Sound Only" when
    driving with a wheel or gamepad.

  ONE CAR PER DRIVER
    Makes sure no driver appears twice in the AI field. It's in the Stage
    Racing window.

  RACELAB
    RaceLab by Tight_Principle9572 is included; install it and change its
    settings from the RaceLab page (see section 9).


--------------------------------------------------------------------------------
  6. HOTKEYS
--------------------------------------------------------------------------------
  Set them on the main page. They only work while NR2003 is the active
  window, or while you are editing overlays, so they never steal keys from
  other programs.

    Edit Mode .................. move and size overlays on screen
    Reopen Overlays ............ bring the overlays back if one was closed
    Resync Standings ........... refresh the standings from the game
    Points Table ............... show or hide the points table
    Top 3 Images ............... show or hide the top 3 graphic
    Driver Info Banner ......... show or hide the driver banner


--------------------------------------------------------------------------------
  7. MOBILE (PHONE) ACCESS
--------------------------------------------------------------------------------
  Click "Mobile" on the main page to show a QR code. Scan it with a phone on
  the same Wi-Fi network to open the live pages on the phone. The TV
  director's phone remote works the same way. If the phone can't connect,
  allow All In One NR2003 through the Windows Firewall on private networks.


--------------------------------------------------------------------------------
  8. AI ENHANCED
--------------------------------------------------------------------------------
  This version includes AI Enhanced v0_2_2b by NR2003_Ryan. In the AI
  Enhanced window, switch on "Launch AI Enhanced when All In One NR2003
  starts".

  The original AI Enhanced only looks for a game called NR2003.exe. The copy
  shipped here has one small change: when All In One NR2003 starts it, it is
  told the name of the game EXE you launch, including RaceLab's
  NR2003_RaceLabV2.exe or NR2003_MS.exe. Started any other way, it behaves
  exactly like the original.

  If you start AI Enhanced yourself and your game runs under another name,
  type that name into the box in AI Enhanced's "Not connected to" message.


--------------------------------------------------------------------------------
  9. RACELAB (INCLUDED)
--------------------------------------------------------------------------------
  RaceLab by Tight_Principle9572 is an NR2003 mod. It adds AI racecraft, tire
  failures, crash panels or soft-body damage, traffic yield, drafting rows,
  allies and rivals, and a player Career. The original RaceLab download
  (Nine Series Beta, Full Panels, without Cup 2026 Ultra) is included,
  unchanged, with its own readme, guides and credits. It is in the install
  folder's "RaceLab" folder as a zip.

  To use it with All In One NR2003:
  1. Open the RaceLab card and click "Install the included RaceLab". It
     unpacks RaceLab (about 560 MB, a minute or two) into your NR2003
     folder, where it keeps its own settings, logs and Career saves, and
     selects it. You can also unpack the zip yourself into a folder beside
     your NR2003 folder (its name must contain "RaceLab"), or use a RaceLab
     you already have with "Choose...".
  2. Open the RaceLab card and switch on "Launch NR2003 through RaceLab".
  3. Game EXE: RaceLab only loads into its own game builds, and they must
     keep their names (NR2003_RaceLabV2.exe or NR2003_MS.exe). Pick one here.
     A build not in your game folder yet is copied there from RaceLab's
     "Game EXEs" folder. Click Validate to check it.
  4. Renderer (only for soft-body damage): each build needs its own
     rend_dxg.dll.
       - "Switch to RaceLab's renderer" puts the matching one in place.
       - The first switch backs up your own file as
         rend_dxg.dll.steelfire-original in the game folder. It is made once
         and never overwritten.
       - "Restore original" puts your file back.
       - "Pick the file..." lets you choose the renderer yourself. Every file
         is checked by its SHA-256 fingerprint.
     Close NR2003 before switching.
  5. Start the game with "Launch NR2003" from All In One NR2003, NOT from
     RaceLab's own window. That way the overlays, bridge and other features
     start too. NR2003 Background, if on, attaches to the game right after.

  While RaceLab's racing lines or allies / rivals are active, the app's own
  overlapping AI features step aside so they don't fight it:
    - AIMOD's racing intensity pauses for allies / rivals.
    - AI Enhanced's tandem and MultiGroove pause for racing lines.

  RaceLab's allies and rivals then show up in the app the same way AIMOD's
  rivals do:
    - TV director: a battle between RaceLab rivals is worth more and stays
      on screen longer.
    - Battle graphic: labelled FEUD, GRUDGE or RIVALS, or ALLIES /
      TEAMMATES for trusted allies.
    - Driver story line: "Feud with #22", "Holds a grudge against #8",
      "Trusted drafting ally of #20".
    - Rivals card: the car on TV and a rival racing right next to it
      ("VS"), or a trusted ally ("&"), with AIMOD's card position and
      number art.
    - Season Tracker: a counted race saves RaceLab's rivalries among that
      race's cars, with its contacts, spins, wrecks and blocks as run-ins.
  Only TRUSTED allies are shown (RaceLab score 70 or more both ways). RaceLab
  makes most drafting partners allies, so plain allies are left out.
  Rivals follow RaceLab's own thresholds (rival -40, contact -60,
  intense -80).

  The Modules, Tire failures, Crash damage, Traffic, Racing lines and
  Allies / rivals tabs edit RaceLab's own settings files, so RaceLab's
  launcher sees the same values.


--------------------------------------------------------------------------------
  10. DYNAMIC RUBBER
--------------------------------------------------------------------------------
  Dynamic Rubber by MMCS builds up tire rubber on each car's body paint
  during a race: the front bumper, the leading edge of the hood and the lower
  sides. It is a ReShade add-on that follows the race through NR2003's
  replay telemetry. It works with standard car paints (Cup, GNS, CTS) and
  finds new carsets when NR2003 starts. Saved replays don't rebuild the
  rubber from an earlier race.

  Open the Dynamic Rubber card on the main page. With NR2003 closed:
    - Install: the page lists every file it will change first. It does
      what the original Dynamic Rubber setup does:
        - core.ini [Replay]: replay telemetry on (record_telem=1, every
          record_telem_state_a bit),
        - d3d8.dll: d3d8to9 (an existing d3d8to9 is kept; otherwise
          d3d8to9 1.16.0 is downloaded),
        - d3d9.dll: ReShade 6.8.0 with full add-on support, downloaded from
          reshade.me. A DXVK d3d9.dll is kept and loaded through ReShade (it
          asks first). A ReShade 6.8.0 or older is replaced, keeping your
          settings and presets,
        - the add-on next to NR2003.exe.
      Downloads come only from the official pages and are checked against
      known SHA-256 fingerprints. Setups it can't change safely (another
      Direct3D 8 wrapper, a newer or custom d3d9.dll, ReShade add-ons in a
      folder outside the game) are left alone and explained.
    - On / off: renames the add-on (NR2003BodyRubber.addon32 /
      NR2003BodyRubber.disabled). ReShade stays in place.
    - Undo this install: each install keeps the files it replaced in
      "NR2003 Dynamic Rubber Backups" in the game folder. Undo removes the
      files it added and puts the old ones back. In core.ini only the two
      replay telemetry values go back, so game settings changed since are
      kept.

  Notes: installing makes ReShade active, with its own overlay and Home-key
  menu. Replay telemetry makes saved replays larger. If the game freezes or
  crashes with it on, switch it off and send a CrashCatch report
  (section 11).


--------------------------------------------------------------------------------
  11. CRASHCATCH (CRASH AND FREEZE REPORTS)
--------------------------------------------------------------------------------
  CrashCatch watches NR2003 while you play and writes down exactly how the
  game ended when it crashes, closes on its own, or freezes. It only
  watches; it does not change the game. It is in the "CrashCatch" folder in
  the install folder, with its own "How to use CrashCatch.txt".

  1. Double-click "Start CrashCatch.cmd" and accept the Windows prompt
     (NR2003 runs as administrator, so CrashCatch has to as well).
  2. Leave its window open and start NR2003 as usual. It attaches by itself
     to NR2003.exe, NR2003_MS.exe or NR2003_RaceLabV2.exe.
  3. Play until the problem happens.
       - Crash or the game closing: the report is written at once.
       - Freeze: after 8 seconds without a response the window says
         "FROZEN" and writes the report while the game is still stuck.
         Wait for "minidump written" before closing the game.
  4. The reports are in Documents\NR2003 CrashCatch:
       nr2003-<date>-<time>.txt / .dmp           a crash or exit
       nr2003-<date>-<time>-hang.txt / .dmp      a freeze
     Send the .txt when you report a problem, and the .dmp (zipped, it is
     100-200 MB) if you are asked for it.


--------------------------------------------------------------------------------
  12. WHERE YOUR SETTINGS ARE KEPT
--------------------------------------------------------------------------------
    %APPDATA%\All In One NR2003\        settings (config.json) and logs
    %ProgramData%\NR2003 Companions\    shared data (overlay layouts, feeds)

  To start over with default settings, close the app and rename
  %APPDATA%\All In One NR2003.


--------------------------------------------------------------------------------
  13. TROUBLESHOOTING
--------------------------------------------------------------------------------
  - Overlays don't show: start the game with "Launch NR2003", and make sure a
    player profile is selected.
  - Overlays show but have no race data: the bridge isn't reaching them.
    Check its log (below): "Client connected" lines mean the overlays
    reached it. If there are none, security software, a VPN or a Windows
    proxy may be blocking connections to this PC (localhost). With the game
    running, http://localhost:8766/ should open in a web browser.
  - The game doesn't start through RaceLab: the launch button shows
    RaceLab's reason, and every RaceLab launch is logged in
    %APPDATA%\All In One NR2003\racelab.log. RaceLab's soft-body mode must
    match the series selected in NR2003.
  - The game crashes or freezes: run CrashCatch (section 11) and send its
    report.
  - A feature says it can't read the game: check that the NR2003 path points
    to the EXE you actually run. Builds other than the standard NR2003.exe
    (and RaceLab's NR2003_RaceLabV2 / NR2003_MS) may use different memory
    addresses.
  - The RaceLab card says RaceLab isn't found: click "Install the included
    RaceLab" on the RaceLab page, or "Choose..." its folder.
  - RaceLab shows "Not running": launch from All In One NR2003 with
    "Launch NR2003 through RaceLab" on, then check RaceLab's Log tab.
  - Hotkeys don't respond: click into the NR2003 window first. Hotkeys are
    only active while the game is in front.
  - Windows Defender removes nr2003_bridge.exe: restore it from quarantine
    and add an exclusion for the install folder.
  - Logs are in %APPDATA%\All In One NR2003 (race_control.log, aie.log,
    ai-strategy.log, background.log, racelab.log). The bridge always writes
    its log to %APPDATA%\Project SteelFire Overlays\bridge.log (that folder
    name is built into the bridge; the folder is made even if Project
    SteelFire Overlays was never installed).


--------------------------------------------------------------------------------
  14. UNINSTALLING
--------------------------------------------------------------------------------
  Use "Add or remove programs" in Windows Settings. Your settings in
  %APPDATA%\All In One NR2003 are left in place. Delete that folder by hand
  to remove them too. If you used RaceLab's renderer switch, click
  "Restore original" first, or copy rend_dxg.dll.steelfire-original back
  over rend_dxg.dll in your game folder. If you installed Dynamic Rubber,
  use "Undo this install" on its page first: uninstalling the app does not
  remove ReShade or the add-on from your game folder. RaceLab, once
  installed from the RaceLab page, stays in your NR2003 folder (with its
  settings and Career saves) until you delete its folder yourself.


================================================================================
  15. CREDITS
================================================================================
  All In One NR2003 exists because of the people below. Their work belongs to
  them. If you enjoy a feature, please thank and support its original author.

  NASCAR RACING 2003 SEASON
    Developed by Papyrus Design Group, published by Sierra. NR2003 and all of
    its content belong to their owners. You need your own copy of the game.

  PROJECT STEELFIRE OVERLAYS  -  by steelhorselive
    The overlay suite this app is built on: the overlays, the data shim and
    bridge, stage racing, the layout and series editors, the hotkeys and the
    mobile pages. This build is NOT the original Project SteelFire Overlays.
    Please support the original author:
      Twitch:  https://twitch.tv/steelhorselive
      X:       https://x.com/SteelHorseLive
      Discord: https://discord.gg/eYZEwpA49j

  RACECONTROL  -  by Jonathon Thomas
    The race control engine: cautions, the pace car, pace laps, wave-arounds,
    the one-to-go wave, the caution line order, start pacing and the track
    map. MIT license.  https://github.com/NR2003-JT/RaceControl

  QUALCONTROL  -  by Jonathon Thomas
    Qualifying control: practice-order timing, saved and re-applied results,
    merging cars into the field. MIT license.
    https://github.com/NR2003-JT/QualControl

  RACEVISION  -  by Jonathon Thomas
    The TV director: cameras, camera sets, broadcast graphics, replays, tape
    transport, smart slow motion, replay wipes, highlights and the overlay
    layout system. MIT license.  https://github.com/NR2003-JT/RaceVision

  AIMOD
    - Adolfo Delgado: the original AIMOD (v1.0.4), with its memory map, pit
      takeover and strategy logic.
    - Jonathon Thomas: AIMOD v2, including the 2.2 features in this build
      (results, radio, racing intensity, rivals).
    MIT license.  https://github.com/NR2003-JT/AIMOD

  AI ENHANCED  -  by NR2003_Ryan
    https://www.reddit.com/user/NR2003_Ryan/
    AI Enhanced v0_2_2b is included. The only change is a small startup patch
    that lets it find a game running under a RaceLab EXE name (see
    section 8). The environment, MultiGroove, awareness and preset features
    in the app follow AI Enhanced's own behavior. All credit for those ideas
    goes to NR2003_Ryan.

  DYNAMIC RUBBER  -  by MMCS
    The NR2003 Dynamic Rubber ReShade add-on (NR2003BodyRubber.addon32) and
    its setup, whose install steps the Dynamic Rubber page follows. The
    add-on is included unchanged.
    It uses:
      - ReShade and d3d8to9 by crosire (Patrick Mours), downloaded from their
        official pages when needed. https://reshade.me/
        https://github.com/crosire/d3d8to9
      - Mark Adler's blast decompressor.

  NR2003 BACKGROUND  -  by NCRDesigns / MiaSquirtle
    Keeping the game's video and sound running when it loses focus.

  RACELAB  -  by Tight_Principle9572
    YouTube: https://youtube.com/@mysimracinggame
    Included unchanged, with permission: the original RaceLab download, its
    game builds (NR2003_RaceLabV2.exe, NR2003_MS.exe), its adapted series
    models, and its own readme, guides and credits. As RaceLab's own readme
    says, the
    original series creators, painters, track authors and contributors keep
    credit for their work, including:
      - the Design Mods Racing Cup11v2 / Cup12 team (Cup12 / Cup12ss),
      - The BullRing's Generation-6 mod (Gen6BR) by Mattias Reinert,
        Jerry Lepage and Danny Coral,
      - Smoke / Jack Hill, Team Om3gA and their collaborators (Cup2000),
      - FCRD (NCS22 v1),
      - Splash N' Go (the 2003-era bodies).
    See each original series' credits for models and paints.

  FONTS AND ARTWORK
    The fonts in the "fonts" folder and the series, track and image artwork
    belong to their respective designers and creators.

  BUILT WITH
    Electron and Chromium (see LICENSE.electron.txt and LICENSES.chromium.html
    in the install folder).

  THE NR2003 COMMUNITY
    Thanks to everyone who keeps NR2003 alive: the series, track, paint and
    tool makers, league organizers, testers and streamers.


================================================================================
  16. LICENSES
================================================================================
  RaceControl, QualControl, RaceVision and AIMOD are released under the MIT
  license. Their license texts, with their copyright notices, are in the
  "licenses" folder:
    licenses\RaceControl - LICENSE.txt   Copyright (c) 2026 Jonathon Thomas
    licenses\QualControl - LICENSE.txt   Copyright (c) 2026 Jonathon Thomas
    licenses\RaceVision - LICENSE.txt    Copyright (c) 2026 Jonathon Thomas
    licenses\AIMOD - LICENSE.txt         Copyright (c) 2026 Adolfo Delgado and
                                         Jonathon Thomas

  RaceLab's own author notices and third-party license texts (for example
  the V8 license in RaceLab\CupVisual) are kept inside the RaceLab package.

  Dynamic Rubber's third-party notices (ReShade's add-on SDK and d3d8to9,
  both BSD licensed, Copyright Patrick Mours) are in
    licenses\Dynamic Rubber - Third-party notices.txt

  All In One NR2003 is provided "as is", without warranty of any kind. Back
  up your NR2003 folder before installing mods.
