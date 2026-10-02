# Response Transforms

> Last updated: 2026-10-01

Response Transforms hang off a template and pull the useful parts out of a response: body text,
images, audio, video — or talking to async APIs that answer "submit now, poll later". Results are
collected in **Final Response**, while the untouched raw response stays in **Response** below.

## Managing the chain

In the Response Transforms area of the template editor:

- **Add Transform** appends one to the end of the chain; new transforms default to `text` (numbered
  `#1`, `#2`, … when the label is empty).
- Each transform's heading collapses / expands it; the three icon buttons on the right are **move
  up**, **move down** and **delete**, in that order. Transforms run in list order, which is also the
  order results appear in Final Response.
- The Type dropdown offers: `Text`, `Image`, `Audio`, `Audio URL`, `Video URL`, `Task`, `Script`.
- Synchronous transforms (text / image / audio / script) recompute automatically whenever the raw
  response, the transform chain or the global variables change; `Audio URL` and `Video URL`
  re-download every time. With no transforms configured the area shows "No transforms defined".

## The seven transform types

| Type        | Key fields                      | What you get                                                               |
| ----------- | ------------------------------- | -------------------------------------------------------------------------- |
| `text`      | Format (`{.path}`)              | a text block; long text collapses                                          |
| `img`       | Entry path                      | images rendered inline, each with **Download**                             |
| `audio`     | Entry path, encoding            | a playable audio element decoded from inline data                          |
| `audio-url` | Entry URL, MIME type (optional) | audio player; several addresses become child entries                       |
| `video-url` | Entry URL, MIME type (optional) | video player; several addresses become child entries                       |
| `task`      | Task ID path, poll URL, …       | polls the async job in a background task; results return to Final Response |
| `script`    | Script (JS), local vars         | whatever the script emits: text, image, audio or video                     |

### text: build text from JSON paths

The Format box mixes literal text with `{.path}` expressions, e.g.:

```text
Answer: {.choices[0].message.content}
```

- Arrays are expanded item by item into an enumerated list (`0. …`, `1. …`).
- Multiple paths over the same array can be synchronized with `[X]`, e.g.
  `{.data[X].id} {.data[X].abilities}` pairs values by the same index.
- Different array roots combine as a Cartesian product, which multiplies the number of rows — use
  sparingly.
- A path that resolves to nothing is emitted verbatim as `{.path}`, so you can tell a typo from
  genuinely missing data.

### img / audio: inline data from the response

- `img` takes every string value at the **entry path** as an image URL, renders them all, and puts a
  **Download** button under each.
- `audio` takes the strings at the **entry path** and decodes them according to **Encoding**
  (Base64 / Hex8) into playable audio; leave **MIME type** empty to detect it from the data header,
  falling back to `audio/mpeg`.

### audio-url / video-url: remote media

Takes the `http(s)` addresses at the **entry URL**, downloads each into memory, then plays them.
A filled **MIME type** takes priority; otherwise it is guessed from the response header or the file
extension. One address yields a single player; several yield a parent entry reading "n …" with
numbered children, each playable and downloadable. Failures show `Failed to fetch` in the results.

### script: write your own JS

Objects available in the script:

- `object`: the parsed response JSON.
- `global_vars`: the globals defined in the right-hand panel.
- `context.transform.add_text(label, text)` / `add_img(label, url)` /
  `add_audio(label, src, type)` / `add_video(label, src, type)`: append output to the results.
- `context.local.NAME`: reads the key/value pairs configured under Local vars below.
- `console.log`: goes to the main-process log, not the page.

The script box is a **draft**: editing the text alone does not re-run it — click **Update** to
commit and execute (an asterisk appears beside the button when there are uncommitted changes).
A thrown error adds a `Script error: …` entry to the results.

### task: async polling

For APIs shaped "submit → task id → poll until done". Field by field:

| Field                        | Meaning                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------- |
| Task ID path                 | JSON path to the task id in the initial response, e.g. `.task_id`                |
| Poll URL                     | poll address; supports `{variable}`, `{.jsonpath}` and `{task_id}` placeholders  |
| Headers                      | one `Key: value` per line                                                        |
| Query params                 | `task_id=<id>` is appended by default; skipped when your params already carry it |
| Status path                  | JSON path to the status value in the poll response                               |
| Success value                | the status value that means done                                                 |
| Fail value                   | the status value that fails immediately                                          |
| Fail reason path             | where to read the failure reason from, shown in the results                      |
| Poll interval (ms)           | delay between polls, 2000 by default                                             |
| Response Transforms (nested) | transforms applied to the poll response once done; may nest tasks again          |

Polling runs in the background job `pg-task`, so **switching to another ability — even leaving the
page — does not interrupt it**:

- After sending, a task named after the template appears under the sidebar's Background Tasks. Its
  detail area uses the structured response view and offers a **Stop** button to interrupt at any
  time.
- Results flow back to the page and are listed by label in Final Response; results with children
  carry a refresh icon (hover shows **Retry Task**) that re-runs just that task.
- While polling with no results yet, the response view shows a three-dot loader and
  "Polling task…".

## What the results look like

- **Final Response**: the heading collapses the whole block. Text longer than 400 characters folds
  to a few lines with a fade, toggled by **Expand all** / **Collapse**; images, audio and video
  render with their own **Download**. When there are many results they load in batches, and
  "Loading…" appears at the bottom until the rest are shown.
- **Response**: the raw area. JSON offers **Tree** / **Raw**; non-JSON only a **Raw** expand toggle,
  plus **Copy**, **Download** and **Clear** in the header.
- A result labelled `Raw Response` has a download icon that saves the raw text returned by polling.

## Next

- [Back to API Playground](../main.md)
- [Templates and variables](TemplatesAndVariables.md): placeholder syntax and form generation.
