# API Playground

> Last updated: 2026-10-01

API Playground (page title: Provider Playground) is a scratch pad for talking to APIs. You write a
**request template**, every `{variable}` in it becomes a form field, and the response can be sliced
into text, images, audio or video with **response transforms** — or handed to a background job for
polling. Templates, variables and history live in this machine's browser storage and can be exported
as a JSON backup.

> Quick start: click **New** in the Provider panel on the right → fill in the **URL template** and
> body → fill the fields under Fill Variables → click **Send Request** → read the result in the
> Response area.

## What it does

- Re-run the same endpoint from a template: URL, headers and body all take placeholders, so
  changing parameters never means editing the request text.
- Variables become a form automatically: numeric ranges turn into sliders, enums into dropdowns,
  long text into textareas, and defaults can be baked into the template.
- Send requests and inspect responses: JSON renders as a collapsible tree, or switch to the raw
  text, copy it, or download it.
- Response transforms extract body text, image URLs, inline base64 audio and video URLs straight
  out of the response.
- Async flows (submit → task id → poll) run as a background task, so switching pages never
  interrupts them.
- Export the whole setup (templates + globals + filled values + history) as JSON and import it
  elsewhere.

## UI at a glance

| Area                 | Where           | Description                                                               |
| -------------------- | --------------- | ------------------------------------------------------------------------- |
| Page toolbar         | Top row         | **Export config**, **Import config**                                      |
| Main column          | Left body       | Template editor, Fill Variables, Final Response, Response                 |
| Right floating panel | Docked right    | Titled Provider: **Global Variables** plus the template list; collapsible |
| Delete confirmation  | Centered dialog | Second confirmation before a template is deleted — it cannot be undone    |

**The four blocks of the main column, top to bottom**:

1. **Template editor**: name field, method dropdown, **Delete Template**, the "copy from another
   template" row, the **URL template / Headers / Body** inputs, the **Response Transforms** area,
   and badges for the variables that were detected.
2. **Fill Variables**: a form generated from the template's variables, with **History (n)** and
   **Clear** on the right and the full-width **Send Request** at the bottom ("Sending…" while busy).
3. **Final Response**: transform results (text / images / audio / video); the heading collapses the
   whole block.
4. **Response**: the raw response with status and duration, **Tree** / **Raw** toggle, copy,
   download and clear.

**Right floating panel**: the arrow button in the panel header collapses the whole panel into a
small button in the top-right corner (hover shows **Expand all** / **Collapse**). Expanded, the top
half is **Global Variables** (collapsed by default; click its heading to open), the bottom half is
the template list with a **New** button. With no template selected the main column only shows
"Select or create a request template".

## Common tasks

### Create, switch and delete templates

1. Click **New** in the right-hand template list; a blank template appears and is selected.
2. Give it a name in the template name field and pick GET / POST / PUT / DELETE / PATCH.
3. Click any template in the list to switch. Values you filled in are kept when you leave and
   restored when you come back.
4. To delete, click **Delete Template** in the editor and confirm with **Delete**; **Cancel** backs
   out. Deleting a template also deletes its send history.

### Fill variables and send

1. Every `{name}` you write in the template adds a field under Fill Variables; constrained ones
   show a hint (e.g. `(256 – 1024)`, `(min 1)`).
2. Fill the fields and click the full-width **Send Request**.
3. While sending, the button shows a spinner. When the response arrives the Response area shows the
   status (green below 400, red otherwise) and the duration in milliseconds; failures are printed in
   red monospace.
4. Every send is recorded under **History (n)**; click an entry to load that set of values back into
   the form.

### Read the response

- **Tree / Raw**: shown when the response is JSON. The tree collapses per level, strings longer
  than 80 characters fold into one line, and clicking 〔click to expand〕 reveals the full text.
  Non-JSON responses only get a **Raw** expand toggle.
- **Copy** writes the raw response to the clipboard.
- **Download** saves `response.json` for JSON, `response.txt` otherwise, to a path you pick.
- **Clear** drops the current response and transform results.

### Copy from another template

The "copy from another template" row (only visible when other templates exist): pick a template in
**Choose source template**, then click **All** / **Headers** / **Body** / **Transforms** to overwrite
that part of the current template.

### Export and import config

- **Export config** opens a save dialog (default name `playground-<timestamp>.json`) and writes
  templates, globals, filled values and history; a snackbar confirms "Exported n templates".
- **Import config** takes a previously exported JSON and replaces all four collections, confirming
  with "Imported n templates"; a malformed file shows "Import failed: …" and leaves your data alone.

> The exported JSON is plaintext and includes global variable values. Remove any key-bearing globals
> before backing it up or sharing it.

### Copy the whole page as Markdown

The app-bar button "Copy current page as Markdown" composes the template list, active template,
filled variables, global variables, raw response and final results. Globals marked as password are
emitted as `••••••`, so secrets never reach the clipboard.

## Read more

- [Templates and variables](Usage/TemplatesAndVariables.md): placeholder syntax, the generated form,
  and what is stored where.
- [Response transforms](Usage/ResponseTransforms.md): all seven transform types plus async tasks and
  the background-task panel.

## Privacy and security

- A global variable's value can be toggled to password display with the eye button; copying the page
  as Markdown masks those values as `••••••`.
- Requests are sent from the UI, exactly like opening the URL in a browser: cross-origin endpoints
  are subject to CORS, and direct calls are better done from the CLI or a script.
- The exported JSON is plaintext — anyone holding the file can read the keys inside.

## Command line

Import/export and remote downloads go through these three commands (everything else is pure UI):

```bash
playground.export --path /abs/playground.json --data {"data":{...}}   # write the config to a file
playground.import --path /abs/playground.json                        # read a config file
playground.download-url --url https://... --path /abs/file.jpg       # download remote media locally
playground.download-url --text "content" --path /abs/out.txt         # or write text to a local file
```

## FAQ

**Sending fails with a CORS error?** Requests originate from the UI, so an endpoint that doesn't
allow cross-origin calls is blocked. Verify with `curl` first, then use a proxy or the CLI.

**A variable never shows up in the form?** Three possibilities: its name is defined under **Global
Variables** (globals are injected automatically and never become form fields); the name contains
characters other than letters, digits and underscores; or it is no longer written in any of the URL,
headers or body templates.

**The request still contains `{xxx}`?** That variable had neither a value nor a `default(…)`, so the
placeholder was left in place. Append `default(value)` to the declaration to provide a fallback.
