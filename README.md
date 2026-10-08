# opencode-mcp-state-saver

OpenCode **v2** плагин: сохраняет состояние MCP-серверов между перезапусками.

Проблема: кнопки Connect/Disconnect в `/mcps` работают только до рестарта
(`connect` — «overriding a disabled configuration until restart»,
`disconnect` — «removing its tools until reconnected»). После перезапуска
сервер снова включается, даже если ты его выключал.

Плагин запоминает твои действия и при каждом старте возвращает серверы
в то состояние, в котором ты их оставил, через `ctx.mcp.transform`
(`disabled: true/false`) + `ctx.mcp.reload()`.

Готового v2-плагина с таким поведением в npm не нашлось
(есть только paseo-плагин `opencode-mcp-toggle` и тематические MCP-плагины) —
поэтому написан этот.

## Как работает

1. При старте читает список выключенных серверов из `ctx.storage`
   (ключ `disabled-servers-v1`) и применяет его трансформацией:
   `editor.update(name, c => { c.disabled = true })`.
2. Импортирует `disabled: true` из `opencode.json(c)` в storage при первом
   запуске, чтобы флаг пережил даже удаление из конфига.
3. Слушает события `mcp.status.changed` (+ `mcp.tools.changed`,
   `mcp.resources.changed` как fallback) и раз в 3 секунды сверяется
   с `ctx.mcp.list()`:
   - статус `disabled` → добавить в storage (сохранить «выключен»);
   - статус `connected` → убрать из storage (сохранить «включён»);
   - `pending` / `failed` / `needs_auth` игнорируются — это не действие
     пользователя.
4. После изменения вызывает `ctx.mcp.reload()`, чтобы трансформация
   пересчиталась и состояние пережило рестарт.
5. Чистит storage от серверов, которых больше нет ни в конфиге, ни в рантайме.

Первые ~8 секунд после старта синхронизация пропущена (grace window):
серверы переходят `pending → connected`, и это не должно считаться
нажатием «connect».

## Установка

Вариант A — глобально для всех проектов:

```sh
# скопировать папку плагина
cp -r savemcpstate ~/.config/opencode/plugins/mcp-state-saver
```

Плагины из `~/.config/opencode/plugins/` подхватываются автоматически.
Либо явно через конфиг:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./plugins/mcp-state-saver"], // путь от файла конфига
}
```

Вариант B — только для одного проекта:

```sh
cp -r savemcpstate .opencode/plugins/mcp-state-saver
```

## Проверка

1. `opencode mcp list` — запомни состояние.
2. Открой OpenCode, `/mcps`, выключи сервер.
3. Подожди ~5 секунд (чтобы плагин успел записать в storage).
4. `opencode service restart`.
5. `opencode mcp list` — сервер должен остаться выключенным.

Включи обратно — после рестарта он останется включённым.

## Опции

```jsonc
{
  "plugins": [{ "package": "./plugins/mcp-state-saver", "options": { "pollMs": 3000, "verbose": true } }],
}
```

| Опция     | По умолчанию | Описание                              |
| --------- | ------------ | ------------------------------------- |
| `pollMs`  | `3000`       | Интервал сверки с `mcp.list()` (мин 500) |
| `verbose` | `false`      | Логи `[mcp-state-saver]` в консоль сервера  |

## Ограничения

- Состояние хранится в `ctx.storage` плагина (per-location). Глобальный
  сервер, выключенный в одном проекте, в другом проекте может остаться
  включённым — это семантика location-scoped MCP в OpenCode.
- Ошибки запуска (`failed`) и ожидание OAuth (`needs_auth`) не сохраняются.
