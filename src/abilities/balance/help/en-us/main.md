# Balance Center

> Last updated: 2026-10-01

Balance Center gathers your account balances, monthly bills and subscription quotas across AI
platforms onto one page. It refreshes on a schedule and flags any platform that errors out. All
credentials stay on this machine (hardware-bound encryption) and are never uploaded anywhere.

> Quick start: click **Add platform** in the top-right → pick a type → paste the API key →
> **Save**. The card then queries and shows its balance automatically.

## What it does

- See every balance at a glance: CNY / USD / Credits are summed separately.
- Track usage and quotas: OpenAI current-month billing, Codex 5-hour and weekly quotas,
  subscription renewal dates.
- Keyless platforms (OpenAI, Xiaomi MiMo, BigModel, Google AI Studio, …) sign in through a web
  page and share a session via Profile containers.
- Scheduled auto-refresh; pinpoint failing platforms; refresh any single card.

## UI at a glance

| Area            | Where             | Description                                                           |
| --------------- | ----------------- | --------------------------------------------------------------------- |
| Toolbar         | Top of the page   | Refresh all, Add platform, Profile accounts, Import legacy config     |
| Summary cards   | Below the toolbar | Total CNY, total USD, Credits, platform health                        |
| Search & filter | Below the summary | Search by name / currency / Profile; filter All / OK / Error          |
| Platform cards  | Main body         | One card per platform with balance, status, latency and quick actions |

The icon row at the bottom of each card, left to right: open console, view raw data, edit,
delete, refresh. Hover to see each button's name.

## Common tasks

### Add or edit a platform

Click **Add platform** (or the edit icon on a card). In the dialog pick a **Platform type**; the
name and icon are filled in automatically. Enter the **API key**, click **Test connection** to
confirm it works, then **Save**.

- You can configure several platforms of the same kind (e.g. two DeepSeek accounts); use
  **Display name** to tell them apart.
- **Base URL** is only needed for self-hosted or proxy services.
- The edit dialog is an AI-forbidden zone: the agent cannot read or fill in its secrets.

### Refresh balances

- **Refresh all** refreshes every enabled platform.
- The refresh icon on a card refreshes just that card.
- With auto-refresh on, the page also refreshes on an interval while open (see Settings → Balance).

### Open the console / view raw data

- **Open console** opens the platform's official billing page for top-ups and details.
- **View raw data** expands the raw JSON response for troubleshooting or field verification.

### Sign in (keyless platforms)

Some platforms (OpenAI, Xiaomi MiMo, BigModel, Google AI Studio, StepFun) work through a web
login instead of an API key. When a card errors it shows a **Sign in** button; complete the login
in the popup window and refresh the card. See
[Platform types → Web login](Platforms/WebLogin.md) for the full flow.

### Import legacy config

If you stored platform config with an older version or another tool, click **Import legacy
config** to migrate it automatically.

## Read more

- [Platform types and credential modes](Platforms/Overview.md): how to fill API key, Cookie and
  Codex credentials.
- [Web login and Profiles](Platforms/WebLogin.md): multi-account isolation, session sharing and
  the authorization flow.

## Privacy and security

- Balances, vouchers, used / total quota and raw responses are marked as **personal**; AI
  snapshots and screenshots are redacted.
- Platform login accounts (email, etc.) are marked **sensitive** and redacted by default; visibility
  can be requested when needed.
- API keys are **credentials**, encrypted at rest with AES-256-GCM derived from this machine's ID,
  write-only (never echoed back).

## Command line

Every action in Balance Center is also a CLI command; the UI is just a wrapper:

```bash
balance.list                       # list all platforms and their latest results
balance.check --id <platformId>    # query one platform's balance
balance.config.get --reveal false  # read config (only --reveal true includes plaintext keys)
balance.config.upsert --platform '{"id":"deepseek","type":"deepseek","apiKey":"sk-..."}'
balance.config.remove --id <platformId>
balance.refresh                    # refresh all
```

## FAQ

**Refresh keeps failing?** Click **Test connection** in the edit dialog — it shows the exact
error. For keyless platforms, finish the sign-in first and make sure the platform is enabled.

**Numbers don't match?** Platform APIs may or may not include vouchers. Expand **View raw data**
to see the raw fields.

**Quotas are unreadable after moving to a new machine?** Keys are bound to this machine's ID;
on a new machine you need to re-enter them.
