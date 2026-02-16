# Nieu Growth — Client Acquisition Audit

AI-powered client acquisition audit landing page for audit.nieugrowth.com.

## Architecture

- **Frontend**: Static HTML/CSS/JS landing page with embedded chat widget
- **Backend**: Netlify serverless function (`/api/chat`) calling Gemini API
- **Hosting**: Netlify

## Deploy to Netlify

### Option A: CLI Deploy

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Login
netlify login

# Create new site
netlify init

# Set environment variables
netlify env:set GEMINI_API_KEY "your-gemini-api-key"
netlify env:set GEMINI_MODEL "gemini-3-pro-preview"

# Deploy
netlify deploy --prod
```

### Option B: GitHub → Netlify

1. Push this repo to GitHub
2. Go to [app.netlify.com](https://app.netlify.com) → "Add new site" → "Import from Git"
3. Select the repo
4. Build settings are auto-detected from `netlify.toml`
5. Go to **Site settings → Environment variables** and add:
   - `GEMINI_API_KEY` = your Gemini API key
   - `GEMINI_MODEL` = `gemini-3-pro-preview`
6. Deploy

### Custom Domain

1. In Netlify dashboard → **Domain management** → **Add custom domain**
2. Enter `audit.nieugrowth.com`
3. Add a CNAME record in your DNS:
   - Type: `CNAME`
   - Name: `audit`
   - Value: `your-netlify-site.netlify.app`
4. Netlify will auto-provision SSL

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Google Gemini API key |
| `GEMINI_MODEL` | Yes | Gemini model ID (e.g., `gemini-3-pro-preview`) |

## File Structure

```
├── netlify.toml              # Netlify config
├── netlify/
│   └── functions/
│       └── chat.js           # Serverless function (Gemini API proxy)
├── public/
│   └── index.html            # Landing page + chat widget
└── README.md
```

## Customization

- **System prompt**: Edit the `SYSTEM_PROMPT` constant in `netlify/functions/chat.js`
- **Styling**: All CSS is inline in `public/index.html` using CSS custom properties
- **Booking link**: Update the Google Calendar URL in the iframe and system prompt
