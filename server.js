// server.js
// Telegram ↔ OpenAI ↔ Microsoft Graph (Outlook)
// Render.com için hazır minimal backend

require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '2mb' }));

// === ENV ===
const {
  PORT = 3000,
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,             // opsiyonel: yoksa gelen chat'e yanıt döneceğiz
  TELEGRAM_SECRET_TOKEN,        // opsiyonel: setWebhook'ta secret_token kullandıysan
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4o-mini',
  GRAPH_TENANT_ID,
  GRAPH_CLIENT_ID,
  GRAPH_CLIENT_SECRET,
  GRAPH_USER_ID,                // izlenecek mailbox (user id veya e-posta)
} = process.env;

const tgApi = TELEGRAM_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_TOKEN}` : null;

// ===== Helpers =====
async function getGraphToken() {
  const url = `https://login.microsoftonline.com/${GRAPH_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id:     GRAPH_CLIENT_ID,
    client_secret: GRAPH_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const { data } = await axios.post(url, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return data.access_token;
}

async function graphGetMessage(messageId) {
  const token = await getGraphToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(GRAPH_USER_ID)}/messages/${encodeURIComponent(messageId)}?$select=subject,from,bodyPreview,conversationId,internetMessageId,replyTo,receivedDateTime`;
  const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
  return data;
}

async function graphReplyToMessage(messageId, replyText) {
  const token = await getGraphToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(GRAPH_USER_ID)}/messages/${encodeURIComponent(messageId)}/reply`;
  await axios.post(url, { comment: replyText }, { headers: { Authorization: `Bearer ${token}` } });
  return true;
}

