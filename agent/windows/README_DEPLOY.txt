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
2. Двойной клик corax_send.bat — окно пишет "Collecting inventory..."
   и закроется само, когда отчёт уйдёт (обычно до минуты).
   В конце на экране status: OK или FAILED.
   Тот же статус в файле corax-last-run.txt рядом с агентом.
   Полностью без окна: corax_send_silent.vbs
   Консоль со сборкой: corax_send.bat visible
3. На рабочем столе появится ярлык «Оставить заявку»:
   {INVENTORY_SERVER}/h#pc=ИМЯ-ЭТОГО-ПК
4. Расписание: install_schedule.bat от администратора (если есть в ZIP).
   Он регистрирует задачу SYSTEM (без окна у пользователя) и сразу
   запускает первый отчёт. Дальше — по расписанию.
5. Проверка: панель → Компьютеры (hostname, «последний отчёт»),
   ярлык на столе, corax-last-run.txt со status: OK
6. URL сервера — LAN-адрес панели, не 127.0.0.1 и не Docker 172.x.

Что внутри
----------
  corax_send.bat        — ручной запуск: ждёт конца, показывает status
  corax_send_silent.vbs — без окна (Планировщик и тихий запуск)
  corax-last-run.txt    — появляется после запуска (OK / FAILED)
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

Или копируйте только win10\ win7\ corax_send.bat corax_send_silent.vbs
— agent_env.bat не трогайте.

HTTPS: после включения TLS на сервере скачайте ZIP заново (https://).

API: POST {INVENTORY_SERVER}/api/v1/agent/inventory
     Authorization: Bearer <token>
