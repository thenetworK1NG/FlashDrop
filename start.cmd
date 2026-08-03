@echo off
rem QuickShare phone app is served by J.A.R.V.I.S. on port 8001 (login API + app).
rem Make sure jarvis.py is running first, then open this page:
start "" http://127.0.0.1:8001/wetransferphoneapp/
echo.
echo If the page fails to load, start J.A.R.V.I.S. first:
echo     python jarvis.py
echo On your phone, open:  http://<your-PC-IP>:8001/wetransferphoneapp/
