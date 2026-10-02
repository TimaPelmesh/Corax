# Corax для Windows 10 и 11

Окно сотрудника: заявки, телефонный справочник, запуск агента инвентаризации.

Сборка, шаблон для панели и проверка слота — в [docs/windows-client.md](../../docs/windows-client.md).

```powershell
dotnet publish -c Release
```

Готовый EXE скопировать в `prebuilt\Corax.template.exe`. Сжатие single-file не включать: иначе панель не найдёт слот с адресом сервера.
