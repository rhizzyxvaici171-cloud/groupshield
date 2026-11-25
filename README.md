# GroupShield

A self-hosted WhatsApp bot that protects groups from people who try to crash them, flood them or take them over, and gives the owner a dashboard to control everything.

[![tests](https://github.com/rhizzyxvaici171-cloud/groupshield/actions/workflows/test.yml/badge.svg)](https://github.com/rhizzyxvaici171-cloud/groupshield/actions/workflows/test.yml)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/rhizzyxvaici171-cloud/groupshield)

## What it does

| Threat | Response |
|---|---|
| **Bug / crash messages** (invisible floods, zalgo, vCard bombs, oversized buttons, broken coordinates, deep nesting) | Deleted for everyone. Critical ones also remove and ban the sender. |
| **Spam** (floods, the same text again and again) | The whole burst is deleted and the sender warned. |
| **Links** (off, invite links only, or every link) | Deleted, warned, removed at the limit. |
| **Raids** (mass joins, several attackers at once) | Group locked to admins, then reopened automatically. |
| **Status tagging spam** | Deleted and warned. |
| **Banned people rejoining** | Removed again. |
| **Payloads hidden in a group's name or description** | Owner alerted. |

The bot never displays messages. It only inspects their structure, so a message that crashes a phone does not crash the bot.

## Put it online for free

You need a GitHub account and about ten minutes. Neon's free plan needs no card, and Render's free plan documentation does not ask for one.

1. **Database.** Sign up at [neon.com](https://neon.com), create a project, and copy its connection string. This keeps your WhatsApp login when the free host restarts. It is encrypted before it is stored.
2. **Bot.** Click **Deploy to Render** above, sign in with GitHub, and paste the connection string into `DATABASE_URL`. The password and encryption key are generated for you.
3. **Link WhatsApp.** In Render open *Environment* and copy `ADMIN_PASSWORD`. Open your `https://….onrender.com` address, sign in, wait about two minutes for the code, and scan it with **WhatsApp → Linked devices**.
4. **Keep it awake.** Free Render services sleep after 15 minutes without visitors. At [uptimerobot.com](https://uptimerobot.com) add a free HTTP monitor for `https://your-address/healthz` every 5 minutes.
5. **Protect a group.** Add the bot's number to your group and make it an **admin**. Without admin rights it can only alert you.

## Run it on your own computer

Needs [Node.js](https://nodejs.org) 22 or newer.

```bash
git clone https://github.com/rhizzyxvaici171-cloud/groupshield.git
cd groupshield
npm ci
npm start
```

Open http://localhost:3000 and sign in with the password printed in the terminal.

## Commands

Send these in the group. Reply to a person, tag them or add their number where one is needed.

| Who | Commands |
|---|---|
| Everyone | `.help` `.rules` |
| Group admins: protection | `.status` `.shield on/off` `.antibug on/off` `.antilink off/invites/all` `.antispam on/off` `.antiraid on/off` `.antitag on/off` `.set warnlimit 3` `.scan` |
| Group admins: members | `.kick` `.ban` `.unban` `.warn` `.unwarn` `.warnings` `.promote` `.demote` `.del` |
| Group admins: group | `.lock` `.unlock` `.tagall` `.link` `.resetlink` `.setrules` `.welcome on/off` |
| Owner | `.trust` `.untrust` `.trusted` |

## Settings

All optional when running locally. See [.env.example](.env.example).

| Variable | Meaning |
|---|---|
| `ADMIN_PASSWORD` | Dashboard password. Required when hosted. |
| `SESSION_SECRET` | Encrypts the WhatsApp login. Required with a database. Keep it: without it you must link again. |
| `DATABASE_URL` | Postgres. Leave empty to store files in `data/`. |
| `OWNER_NUMBERS` | Numbers that get alerts and owner commands, e.g. `2348012345678`. The linked number is always an owner. |
| `DRY_RUN` | `1` = detect and log only. Good for a first day in a busy group. |
| `BLOCK_ATTACKERS` | `1` = also block critical attackers on the linked account. |
| `PREFIX`, `BOT_NAME`, `THRESHOLDS` | Command prefix, name, detection limits as JSON. |

## Know the limits

- **It is heuristic.** A brand-new kind of bug may get through until a limit is added.
- **There is a short gap.** A message reaches members' phones before any bot can delete it.
- **It uses an unofficial WhatsApp connection** ([Baileys](https://github.com/WhiskeySockets/Baileys)). WhatsApp can restrict numbers that use one. Use a spare number, not your main one.
- **Anyone with the dashboard password, or both the database and the secret, controls the linked account.** Treat them like your phone.
- **A hard crash can lose up to 15 minutes of encryption state** when a database is used, so a few messages may not be readable afterwards. Normal restarts save first.
- **Free plans change.** Check the current terms of Render, Neon and UptimeRobot.

## How it is built

```
WhatsApp ── Baileys ── guard.js ──┬── detector.js   crash payload analysis
                                  ├── policy.js     links, floods, raids
                                  ├── commands.js   admin commands
                                  └── ActionQueue   one action at a time
web.js   password-protected dashboard
storage.js   encrypted files or Postgres
```

`npm test` runs 35 tests. All samples are synthetic: this repository contains no working crash payloads, and no feature that sends them.

## Credits

The detection engine (`src/detector.js`, `src/thresholds.js`) is derived from [Sachi AntiCrasher](https://github.com/sachintha82288-cpu/sachi-anticrasher) by Sachintha Sampath, MIT License. GroupShield changes it as follows:

- Wrapped and edited messages are unwrapped, so a payload cannot hide inside them.
- Arabic, Thai, Yoruba, Hindi, Persian and emoji text is no longer mistaken for an attack.
- A message starting with the command prefix is still scanned.
- Deleting one message no longer clears the whole chat.
- With no owner set, strangers are no longer treated as the owner.
- Admin detection works in groups that use private `@lid` ids.
- Automated reporting to WhatsApp was left out because it can get the user's own account restricted.

The group controls, raid protection, dashboard, encrypted storage and hosting setup are new.

MIT License. See [LICENSE](LICENSE). Not affiliated with WhatsApp or Meta.
