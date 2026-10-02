# Web login and Profiles

> Last updated: 2026-10-01

Keyless platforms don't query an API key; they reuse a browser login. Balance Center isolates and
stores that login data in **Profile** containers.

## What a Profile is

A Profile is an isolated browser data container (cookies / localStorage / session). Login state
inside one Profile is shared by the platforms in it, and different Profiles don't interfere with
each other.

- One Profile can sign in to several platforms (OpenAI, Google, Xiaomi, BigModel, …).
- To separate a "personal account" from a "work account", create one Profile each.
- On the **Profile accounts** page you can create, edit and check login status.

## Authorization flow

1. Click **Sign in** on a platform card (or enter it from the card actions when the card is OK).
2. The popup window loads the platform's official login page.
3. Finish signing in, close the window, then click **Refresh** on the card; the status should
   become "OK".
4. If the card still errors, open **Profile accounts** and click **Check status** to confirm the
   Profile is signed in.

> Account passwords entered in the login window are credentials: the agent cannot read them, and
> they never appear in screenshots or AI snapshots.

## Multiple accounts

- Create a separate Profile per account and pick the right **Profile container** when adding the
  platform.
- One Profile can be shared by several cards, reducing repeated logins.
- Deleting a Profile unbinds its cards and clears its login data — do this with care.

## Related commands

```bash
balance.profiles.list
balance.profiles.upsert --name "Personal primary"
balance.profiles.check --id <profileId>
balance.profiles.login --id <profileId> --provider google
```

Back to [Balance Center](../main.md) · Previous
[Platform types and credential modes](Overview.md).
