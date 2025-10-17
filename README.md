# Mail ↔ Telegram ↔ ChatGPT Bridge (Render Deploy)

Bu depo, gelen Outlook maillerinizi Telegram'a özet olarak iletir; Telegram'dan `/cevapla` komutu ile OpenAI üzerinden yanıt taslağı üretip aynı thread'e cevap atar.

## Çalıştırma (Render)
- Start Command: `node server.js`
- Env değişkenlerini `.env.example`'a göre ekle.
- Sağlık kontrolü: `/health` → `ok`

## Telegram
- BotFather ile bot oluştur, token'ı `TELEGRAM_TOKEN` olarak gir.
- Chat ID'yi @userinfobot'tan al → `TELEGRAM_CHAT_ID`.
- Webhook: `https://api.telegram.org/bot<token>/setWebhook?url=<render_url>/telegram/webhook&secret_token=<TELEGRAM_SECRET_TOKEN>`

## Microsoft Graph
- Uygulama kaydet, `Mail.Read`, `Mail.Send`, `MailboxSettings.Read` application permissions.
- `GRAPH_*` env değerlerini ayarla.
- Subscription POST: `resource=/me/messages`, `notificationUrl=<render>/graph/notifications`.
