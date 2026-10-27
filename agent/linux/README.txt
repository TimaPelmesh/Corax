CORAX Linux Agent (bash) 3.2.0
==============================

Полная инструкция:
  панель CORAX → База знаний → Документация → «Linux-агент» и «Аудит серверов»
  репозиторий: docs/agents.md

БЕЗОПАСНОСТЬ (обязательно)
--------------------------
- Агент НЕ читает и НЕ пишет server backend/.env и БД.
- Временные файлы ТОЛЬКО в /tmp/corax-agent.* (с маркером .corax_workdir).
- Cleanup удаляет ТОЛЬКО этот temp-каталог — никогда /opt, .env, volumes.
- Запрещён запуск из дерева CORAX-сервера (/opt/corax/... с docker-compose.yml,
  backend/.env или run.py), пока не задан CORAX_AGENT_ALLOW_IN_SOURCE=1
  (не рекомендуется на проде).

ДВА КАТАЛОГА — НЕ ПУТАТЬ
------------------------
  /opt/corax         = СЕРВЕР (git + Docker). Агент ОТСЮДА НЕ ЗАПУСКАТЬ.
  /opt/corax-agent   = только ZIP агента. Сюда распаковывать и запускать.

Что уже ломалось на практике
----------------------------
1) Запуск из /opt/corax/agent/linux (исходники git без agent_env.sh из панели)
   → POST на плейсхолдер __INVENTORY_SERVER__, HTTP 000, пустой каталог агента.
   → На проде казалось, что «env/сервис сдох». Агент env сервера не трогает;
     поднимайте Docker: cd /opt/corax && docker compose up -d
     (не правьте .env/БД без бэкапа). Файлы agent/linux: git checkout -- agent/linux
     или новый ZIP с панели.

2) Копирование agent_env.sh.example без правки URL/токена
   → агент откажется стартовать (EXIT 2). Нужен ZIP из панели.

3) URL 127.0.0.1 в сборке
   → отчёт не доходит с других хостов. Собирайте агент, открыв панель по LAN-IP.

4) unzip -o нового ZIP поверх живого /opt/corax-agent
   → затирает agent_env.sh (URL/токен). Обновляйте скрипты так:
     unzip -d /tmp/corax-agent-new ...
     /bin/sh /opt/corax-agent/update_scripts.sh /tmp/corax-agent-new
     или: unzip -o new.zip -x agent_env.sh -d /opt/corax-agent

Запуск одной командой
---------------------
1. Панель → Сборка агента → Linux → «Команда установки»
2. На хосте вставить одну строку (sudo python3 -c '...')
   Команда сама создаёт /opt/corax-agent, пишет токен и запускает службу.
   Либо на панели «Поставить по SSH» (пароль не сохраняется).
ZIP с панели — запасной путь:
     sudo mkdir -p /opt/corax-agent
     sudo unzip -o corax-agent-linux-*.zip -d /opt/corax-agent
     cd /opt/corax-agent
     sudo ./corax_send.sh

Файлы
-----
  corax_send.sh       — один токен на кластер: сразу шлёт отчёт и ставит службу аудита
  run_console.sh      — полный инвентарь в «Компьютеры»
  inventory_agent.sh  — ядро инвентаря
  audit_agent.sh      — одна точка аудита (corax_send вызывает его)
  agent_env.sh        — URL + токен (генерируется панелью в ZIP; НЕ коммитить)
  agent_env.sh.example — шаблон без секретов (в git)
  agent_config.json   — модули
  install_cron.sh     — cron
  systemd/            — timer
  update_scripts.sh   — скачать скрипты с панели в 04:00, не трогая agent_env.sh

Расписание
----------
  sudo ./corax_send.sh
    сразу один отчёт и служба corax-audit.service
    интервал берётся из CORAX_AUDIT_INTERVAL в agent_env.sh, затем из вкладки «Аудит серверов»
  sudo ./install_cron.sh
    инвентарь — понедельник 09:15
    аудит — та же служба; минутный cron только поднимает её, если она остановилась
    скрипты — каждый день в 04:00 по часам хоста (update_scripts.sh)

Аудит серверов
--------------
Один ZIP (один agent_env.sh, один токен) распаковывают на все серверы. Хост появляется сам после первого corax_send.
Интервал 15 или 30 секунд держит служба, а не минутный cron. Смена интервала в панели подхватывается на следующем такте.
Кнопка «Управление» на карточке — только проверка, статус, перезапуск из списка и файлы из списка. Произвольной команды нет.
Нужен python3 (на Debian: apt install python3). Датчики полнее, если стоит lm-sensors.
Полный учёт (ОС, диски, ПО) по-прежнему уходит в «Компьютеры».
Lock обновления скриптов: /opt/corax-agent/.corax-update.lock (не /tmp).

Секреты
-------
- Не коммитьте agent_env.sh, backend/.env, cookies, пароли в чаты/issues.
- Репозиторий публичный: только *.env.example и плейсхолдеры.
- Если пароль/токен светили — смените admin-пароль и отзовите токены в UI.
