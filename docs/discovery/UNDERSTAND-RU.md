# Подходит ли вам Qoopia?

Reviewed: 2026-09-14. Qoopia V1.


## Когда Qoopia полезна?

Когда несколько агентов или инструментов работают над одним проектом и им нужна общая долговременная память с заданными правами. Если вам достаточно одного Claude или ChatGPT, дополнительная система может быть избыточной. Qoopia дополняет эти продукты, а не заменяет модели и подписки.

Sources: [src/agent-kit/OPERATIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/OPERATIONS.md), [docs/MEMORY-V1.md](https://github.com/qoopia/qoopia-source/blob/main/docs/MEMORY-V1.md)


## Что можно переносить между Claude и Codex?

Подключённый агент сохраняет решение по проекту в ноту; другой агент с нужными правами находит её в той же памяти Qoopia. Нативные интеграции Claude Code и Codex также поддерживают сохранение и восстановление сессий после настройки. Сам по себе MCP не копирует все браузерные переписки и не открывает все личные ноты. Нативное сохранение охватывает видимые события переписки, а не скрытые рассуждения; восстановление использует сохранённый контекст и недавние события, не смешивая неоднозначные сессии.

Sources: [docs/MEMORY-V1.md](https://github.com/qoopia/qoopia-source/blob/main/docs/MEMORY-V1.md), [src/agent-kit/MCP-CONNECTIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/MCP-CONNECTIONS.md)


## Можно начать с телефона?

С телефона можно изучить Qoopia или попросить модель оценить эту страницу. Чат без доступа к компьютеру не установит приложение на Mac или Linux. Для установки нужен поддерживаемый компьютер или свой сервер. Облачному MCP-клиенту нужен доступный HTTPS-адрес; подключение ChatGPT Web/Desktop остаётся экспериментальным и зависит от возможностей аккаунта. Для установки можно настроить внешний доступ; локальный компьютер должен оставаться включённым и подключённым к сети. После подключения поддерживаемый облачный клиент получает разрешённый доступ к памяти из своего интерфейса.

Sources: [src/agent-kit/MCP-CONNECTIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/MCP-CONNECTIONS.md), [docs/v1-setup.md](https://github.com/qoopia/qoopia-source/blob/main/docs/v1-setup.md)


## Может мой агент установить всё за меня?

Если на нужном компьютере уже работает Codex или Claude Code, передайте ему задание из инструкции. Один чат на телефоне этого не сделает. Сначала прочитайте задание: оно поручает агенту проверить совместимость и выбранный релиз, установить Qoopia и проверить подключения. Входы и разрешения подтверждаете вы. Если проверка не прошла, настройка не закончена — используйте раздел устранения проблем. Оценка ссылки не разрешает выполнять её команды. Не передавайте доступы к посторонним аккаунтам.

Sources: [marketing-site/install-agent.js](https://github.com/qoopia/qoopia-source/blob/main/marketing-site/install-agent.js), [src/agent-kit/MCP-CONNECTIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/MCP-CONNECTIONS.md)


## Что нужно для установки?

Текущие пакеты V1 поддерживают Mac на Apple Silicon с macOS 15 и новее и Linux x64 с glibc 2.34 и новее. Intel Mac, Windows и отдельная установка на телефон этими пакетами не поддерживаются. Отдельно устанавливать Bun, Docker или Ollama не требуется. Регистрация профиля на сайте не разворачивает личную память. Локальный поиск и embeddings включены в пакет; доступ к облачной модели авторизуется отдельно.

Sources: [docs/v1-setup.md](https://github.com/qoopia/qoopia-source/blob/main/docs/v1-setup.md), [marketing-site/docs.html](https://github.com/qoopia/qoopia-source/blob/main/marketing-site/docs.html)


## Где данные и какие нужны доступы?

Память хранится в вашей установке на компьютере или вашем сервере. Вход владельца, авторизация модельной подписки и доступ MCP-клиента — разные разрешения. Встроенные embeddings и поиск по словам работают локально; включённые облачные модельные функции передают выбранному провайдеру необходимый им контекст. Локальная база не означает, что все функции работают офлайн. Авторизованные MCP-клиенты могут получать разрешённые данные, а мосты передают выбранные материалы через инфраструктуру доставки. Перед работой с чувствительной информацией проверьте включённые подключения.

Sources: [docs/MEMORY-V1.md](https://github.com/qoopia/qoopia-source/blob/main/docs/MEMORY-V1.md), [src/agent-kit/OPERATIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/OPERATIONS.md)


## Qoopia бесплатна?

Публичные исходники доступны по лицензии MIT. Подписки на модели и аренда своего сервера оплачиваются отдельно; Qoopia не даёт безлимитного использования моделей и не отменяет ограничения провайдеров. Локальный поиск работает без модельной оценки. Перед подключением подписки проверьте актуальные условия провайдера и возможности аккаунта.

Sources: [LICENSE](https://github.com/qoopia/qoopia-source/blob/main/LICENSE), [docs/MEMORY-V1.md](https://github.com/qoopia/qoopia-source/blob/main/docs/MEMORY-V1.md)


## Что такое «Мой Qoopia агент»?

Это агент для работы с вашей средой Qoopia, с Codex или Claude Code, авторизованным через вашу подходящую подписку и явно выданными правами. С управляемым агентом можно взаимодействовать через дашборд; для Telegram нужен настроенный собственный бот. Назначить существующего агента стюардом — не то же самое, что запустить постоянно работающий процесс. Настройка, авторизация провайдера и проверка остаются необходимыми.

Sources: [src/delivery/steward.ts](https://github.com/qoopia/qoopia-source/blob/main/src/delivery/steward.ts), [src/agent-kit/OPERATIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/OPERATIONS.md)


## Можно соединить две независимые среды?

Мосты позволяют выборочно обмениваться материалами между отдельными установками Qoopia. Вы выбираете приглашение, материалы и разрешения. Публикация названий и описаний каталога отличается от передачи содержимого файлов. Полученное не устанавливается и не попадает в обычную память автоматически; уже полученную копию нельзя отозвать. Более широкая автоматически связанная сеть агентов — будущее направление, не обещание текущей V1.

Sources: [src/bridges/service.ts](https://github.com/qoopia/qoopia-source/blob/main/src/bridges/service.ts), [src/agent-kit/OPERATIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/OPERATIONS.md)


## Что значит упаковать скилл?

Qoopia позволяет упаковать явную процедуру: назначение, входы, выходы, шаги, проверку, обработку ошибок, откат и запрашиваемые возможности. У пакета есть версия и сведения для проверки целостности. Это делает рабочую процедуру проверяемой и переносимой, но не гарантирует безопасность любого скрипта, совместимость или разрешение на запуск у получателя.

Sources: [src/skills/format.ts](https://github.com/qoopia/qoopia-source/blob/main/src/skills/format.ts), [src/skills/import-review.ts](https://github.com/qoopia/qoopia-source/blob/main/src/skills/import-review.ts)


## Что такое AgentComm?

AgentComm сохраняет обмен сообщениями между авторизованными агентами в системе. Пользователь может посмотреть общение, а не полагаться только на финальный пересказ агента. Отправка сообщения не доказывает, что адресат его прочитал или выполнил; агенты и каналы доставки должны быть подключены и работать. Обмен можно просматривать в дашборде.

Sources: [src/agent-kit/qoopia-protocol.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/qoopia-protocol.md)


## Что делать при сбое или отказе от Qoopia?

Сохранённая настройка или успешный вход ещё не доказывают, что подключение работает. Используйте раздел устранения проблем и проверку реального клиента. Перед обновлением, переносом или удалением установки сохраните резервную копию данных по инструкции вашей версии. Отзыв доступа клиента отличается от удаления его локальной настройки. Не удаляйте единственную копию памяти при исправлении проблем. Лицензия MIT предоставляет ПО как есть, без гарантий.

Sources: [src/agent-kit/OPERATIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/OPERATIONS.md), [src/agent-kit/MCP-CONNECTIONS.md](https://github.com/qoopia/qoopia-source/blob/main/src/agent-kit/MCP-CONNECTIONS.md), [LICENSE](https://github.com/qoopia/qoopia-source/blob/main/LICENSE)
