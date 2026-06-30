CORAX Agent v3 — развёртывание (без Docker)
==========================================

1. Распакуйте архив в сетевую папку, например \\fileserver\corax\agent\v3\

2. Файл agent_env.bat уже содержит URL сервера и токен — не публикуйте его вне сети.

3. Запуск вручную: дважды щёлкните corax_send.bat
   Или из командной строки: corax_send.bat nopause

4. Планировщик (опционально): после успешного запуска с SCHEDULE_ENABLE=1 в corax_send.bat
   или через register_scheduled_task.ps1 от администратора.

5. API сервер CORAX должен слушать 0.0.0.0:3001 (start_all.bat / backend\start_server.bat).
   INVENTORY_SERVER = http://<IP-сервера>:3001

6. Проверка: в веб-панели CORAX → Компьютеры — появится/обновится запись с расширенным отчётом.
