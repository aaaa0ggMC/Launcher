# Local Toolbox

> Last updated: 2026-10-01

The Local Toolbox gathers 80 small utilities on one page: date and time, developer tools, text and
everyday helpers, images, documents and media, and productivity. Everything runs on this machine —
no network requests, no online APIs, and none of your inputs or results are stored. It only remembers
which tools you favorited, which you used recently, and how many pomodoro rounds you finished.

> Quick start: type a keyword in the page's search box (epoch, JSON, QR…) and press Enter to open the
> first match → fill in Input and options → click **Run tool** → copy, save or download the file from
> the Result area below.

## What it does

- Date and time: timestamp conversion both ways, batch conversion, date difference and arithmetic,
  calendar boundaries, duration, exotic epoch formats, world clock.
- Developer: format/minify JSON, code, CSS, HTML and SQL, config format conversion, regex, UUID,
  mock data, cron, Markdown, Base64, URL, hashing, radix, color, Linux command dictionary.
- Text and utilities: character statistics, diff and cleanup, pinyin, segmentation,
  simplified/traditional conversion, ASCII art, RMB amounts in words, random choice, QR codes,
  passwords, kinship terms, signature / stamp / letter-icon SVGs.
- Images: compress, crop and rotate, filters, solid background removal, Base64, ICO, splitting,
  ASCII art, watermark, word cloud, montage.
- Documents and media: Word / HTML / Markdown / API-doc conversion, spreadsheet conversion and
  merge, images to PDF, PDF merge/split/encrypt/decrypt/text/images/HTML, Office conversion,
  audio/video transcoding, video to GIF, GIF frames and compression, media info, video region
  patching, OCR.
- Productivity: a local pomodoro timer.

## UI at a glance

| Area             | Where                 | Description                                                                                             |
| ---------------- | --------------------- | ------------------------------------------------------------------------------------------------------- |
| Heading          | Top of the page       | Title "Local Toolbox", one-line intro, "Processed locally" chip                                         |
| Search box       | Below the heading     | Search by name, purpose or keyword; clearable                                                           |
| Category buttons | Below the search box  | All, Favorites, Date and time, Developer, Text and utilities, Images, Documents and media, Productivity |
| Recently used    | Below the categories  | Up to 6 tools you opened last (when there is history and no query)                                      |
| Tool grid        | Main body             | One card per tool: icon, title, description, category                                                   |
| Tool detail      | After clicking a card | Input and options form plus the Result area                                                             |

- The star icon button at the top right of each card favorites it; tap again to unfavorite. The
  **Favorites** category shows only favorites.
- The small line at the bottom of a card shows its category; tools that need an external program
  also show the dependency name.
- On the tool detail page, **All tools** (top left) returns to the list and **Favorite** /
  **Favorited** (top right) toggles the star.
- With no matches, an info alert reads "No matching tools. Try another keyword."

## Common tasks

### Open a tool

Three ways, all equivalent:

1. Click a tool card on the toolbox page, or focus it with Tab and press Enter / Space.
2. Type a keyword in the search box and press Enter to open the first match.
3. Search the tool name or a keyword in the app bar's global search and pick the result.

### Run a tool

1. Fill in Input and options: if a required field is empty, **Run tool** tells you which one.
2. Text fields are multi-line inputs, dropdowns pick from an enumeration, and file fields are a
   picker with the accepted formats noted (64 MiB per file, 128 MiB total).
3. Click **Run tool**; the button shows a spinner and the Result area appears below.
4. Depending on the tool the result is text or JSON, a rendered image or SVG, or playable audio and
   video. Each attachment has a **Download file** button; text can be **Copy result**-ed or kept with
   **Save text**.
5. **Reset** clears the form and the result, restoring each field's default.

### File tools (the Documents and media group)

Clicking **Run tool** turns the job into a background task:

- The button on the tool page shows a spinner and a **Stop job** button appears to interrupt it.
- The sidebar's Background Tasks panel gains a task named after the tool, viewable and stoppable
  across pages; the background only shows the tool name and generic status, never your file content.
- Leave and come back to the tool page and the last result is restored automatically.
- At most two conversion jobs run in parallel; a third waits for one to finish.

### Pomodoro timer

Open it for a progress ring with start / pause / resume / reset controls, plus focus minutes
(default 25) and break minutes (default 5). It cycles focus → break, counting each finished focus
round. **Leaving the page pauses it** (it never idles in the background), and only the completion
count is kept — nothing else.

## Read more

- [Tool list](Tools/ToolList.md): all 80 tools grouped by category (Chinese and English names and
  what each does).

## Privacy and security

- Inputs, outputs and errors are marked sensitive content; AI snapshots and screenshots are redacted.
- Password fields are an AI-forbidden zone; Hash / Digest, Encrypt PDF, Decrypt PDF and Password
  Generator refuse agent calls, and generated passwords are treated as credentials.
- External conversions run as fixed argument arrays inside a random temp directory; PDF passwords
  travel to qpdf over stdin, never through command-line arguments or logs; Office files are checked
  for macros and external references before opening.
- Favorites and recents store only tool IDs. Inputs and results are never logged or persisted
  (temp files are cleaned up when a job ends).

## Command line

Every tool has a command, and the UI shares the same handlers:

```bash
toolbox.list                                                    # list all tools and their fields
toolbox.epoch-converter --timestamp 1700000000 --unit s --zone Asia/Shanghai
toolbox.hash --input hello --algorithm sha256                    # digest (agent calls denied)
toolbox.start --tool pdf-merge --args '{"files":[…]}'            # run a file tool as a background job
toolbox.task --id <taskId>                                       # read job status and result (memory only)
toolbox.cancel --id <taskId>                                     # cancel a file job
toolbox.export --path /abs/out.png --base64 <base64>             # save an attachment
```

## FAQ

**"Processing failed. Check the input and installed dependencies"?** First check whether the tool
card or detail page shows **Requires local installation**: install whichever of ffmpeg, qpdf,
LibreOffice, poppler-utils or tesseract is missing. For tools without dependencies, the message
points at the input that was rejected.

**Why can't I see the image in the result?** The result area renders SVG and PNG/JPEG/GIF/WebP
directly; anything else is only available through **Download file**.

**My file upload did nothing / reported too large?** The limit is 64 MiB per file and 128 MiB per
batch; pick smaller files and try again.

**Where did my job go after switching pages?** File jobs keep running in the sidebar's Background
Tasks, and returning to the tool page restores the result. Non-file tools compute instantly and have
no background job.
