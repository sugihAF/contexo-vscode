@echo off
rem Exists ONLY so WP-1.7 can test that discovery rejects .cmd/.bat/.ps1 candidates with
rem 'point contexo.path at ctx.exe' (E35): Node refuses to spawn .cmd/.bat with shell:false
rem (CVE-2024-27980) and shell:true is banned. Tests on Windows use node + prefixArgs.
node "%~dp0..\fake-ctx.mjs" %*
