# PM Platform Relay

HTTP server that runs on Phil's Mac Mini. Receives chat requests from the deployed PM Platform (Vercel) and answers them by calling the Claude Agent SDK, which authenticates using Phil's Claude.ai subscription via OAuth.

## What it does

```
Browser
  -> Vercel server action (askQuestion)
     -> POST https://<your-tunnel>/chat   (Authorization: Bearer <secret>)
        -> Cloudflare Tunnel
           -> Mac Mini relay (this code)
              -> Claude Agent SDK (using your subscription)
                 -> Tools call Supabase directly:
                    - list_documents(project_id)
                    - read_document(document_id)
                    - search_documents(project_id, query)
```

Claude decides which tools to call to answer the question. The relay returns the final answer to Vercel which renders it in the chat panel.

## One-time setup

### 1. Authenticate the Claude Agent SDK to your subscription

On the Mac Mini, run:

```
claude setup-token
```

This opens a browser, asks you to authorize, and prints a token that begins with `sk-ant-...`. Copy it.

This token is good for one year and lets the SDK draw from your Claude subscription instead of needing a paid Anthropic API key.

### 2. Create relay/.env

```
cd pm-platform/relay
cp .env.example .env
```

Fill in:

| Var | Value |
|---|---|
| `PORT` | `8787` (default fine) |
| `RELAY_SHARED_SECRET` | Generate one: `openssl rand -hex 32`. Save it - you'll also paste it into Vercel. |
| `SUPABASE_URL` | `https://sksfyygufnnbzrmneccx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Same value from `pm-platform/.env.local` |
| `CLAUDE_CODE_OAUTH_TOKEN` | The `sk-ant-...` token from step 1 |
| `CLAUDE_MODEL` | Optional. Default `claude-sonnet-4-5`. |

### 3. Test locally

From `pm-platform/relay/`:

```
npm start
```

You should see `Relay listening on http://127.0.0.1:8787`.

In another terminal:

```
curl http://127.0.0.1:8787/health
```

Should return `{"ok":true,"ts":"..."}`.

Then test a real chat call (replace `<SECRET>` with your `RELAY_SHARED_SECRET`):

```
curl -X POST http://127.0.0.1:8787/chat \
  -H "Authorization: Bearer <SECRET>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "53cff193-21e4-45ff-833d-43813e8578a0",
    "project_name": "Sweet Springs Solar",
    "question": "What is the retainage?"
  }'
```

Should return JSON with `answer`, `tool_calls`, `elapsed_ms`. First call takes ~10-30s (Claude loads tools, lists docs, reads the prime contract).

### 4. Expose the port via Cloudflare Tunnel

Install cloudflared:

```
brew install cloudflared
```

(Or download from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ if you don't have brew.)

Log in to your Cloudflare account (the tunnel CLI opens a browser):

```
cloudflared tunnel login
```

You'll need a Cloudflare account (free) and at least one domain in Cloudflare (e.g. amh.holdings). Free DNS-only domains work.

Create a tunnel:

```
cloudflared tunnel create pm-platform-relay
```

Note the tunnel UUID it prints.

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-uuid>
credentials-file: /Users/amh_holdings/.cloudflared/<tunnel-uuid>.json

ingress:
  - hostname: pm-relay.amh.holdings
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Route the hostname to the tunnel:

```
cloudflared tunnel route dns pm-platform-relay pm-relay.amh.holdings
```

Start the tunnel (foreground for testing):

```
cloudflared tunnel run pm-platform-relay
```

Test from outside:

```
curl https://pm-relay.amh.holdings/health
```

### 5. Set Vercel env vars

In Vercel project settings -> Environment Variables, add:

| Var | Value |
|---|---|
| `RELAY_URL` | `https://pm-relay.amh.holdings` (your tunnel hostname, no trailing slash) |
| `RELAY_SHARED_SECRET` | Same value as in `relay/.env` |

Redeploy or push a commit to trigger a new build.

### 6. Run relay + tunnel as services (auto-start on boot)

After confirming everything works in the foreground, install launchd plists so they survive reboots:

**Relay** - save as `~/Library/LaunchAgents/com.amh.pm-relay.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.amh.pm-relay</string>
  <key>WorkingDirectory</key>
  <string>/Users/amh_holdings/Documents/AMH Claude/pm-platform/relay</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/amh_holdings/.nvm/versions/node/v24.15.0/bin/node</string>
    <string>server.mjs</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/amh_holdings/Library/Logs/pm-relay.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/amh_holdings/Library/Logs/pm-relay.err.log</string>
</dict>
</plist>
```

Then load it:

```
launchctl load ~/Library/LaunchAgents/com.amh.pm-relay.plist
```

**Cloudflare Tunnel** - cloudflared has a built-in installer:

```
sudo cloudflared service install
```

This sets up a launchd service that runs the tunnel.

### 7. Verify the loop end-to-end

Open the deployed PM Platform on your phone, navigate to Sweet Springs, type "What is the retainage?" - should answer in ~10-20 seconds.

## Operational notes

| Item | Detail |
|---|---|
| Logs | Relay: `~/Library/Logs/pm-relay.{out,err}.log`. Tunnel: `~/Library/Logs/com.cloudflare.cloudflared.{out,err}.log` |
| Concurrency | Claude Agent SDK launches a single `claude` subprocess per `query()`. Several concurrent chats will spawn several subprocesses - fine for personal use but watch CPU. |
| Token expiry | `CLAUDE_CODE_OAUTH_TOKEN` is good for 1 year. Re-run `claude setup-token` to refresh. |
| Subscription usage | Each chat round uses your Claude subscription's usage window. Heavy use can hit 5-hour limits. |
| Restarting the relay | `launchctl unload ... && launchctl load ...` or just `launchctl kickstart -k gui/$(id -u)/com.amh.pm-relay` |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Missing required env vars` on startup | Check `relay/.env` exists and has all six values |
| 403 from `/chat` | `RELAY_SHARED_SECRET` mismatch between relay/.env and Vercel env |
| Chat answers with "Could not reach the relay" | Tunnel down or wrong hostname in `RELAY_URL` |
| Long chats hit Vercel timeout | The Vercel-side action has a 120s timeout. If genuinely slow, increase or stream in a future revision. |
| Token expired / authentication_failed | Re-run `claude setup-token` and update `CLAUDE_CODE_OAUTH_TOKEN` in relay/.env |
