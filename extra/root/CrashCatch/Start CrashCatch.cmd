@echo off
rem Starts CrashCatch: it waits for NR2003 and writes a report when the game crashes, closes or freezes.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0catch.ps1"
