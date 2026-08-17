CORAX Windows-агент (Win7 + Win10/11) — один ZIP
================================================

Полная инструкция:
  панель CORAX → База знаний → Руководство → «Агент инвентаризации»
  репозиторий: docs/agents.md

corax_send.bat смотрит версию PowerShell и запускает:
  win10\   если PowerShell 5+   (Windows 10 / 11)
  win7\    иначе                (Windows 7, 8 или старый PS)

НЕЛЬЗЯ запускать из дерева СЕРВЕРА CORAX (рядом с docker-compose.yml,
backend\.env или run.py). Распакуйте этот ZIP в ОТДЕЛЬНУЮ папку:

  %ProgramData%\CORAX\agent
  или \\fileserver\corax\agent

Первый запуск
-------------
1. agent_env.bat уже содержит URL сервера и токен. Не публикуйте его.
2. Двойной клик corax_send.bat  (или: corax_send.bat nopause)
3. Расписание: install_schedule.bat от администратора (если есть в ZIP)
   или register_scheduled_task.ps1
   Задача CORAX-Agent всегда стартует корневой corax_send.bat.
4. URL сервера — LAN-адрес панели, не 127.0.0.1 и не Docker 172.x.

Что внутри
----------
  corax_send.bat        — запускать ЭТО (автовыбор Win7 / 10/11)
  agent_env.bat         — URL + токен (не затирать при обновлении)
  agent_config.json     — модули сбора
  update_scripts.bat    — обновить скрипты, сохранив agent_env.bat
  win10\                — PowerShell 5+
  win7\                 — Windows 7 / старый PowerShell

Обновление (не повторяйте ошибку Linux-агента)
----------------------------------------------
Нельзя unzip -o / «с заменой» нового архива поверх живой папки:
это затирает agent_env.bat и ломает прод, пока не соберёте пакет заново.

  1. Новый ZIP с панели распаковать во временную папку
  2. Из ЖИВОЙ папки:
       update_scripts.bat C:\temp\new-extract
  3. agent_env.bat (URL + токен) остаётся на месте

Или копируйте только win10\ win7\ corax_send.bat — agent_env.bat не трогайте.

HTTPS: после включения TLS на сервере скачайте ZIP заново (https://).

API: POST {INVENTORY_SERVER}/api/v1/agent/inventory
     Authorization: Bearer <token>
