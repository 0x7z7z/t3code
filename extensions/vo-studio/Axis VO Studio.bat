@echo off
rem Starts Axis VO Studio in the background and opens it in your browser.
rem Missing Python packages are explained on the page itself. Missing Python
rem gets a message box here, since nothing else could show an error.
py -3.12 -c "" >nul 2>nul || goto nopython
start "" pyw -3.12 "%~dp0server.py"
exit /b 0

:nopython
mshta "javascript:alert('Axis VO Studio needs Python 3.12. Install it from python.org, then open VO Studio again.');close()"
exit /b 1
