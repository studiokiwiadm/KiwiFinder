@echo off
rem Sobe o servidor Node do KiwiFinder e abre o navegador.
rem Este prototipo nao tem nenhuma dependencia externa (sem node_modules),
rem entao nao ha npm install a fazer aqui - so rodar o server direto.

cd /d "%~dp0"

rem Se ja houver algo na 4173, apenas abre o navegador.
netstat -ano | findstr ":4173 " | findstr LISTENING >nul 2>&1
if %errorlevel%==0 (
  echo Servidor ja estava rodando.
  start "" "http://localhost:4173/"
  exit /b
)

start "servidor kiwifinder" /min cmd /c "node server\index.js"

rem Espera o servidor responder antes de abrir o navegador.
for /l %%i in (1,1,30) do (
  netstat -ano | findstr ":4173 " | findstr LISTENING >nul 2>&1
  if not errorlevel 1 goto pronto
  ping -n 2 127.0.0.1 >nul
)

:pronto
start "" "http://localhost:4173/"
echo.
echo Servidor rodando em http://localhost:4173/
echo Fechar a janela minimizada "servidor kiwifinder" encerra o servidor.
