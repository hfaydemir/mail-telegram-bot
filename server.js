// server.js
// Minimal Node.js backend: Telegram ↔ OpenAI ↔ Microsoft Graph (Outlook)
// Deploy-ready for Render.com

require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '2mb' }));

// === ENV ===
const {
  PORT = 3000,
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID,
  TELEGRAM_SECRET_TOKEN, // optional: Telegram setWebhook `secret_token`
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4o-mini',
  GRAPH_TENANT_ID,
  GRAPH_CLIENT_ID,
  GRAPH_CLIENT_SECRET,
  GRAPH_USER_ID, // mailbox owner: user id or email (e.g., 'user@domain.com')
} = process.env;

// === Helpers ===
const tgApi = TELEGRAM_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_TOKEN}` : null;

async function getGraphToken() {
  const url = `https://login.microsoftonline.com/${GRAPH_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: GRAPH_CLIENT_ID,
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
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(GRAPH_USER_ID)}/messages/${encodeURIComponent(messageId)}/reply`; // keeps the thread
  await axios.post(url, { comment: replyText }, { headers: { Authorization: `Bearer ${token}` } });
  return true;
}

async function tgSendMessage(text) {
  if (!tgApi || !TELEGRAM_CHAT_ID) return;
  await axios.post(`${tgApi}/sendMessage`, {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

async function openAiDraft(systemPrompt, userPrompt) {
  if (!OPENAI_API_KEY) {
    return '(OPENAI_API_KEY missing) – örnek taslak: Merhaba, e-postanız için teşekkürler. En kısa sürede dönüş yapacağım.';
  }
  const OpenAI = (await import('openai')).default; // dynamic import to keep CJS
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
  // Supported examples:
  // /cevapla <messageId> <yönerge>
  // /taslak <messageId> <yönerge>
  // /oku <messageId>
  const [cmd, rest] = text.split(/\s+(.+)/);
  if (!cmd) return null;
  const parts = (rest || '').trim().split(/\s+/);
  const messageId = parts.shift();
  const args = (parts || []).join(' ').trim();
  return { cmd, messageId, args };
}

// === Health ===
app.get('/health', (_req, res) => res.status(200).send('ok'));

// === Microsoft Graph Notifications ===
// Validation handshake for webhook (GET with validationToken)
app.get('/graph/notifications', (req, res) => {
  const token = req.query.validationToken;
  if (token) return res.status(200).send(token); // echo token as plain text
  return res.status(200).send('graph notifications');
});

// Receive change notifications for new messages
app.post('/graph/notifications', async (req, res) => {
  try {
    const value = req.body?.value || [];
    for (const n of value) {
      // n.resource: e.g., "/users/{id}/messages/{messageId}"
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
        await tgSendMessage(`Yeni e-posta alındı fakat getirilemedi: ${e.message}`);
      }
    }
    res.sendStatus(202);
  } catch (err) {
    console.error('Graph notify error', err);
    res.sendStatus(500);
  }
});

// === Telegram Webhook ===
app.post('/telegram/webhook', async (req, res) => {
  try {
    // Optional: verify Telegram secret token (set when calling setWebhook)
    if (TELEGRAM_SECRET_TOKEN) {
      const got = req.headers['x-telegram-bot-api-secret-token'];
      if (got !== TELEGRAM_SECRET_TOKEN) return res.sendStatus(401);
    }

    const update = req.body;
    const msg = update.message || update.edited_message;
    if (!msg || !msg.text) return res.sendStatus(200);

    const { cmd, messageId, args } = parseCommand(msg.text);
    if (!cmd) return res.sendStatus(200);

    if (cmd === '/oku') {
      if (!messageId) {
        await tgSendMessage('Kullanım: /oku <messageId>');
      } else {
        try {
          const mail = await graphGetMessage(messageId);
          await tgSendMessage(
            `<b>Konu:</b> ${escapeHtml(mail.subject || '')}\n<b>Kimden:</b> ${escapeHtml(mail.from?.emailAddress?.name || '')} &lt;${escapeHtml(mail.from?.emailAddress?.address || '')}&gt;\n<b>Alındı:</b> ${escapeHtml(mail.receivedDateTime || '')}\n\n${escapeHtml((mail.bodyPreview || '').slice(0, 1500))}`
          );
        } catch (e) {
          await tgSendMessage(`Mail getirilemedi: ${e.message}`);
        }
      }
    }

    if (cmd === '/cevapla' || cmd === '/taslak') {
      if (!messageId) {
        await tgSendMessage('Kullanım: /cevapla <messageId> <yönerge>');
      } else {
        try {
          const mail = await graphGetMessage(messageId);
          const systemPrompt = `You are an email assistant. Write concise, polite, and professional Turkish replies unless otherwise requested. Keep thread context, avoid greeting duplication, and preserve a neutral tone.`;
          const userPrompt = `Girdi yönergesi: ${args || 'kısa ve nazik yanıt'}\n\nÖnceki mail özeti:\nKonu: ${mail.subject}\nKimden: ${mail.from?.emailAddress?.name} <${mail.from?.emailAddress?.address}>\nÖzet: ${mail.bodyPreview}`;
          const draft = await openAiDraft(systemPrompt, userPrompt);

          if (cmd === '/taslak') {
            await tgSendMessage(`<b>Taslak:</b>\n\n${escapeHtml(draft)}`);
          } else {
            await graphReplyToMessage(messageId, draft);
            await tgSendMessage('Yanıt gönderildi ✅');
          }
        } catch (e) {
          await tgSendMessage(`İşlem başarısız: ${e.message}`);
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Telegram webhook error', err);
    res.sendStatus(500);
  }
});

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