async function tgSendMessage(text, chatId) {
  if (!tgApi) return;
  const target = chatId || TELEGRAM_CHAT_ID;
  if (!target) return;
  await axios.post(`${tgApi}/sendMessage`, {
    chat_id: target,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

async function openAiDraft(systemPrompt, userPrompt) {
  if (!OPENAI_API_KEY) {
    return '(OPENAI_API_KEY eksik) — örnek: Merhaba, e-postanız için teşekkürler. En kısa sürede dönüş yapacağım.';
  }
  const OpenAI = (await import('openai')).default;
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
  });
  return resp.choices?.[0]?.message?.content?.trim() || 'Taslak üretilemedi.';
}

function parseCommand(text) {
  // Örnekler:
  // /start
  // /oku <messageId>
  // /taslak <messageId> <yönerge>
  // /cevapla <messageId> <yönerge>
  const [cmd, rest] = text.split(/\s+(.+)/);
  if (!cmd) return null;
  const parts = (rest || '').trim().split(/\s+/);
  const messageId = parts.shift();
  const args = (parts || []).join(' ').trim();
  return { cmd, messageId, args };
}

function escapeHtml(str) {
  return String(str).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
}

// ===== Health & root =====
app.get('/', (_req, res) => res.status(200).send('ok'));
app.get('/health', (_req, res) => res.status(200).send('ok'));

// ===== Microsoft Graph Notifications =====
// Validation handshake (GET ?validationToken=...)
app.get('/graph/notifications', (req, res) => {
  const token = req.query.validationToken;
  if (token) return res.status(200).send(token);
  return res.status(200).send('graph notifications');
});

app.post('/graph/notifications', async (req, res) => {
  try {
    const value = req.body?.value || [];
    for (const n of value) {
      const resourceData = n.resourceData || {};
      const messageId = resourceData.id;
      if (!messageId) continue;
      try {
        const msg = await graphGetMessage(messageId);
        const preview = (msg.bodyPreview || '').slice(0, 500);
        await tgSendMessage(
          `<b>Yeni e-posta</b>\n<b>Konu:</b> ${escapeHtml(msg.subject || '')}\n<b>Kimden:</b> ${escapeHtml(msg.from?.emailAddress?.name || '')} &lt;${escapeHtml(msg.from?.emailAddress?.address || '')}&gt;\n<b>Mesaj ID:</b> <code>${messageId}</code>\n\n${escapeHtml(preview)}`
        );
      } catch (e) {
        await tgSendMessage(`Yeni e-posta getirilemedi: ${escapeHtml(e.message)}`);
      }
    }
    res.sendStatus(202);
  } catch (err) {
    console.error('Graph notify error', err);
    res.sendStatus(500);
  }
});

// ===== Telegram Webhook =====
app.post('/telegram/webhook', async (req, res) => {
  try {
    // Opsiyonel secret kontrolü
    if (TELEGRAM_SECRET_TOKEN) {
      const got = req.headers['x-telegram-bot-api-secret-token'];
      if (got !== TELEGRAM_SECRET_TOKEN) return res.sendStatus(401);
    }

    const update = req.body;
    const msg = update.message || update.edited_message;
    if (!msg || !msg.text) return res.sendStatus(200);
    const chatId = msg.chat?.id;

    console.log('Telegram webhook received from chat:', chatId, 'text:', msg.text);

    const parsed = parseCommand(msg.text);
    if (!parsed) return res.sendStatus(200);
    const { cmd, messageId, args } = parsed;

    if (cmd === '/start') {
      await tgSendMessage(
        'Merhaba! Komutlar:\n/oku <messageId>\n/taslak <messageId> <yönerge>\n/cevapla <messageId> <yönerge>',
        chatId
      );
      return res.sendStatus(200);
    }

    if (cmd === '/oku') {
      if (!messageId) {
        await tgSendMessage('Kullanım: /oku <messageId>', chatId);
      } else {
        try {
          const mail = await graphGetMessage(messageId);
          await tgSendMessage(
            `<b>Konu:</b> ${escapeHtml(mail.subject || '')}\n<b>Kimden:</b> ${escapeHtml(mail.from?.emailAddress?.name || '')} &lt;${escapeHtml(mail.from?.emailAddress?.address || '')}&gt;\n<b>Alındı:</b> ${escapeHtml(mail.receivedDateTime || '')}\n\n${escapeHtml((mail.bodyPreview || '').slice(0, 1500))}`,
            chatId
          );
        } catch (e) {
          await tgSendMessage(`Mail getirilemedi: ${escapeHtml(e.message)}`, chatId);
        }
      }
      return res.sendStatus(200);
    }

    if (cmd === '/cevapla' || cmd === '/taslak') {
      if (!messageId) {
        await tgSendMessage('Kullanım: /cevapla <messageId> <yönerge>', chatId);
        return res.sendStatus(200);
      }
      try {
        const mail = await graphGetMessage(messageId);
        const systemPrompt =
          'You are an email assistant. Write concise, polite, and professional Turkish replies unless otherwise requested. Keep thread context, avoid greeting duplication, and preserve a neutral tone.';
        const userPrompt =
          `Girdi yönergesi: ${args || 'kısa ve nazik yanıt'}\n\n` +
          `Önceki mail özeti:\nKonu: ${mail.subject}\n` +
          `Kimden: ${mail.from?.emailAddress?.name} <${mail.from?.emailAddress?.address}>\n` +
          `Özet: ${mail.bodyPreview}`;
        const draft = await openAiDraft(systemPrompt, userPrompt);

        if (cmd === '/taslak') {
          await tgSendMessage(`<b>Taslak:</b>\n\n${escapeHtml(draft)}`, chatId);
        } else {
          await graphReplyToMessage(messageId, draft);
          await tgSendMessage('Yanıt gönderildi ✅', chatId);
        }
      } catch (e) {
        await tgSendMessage(`İşlem başarısız: ${escapeHtml(e.message)}`, chatId);
      }
      return res.sendStatus(200);
    }

    // bilinmeyen komut
    await tgSendMessage('Komut anlaşılamadı. /start yazabilirsin.', chatId);
    res.sendStatus(200);
  } catch (err) {
    console.error('Telegram webhook error', err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});

