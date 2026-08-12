# Vidia.V2

White-glove WhatsApp booking & AI assistant SaaS.

## Local

```bash
npm install
npm run dev
```

## Vercel

Do not upload `.env`. Add these in **Project → Settings → Environment Variables**:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | from local `.env` |
| `SUPABASE_SERVICE_ROLE_KEY` | from local `.env` |
| `ADMIN_PASSWORD` | from local `.env` |
| `NODE_ENV` | `production` |
| `OPENAI_API_KEY` | from local `.env` (recommended) |
| `PUBLIC_WEBHOOK_BASE_URL` | `https://your-app.vercel.app` |

After deploy, set the Twilio WhatsApp webhook to:

`https://your-app.vercel.app/webhook/whatsapp`
