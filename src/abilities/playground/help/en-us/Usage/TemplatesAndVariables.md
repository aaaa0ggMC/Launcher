# Templates and Variables

> Last updated: 2026-10-01

A template is four pieces of text: the **URL template**, **Headers**, **Body**, plus a
**Response Transforms** chain. Every `{variable}` written in the first three is collected
automatically and becomes a field under Fill Variables; on send, your values are substituted in.
This page covers placeholder syntax, how the form is generated, and where the data is stored.

## Placeholder syntax

Placeholders must sit in curly braces, and the name may only contain letters, digits and
underscores (not starting with a digit). Ordinary JSON `{ }` objects are never treated as variables.

| Writing                 | Effect                                                                |
| ----------------------- | --------------------------------------------------------------------- |
| `{name}`                | single-line text input                                                |
| `{name:string}`         | single-line text input (explicit)                                     |
| `{name:number}`         | number input; with a `range` it becomes a slider                      |
| `{name:textarea}`       | multi-line input                                                      |
| `{name:bool}`           | checkbox                                                              |
| `{name:select}`         | dropdown (options come from the constraint)                           |
| `{name:range(1,100)}`   | treated as a number: slider + number field, min/max shown at the ends |
| `{name:options(a,b)}`   | treated as a dropdown with options a / b                              |
| `{name:min(1)}`         | number input with a `(min 1)` hint                                    |
| `{name:max(10)}`        | number input with a `(max 10)` hint                                   |
| `{name:...:default(v)}` | pre-fills default v; also used as a fallback if left empty on send    |

Notes:

- Constraints and defaults come after the type, separated by colons, e.g.
  `{width:number:range(256,1024)}`.
- `default(value)` belongs at the end of the constraint string; surrounding quotes are stripped.
- An unrecognized type falls back to single-line text — it never errors out.
- A repeated variable name counts once, and the first occurrence's declaration wins.
- Badges: the bottom of the template editor groups detected variables into "Global (auto-filled)"
  and "Form fields" chips. The dim tail of each chip shows type, range and default, e.g.
  `number 256-1024 =1024`.

## How the form is generated

Fill Variables renders a different control per declaration:

| Declaration              | Control                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `bool`                   | checkbox                                                           |
| `select` or with options | dropdown                                                           |
| `textarea`               | multi-line input                                                   |
| `number` + `range`       | slider with min / max at the ends and a number field in the middle |
| `number` (no range)      | number input                                                       |
| anything else            | single-line input                                                  |

Entering the page or switching templates pre-fills the form with "defaults + last saved values".
Clicking an entry under **History (n)** loads the exact set of values used for that send.
**Clear** only clears the current template's history.

## How the request is assembled

On send, values are merged in this order: **variable defaults → global variables → what you typed in
the form**. An empty form field falls back to the default; when neither exists the placeholder is
left verbatim in the request.

- **Headers**: parsed line by line as `Key: value`; lines without a colon, or with a colon in the
  first position, are ignored.
- **Body**: values of type `string` / `textarea` are JSON-escaped first (backslash, double quote,
  newline, carriage return, tab), so multi-line text can be dropped straight into a JSON string.
- **GET requests** never send a body, even if one is filled in.
- **Substitution is plain text replacement**: `{model:string}` with `gpt-4o` filled in yields
  `.../v1/gpt-4o`.

## Global variables

**Global Variables** at the top of the right-hand Provider panel holds values shared across
templates (API keys, model names, …):

- Click the heading to expand / collapse; the number beside it is the current count.
- **Add Variable** appends a row: name on the left, value on the right; the eye button toggles
  between plain text and password display.
- Names defined here never appear as form fields — they are injected on send instead, and show up
  under "Global (auto-filled)" in the editor badges.
- A global may share a name with a template variable; the form value wins in that case.

## Copy from another template

The "copy from another template" row: pick a source template, then click **All** (URL + headers +
body + transforms), **Headers**, **Body** or **Transforms** to overwrite that part of the current
template. Only those text blocks are replaced — the name and method are untouched.

## Where the data lives

Everything is kept in browser localStorage, read on startup and preserved across restarts:

| Key                  | Contents                                                   |
| -------------------- | ---------------------------------------------------------- |
| `rp_templates`       | template list                                              |
| `rp_globals`         | global variables                                           |
| `rp_values`          | filled variable values per template                        |
| `rp_history`         | send history (time, duration, error flag, the values used) |
| `rp_active`          | id of the last opened template                             |
| `rp_panel_collapsed` | whether the Provider panel is collapsed                    |

A first run ships with a sample template named Example API (pointing at httpbin.org) you can send
right away. To move to another machine or back up, use **Export config** / **Import config**.

## Next

- [Back to API Playground](../main.md)
- [Response transforms](ResponseTransforms.md): extracting text, images, audio, video and async
  tasks from responses.
