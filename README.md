# WABA Template Studio (Exotel)

A local, offline-first editor for **WhatsApp Business (WABA) message templates** on
**[Exotel](https://exotel.com)**. Write a template in a rich-text editor, see exactly how it will
look on a phone, catch Meta's common rejection reasons before you submit, and register it on your
Exotel account for Meta's approval. The status then updates on screen by itself when Meta approves
or rejects it.

It runs entirely on your own computer: one Node.js file and one HTML page, **no database, no
`npm install`, no build step and no dependencies**. Your Exotel credentials never leave your machine
except to call Exotel's own API.

## What it does

- **Rich-text template editor**: bold, italic, strikethrough, lists, quotes, emojis and
  `{{1}}`-style variables, written in WhatsApp's own formatting so what you see is what is sent.
- **Live phone preview** of the message, header media, footer and buttons as the customer will see it.
- **Every template type**: text, image, video or PDF headers, **carousels** (2–10 swipeable cards,
  which Exotel only supports through the API) and **authentication / OTP** templates.
- **Media samples upload automatically**: pick a JPG, PNG, MP4 or PDF and it is uploaded to Exotel as
  the review sample Meta requires.
- **Pre-submit checks** that flag the usual reasons Meta rejects templates (missing sample values,
  bad variable placement, length limits, button rules) before you spend a review cycle.
- **Approval tracking without setup**: pending templates are re-checked with Exotel every few minutes,
  and an optional webhook gives instant updates.
- **Template library**: search, filter by status, sync everything already on your WABA, and clone a
  rejected template into a fixed `_v2`.
- **Multiple Exotel accounts**: save several account profiles and switch between them when
  registering templates for different businesses or WABAs.
- **Copy JSON / Copy cURL** to reuse the exact Exotel request in Postman, Power Automate and similar tools.
- **Safe by default**: the editor only listens on `127.0.0.1`. Only the separate webhook port is ever
  meant to be exposed, and the API token is never sent back to the browser.

## Installation

**Requirements:** macOS, Windows 10/11 or Linux, and an Exotel account with WhatsApp enabled
(API key, API token, Account SID and WABA ID). Node.js 18+ is used if you have it; if you don't, the
launcher downloads a private copy for you.

### Option A — download (no tools needed)

1. On this page, click **Code → Download ZIP** and unzip it anywhere (for example your Documents folder).
2. Open the unzipped folder and double-click the launcher for your computer (see **Start it** below).

### Option B — clone with git

```bash
git clone https://github.com/nikx118/exotel-waba-template-studio.git
cd exotel-waba-template-studio
node server.js          # Node 18+; or double-click the launcher instead
```

To update later: `git pull` (or download the ZIP again and copy your old `data` folder into it).

Your browser opens **http://localhost:3000**. Then add your Exotel details in **Settings** (section 2).

---

## 1. Start it — double-click

| Computer | Double-click |
|---|---|
| **Mac** | `Start (Mac).command` |
| **Windows** | `Start (Windows).bat` |

Your browser opens the editor. Keep the small black window open while you work; close it to stop.

- **No Node.js on the computer?** The first start downloads a private copy into a `.runtime` folder
  inside this app (about 30–45 MB, takes under a minute). It checks the download against the
  checksum nodejs.org publishes, needs no admin rights and installs nothing system-wide. Later starts are instant.
- **Mac says it "can't be opened because it is from an unidentified developer"** — right-click the
  file → **Open** → **Open**. You only need to do this once.
- **Windows shows "Windows protected your PC"** — click **More info** → **Run anyway**.
- Double-clicked it twice? The second one just opens the browser to the copy already running.
- Port 3000 busy? It moves to the next free port by itself.

From a terminal it's still just `node server.js` (Node 18+). On Linux: `bash "Start (Mac).command"`.

### Sharing the app with a colleague

Send them the link to this repository. If you zip your own copy instead, leave out the `data` and
`.runtime` folders: `data/config.json` holds *your* Exotel token. They double-click the launcher and
enter their own details in Settings.

## 2. Add your Exotel details (Settings tab)

| Field | Where to find it |
|---|---|
| API key, API token, Account SID | my.exotel.com → **API Settings** |
| WABA ID | Your WhatsApp Business Account ID (Exotel WhatsApp section or Meta WhatsApp Manager) |
| Region | **India — Mumbai** (`api.in.exotel.com`) for Indian accounts, or Singapore |

Press **Save & test connection**. Green = Exotel accepted your credentials.

Saved in `data/config.json` on this computer only. The token is never sent back to the browser.

### Several Exotel accounts

Settings → **Accounts** keeps one profile per Exotel account. Type a name and press **Add account**, then
fill in its details and **Save & test connection**. Switch accounts from that list or from the **Account**
menu in the top bar. Submitting, **Sync** and media uploads always use the selected account; the line under
the Submit button and the confirmation both name it.

- The **Templates** tab shows the selected account's templates; choose **All accounts** to see every one.
- Pending templates are re-checked on every saved account, not only the selected one.
- Samples you uploaded are uploaded again when you switch, because a media handle only works on the account
  that issued it. A handle you pasted by hand is not, so re-check it after switching.
- Deleting an account only removes its saved credentials. Its templates stay in the list and nothing changes on Exotel.
- The webhook URL and secret are shared by all accounts.
- If you set `EXOTEL_*` environment variables, they override the **selected** account only.

An older single-account `config.json` becomes an account named “Default” the first time the app starts.

## 3. Write and submit a template (Compose tab)

Start with **What do you want to send?** at the top:

| Pick | You get |
|---|---|
| 💬 Text | Text message, optional text header, footer and buttons |
| 🖼️ Image + text | Image header (JPG/PNG ≤ 5 MB) above the message |
| 🎬 Video + text | MP4 header (≤ 16 MB) above the message |
| 📄 PDF + text | Document header (≤ 100 MB) — brochures, invoices |
| 🎠 Carousel | Message + 2–10 swipeable image or video cards |
| 🔑 OTP code | Authentication template — Meta writes the text |

On an empty draft it fills in a working example (text, sample values, a button) so you only
replace words instead of starting from a blank page. Then:

1. **Name** — e.g. `cp_launch_whitefield`. Spaces become `_` automatically.
2. **Category** — Marketing (launches, offers), Utility (updates on something the customer asked for), or Authentication (OTP).
3. **Format** — *Standard message* or *Carousel* (see below).
4. **Header** — none, text, or an **image** / video / PDF. Pick the file and it uploads to Exotel as a *sample* that Meta looks at during review; you see a thumbnail and the phone preview shows it. Haven't entered your Exotel details yet? Pick the file anyway — it uploads by itself once you save Settings (or when you press Submit).
5. **Body** — use the toolbar for **bold**, _italic_, ~strike~, lists, quotes, emojis and **+ Variable** (`{{1}}`, `{{2}}` …).
6. **Sample values** — one box appears per variable. Meta reviews the template with these.
7. **Footer / Buttons** — quick replies, website (optionally with a `{{1}}` at the end of the URL), call, copy-code.
8. Watch the **Checks** box. It catches the usual reasons Meta rejects templates *before* you submit.
9. **Submit to Exotel for approval.**

> Why the editor shows `*bold*` symbols: WhatsApp doesn't store HTML. Bold is literally
> `*text*` in the template. The editor writes those symbols for you and the phone preview
> shows what the customer actually sees.

### Carousel templates (swipeable cards)

Think of it as one short message followed by a row of mini-posters the customer swipes
through — e.g. one card per unit type in a project.

```
Message bubble:  Hi {{1}}, swipe to see homes at *Skyline Towers*.
[Card 1: 2 BHK photo]   [Card 2: 3 BHK photo]   [Card 3: Villa photo]
 2 BHK from {{1}}        3 BHK from {{1}}        Villas from {{1}}
 [Interested]            [Interested]            [Interested]
 [View floor plan ↗]     [View floor plan ↗]     [View floor plan ↗]
```

1. Pick **🎠 Carousel**. Header, footer and the normal buttons disappear (carousels don't use them).
2. Write the **message bubble** (max 1024 characters).
3. Set the **card layout** once: image or video, and 1–2 buttons (quick reply / website / call). Meta requires every card to use the same layout, so the app keeps them in sync for you.
4. **Fastest way:** press **+ Cards from files…** (or drop several files on a card) and pick all your images at once — one card per file, each uploaded automatically, buttons copied from card 1. Then for each card: check its image, write the card text (max 160 characters, variables restart at `{{1}}` on every card) and fill in its button labels/links. **+ Add card** (up to 10), **Duplicate**, **← →** to reorder.
5. A red dot on a card tab means that card still has something to fix. Click any card in the phone preview to edit it.

Exotel only lets you create carousels through the API (not in their dashboard), which is exactly what this app does.

## 4. Approval updates

**You don't need to set anything up.** While a template is *Pending*, the app asks Exotel for its
status every 3 minutes and the Templates tab (plus a pop-up) changes to Approved/Rejected by itself.

### Optional: instant updates via webhook (Webhook tab)

> **Read this first.** Exotel's WhatsApp webhook is **one address for the whole account**. Incoming
> customer messages and delivery reports go there too, and each event goes to only one URL. If a CRM
> or another system already receives them, pointing the webhook at your laptop takes that traffic away
> from it. Also, Exotel's public docs don't say they send template approve/reject events to this
> webhook at all. So check with the account owner and Exotel support before changing anything. The
> automatic status check above works without any of this.

Exotel needs a public **https** address to send updates to. Your laptop isn't public,
so you open a tunnel — a temporary public address that forwards to your computer.

```bash
ngrok http 3001
# or
cloudflared tunnel --url http://localhost:3001
```

Paste the https address the tunnel gives you into the Webhook tab. Copy the full URL it
builds (it ends in `/webhook/<secret>`) into **Exotel Dashboard → WhatsApp → Settings → Webhooks**.

Use **Test without Exotel** to see the flow work before Meta replies.

**Missed an update?** Templates tab → **Sync from Exotel** pulls the current status of every template on your WABA.

### Why two ports?

| Port | What it does | Who can reach it |
|---|---|---|
| 3000 | Editor + anything that uses your API token | Only this computer (`127.0.0.1`) |
| 3001 | Receives status callbacks — nothing else | Public, through your tunnel |

Only tunnel **3001**. If you tunnelled 3000, anyone with the link could submit templates on your account.

## 5. Everyday use

- **Rejected?** Templates tab → **Clone** → fix → submit. The name gets `_v2` added (Meta won't reuse a rejected name in the same language).
- **Copy JSON / Copy cURL** gives you the exact Exotel request — useful for Postman or a Copilot Studio / Power Automate HTTP step.
- Drafts auto-save in the browser, so closing the tab doesn't lose work.

### Real-world example

Launching a new project to channel partners:

```
Header:  New launch in {{1}}                         → Whitefield
Body:    Hi {{1}}, *{{2}}* opens bookings on {{3}}.   → Rahul / Skyline Towers / 25 Oct
         Reply YES for the brochure.
Buttons: [Yes, interested]  [View brochure → https://site.com/p/{{1}}]  [Call sales]
```

Write it once, get it approved, and every future launch reuses it — only the sample values change when you send.

---

## Files

```
Start (Mac).command    Double-click launcher for macOS (also runs on Linux with bash)
Start (Windows).bat    Double-click launcher for Windows
scripts/get-node.ps1   Used by the Windows launcher to fetch Node.js when it's missing
.runtime/              Private Node.js copy — only created if the computer has no Node 18+
server.js          Local server: Exotel API calls, webhook listener, live updates
public/index.html  The editor (single page, no build step)
data/              Created on first run — your settings, template list, webhook log
  config.json        credentials + webhook secret   (keep private)
  templates.json     everything you've submitted or synced
  webhooks.jsonl     every raw webhook payload received
```

## Exotel endpoints used

| Action | Request |
|---|---|
| Create template | `POST /v2/accounts/<sid>/templates?waba_id=<waba>` |
| List / sync | `GET /v2/accounts/<sid>/templates?waba_id=<waba>&limit=100` |
| Upload media sample | `POST /v2/accounts/<sid>/templates/sample?file_length=<bytes>&file_type=<mime>` |

## Options (environment variables)

| Variable | Default | Use |
|---|---|---|
| `UI_PORT` | 3000 | Editor port |
| `WEBHOOK_PORT` | 3001 | Webhook port |
| `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`, `EXOTEL_ACCOUNT_SID`, `EXOTEL_WABA_ID`, `EXOTEL_REGION` | — | Set credentials without the UI (e.g. on a VPS) |
| `WEBHOOK_SECRET` | random | Fixed secret for the webhook URL |
| `NO_OPEN` | — | Don't open the browser on start |
| `POLL_MINUTES` | 3 | How often pending templates are re-checked with Exotel (`0` = off, webhook only) |

## Troubleshooting

| You see | Do this |
|---|---|
| "Port 3000 is already in use" | Only happens if you set `UI_PORT` yourself — otherwise it moves to the next free port |
| Launcher says the Node.js download failed | Check internet / proxy, or install Node.js LTS from nodejs.org and double-click again |
| Test connection → Authentication failed | Re-copy the key/token; check the region (Mumbai vs Singapore) |
| Webhook events never arrive | Is the tunnel still running? (free ngrok URLs change on restart — update Exotel) Check the URL ends with `/webhook/<secret>` |
| Event arrives but status doesn't change | Open it in the Webhook tab. Exotel doesn't publish its exact template-status format, so the app matches common shapes; if yours differs, the raw payload is in `data/webhooks.jsonl`. Use **Sync** meanwhile. |
| Media upload fails | JPG/PNG ≤ 5 MB, MP4 ≤ 16 MB, PDF ≤ 100 MB |
| Cloned a synced template and it asks for images again | Meta returns only a view link for approved media, not a reusable upload — pick the files again |

## License

[MIT](LICENSE) — free to use, modify and share. Not affiliated with Exotel or Meta.
