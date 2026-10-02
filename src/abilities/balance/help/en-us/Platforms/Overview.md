# Platform types and credential modes

> Last updated: 2026-10-01

Balance Center groups platforms by **credential mode**. Picking the right type is what makes the
balance query work.

| Type                | Examples                                                     | What you need                       | How it queries                                   |
| ------------------- | ------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------ |
| API Key             | DeepSeek, OpenRouter, PPIO, Tavily, OpenAI (API)             | A key issued by the platform        | Official balance / billing API                   |
| Web login (keyless) | OpenAI web, Xiaomi MiMo, BigModel, Google AI Studio, StepFun | Browser session (Profile container) | Reuses the login state against web APIs          |
| Subscription quota  | Codex (ChatGPT), Claude Code                                 | Subscription credentials / token    | Quota API, showing the 5-hour and weekly windows |

## Common fields

- **Display name**: the card title, for telling multiple accounts of the same kind apart, e.g.
  "DeepSeek primary".
- **Card icon**: supports `gi:<name>` (built-in monochrome icons), `default/<name>/padding`
  (icon pack), `emoji/<emoji>` or `file/<local path>`; left empty, it defaults by platform type.
- **Base URL**: only for self-hosted or proxy services; leave empty for official endpoints.
- **Enable this platform**: when off, it is skipped by auto-refresh but the config is kept.

## API-key platforms

Paste the key from the platform console into **API key**, e.g. DeepSeek's `sk-...`. Keys are
encrypted with AES-256-GCM derived from this machine's ID and are write-only (never echoed back
when editing).

## Subscription-quota platforms

### Codex (ChatGPT)

Two ways to fill it in:

1. **Import local credentials**: click **Import ~/.codex/auth.json** to read the Codex login on
   this machine.
2. **Manual / paste JSON**: paste the whole `auth.json` into the Access Token field and the UI
   unpacks `access_token`, `account_id` and `refresh_token` automatically.

The card shows the **5-hour quota**, **weekly quota**, credit balance, fast-reset count and
subscription expiry. With a Refresh Token filled in, an expired token renews automatically.

### Claude Code

Similar to Codex: shows remaining subscription quota and the reset time.

## Next

- The full flow for keyless platforms is in [Web login and Profiles](WebLogin.md).
- Back to [Balance Center](../main.md).
