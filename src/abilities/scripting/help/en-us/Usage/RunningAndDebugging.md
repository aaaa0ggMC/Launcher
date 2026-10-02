# Running, debugging and background jobs

> Last updated: 2026-10-01

This page covers runtime details: what each kind of console output means, how to triage failures,
and how to hand long-running work to a background job.

## Foreground and background runs

The page's **Run** is a **foreground** run: output streams live into this page's console. If you
switch to another ability the script still finishes in the main process, but the console will not
back-fill the output produced while you were away (log events only reach subscribed pages).

If a task may take minutes (bulk conversion, polling, long downloads), hand it to a background job
from inside the script:

```ts
const task = await cockpit.job('script-run', {
  code: 'await cockpit.sh("sleep 60")',
  language: 'ts'
})
cockpit.log('background task started', task)
```

- Once handed over you can leave the page; the job keeps running in the sidebar's Background Tasks
  panel, with progress and logs there.
- **Stop** in that panel aborts it, firing `cockpit.signal` and unwinding in-flight `await`s.
- The foreground **Stop** only affects the current foreground run; it never touches jobs you already
  handed over.

## What the console output means

Each line is `time [type] content`, colour-coded by type:

| Type     | Source                                                             | Colour bias |
| -------- | ------------------------------------------------------------------ | ----------- |
| `system` | the runner itself: start, completion, progress, abort              | primary     |
| `log`    | `cockpit.log(…)`                                                   | body text   |
| `info`   | `cockpit.info(…)`                                                  | info        |
| `warn`   | `cockpit.warn(…)` or the graceful-degradation branch of a template | warning     |
| `error`  | `cockpit.error(…)` or a thrown exception                           | error       |
| `stdout` | stdout of `cockpit.exec` / `cockpit.sh`                            | body text   |
| `stderr` | stderr of a child process                                          | error       |
| `result` | a non-undefined top-level `return` value                           | success     |

The toolbar also shows a status pill (Ready / Running / Success / Error / Cancelled),
`Duration: x.xs` (ticking live while running) and the line count. The progress bar below is
determinate when `cockpit.progress(pct)` reports a percentage, otherwise an indeterminate wait
animation.

## Reading common errors

- **Command not found**: `cockpit.command('xxx')` throws that the command isn't registered. Check
  the real name with `cockpit.listCommands()`; the ability may also be filtered out by platform or
  missing dependencies.
- **Command failed**: most commands return `{ ok: false, error: '…' }` instead of throwing — your
  script has to inspect the result.
- **TypeScript error**: compilation fails up front, so the console only shows
  `[system] execution failed` with a line/column in the message.
- **Non-zero exit code**: `cockpit.sh` throws the stderr or `Exit code N`. Use `cockpit.exec` and
  check `code` yourself when failures are acceptable.
- **Cancelled**: a stopped script reports `Script execution cancelled` — that is expected, not a
  bug.

## Debugging tips

- Put a `cockpit.info('step name')` before and after critical steps so failures pinpoint themselves.
- To inspect a result's shape, use `cockpit.log(JSON.stringify(res, null, 2))`.
- Toggling a parameter is faster than commenting code out.
- **Save** when you are done (Ctrl+S); an asterisk-free filename means it is saved.

## Keyboard shortcuts

| Key                 | Action                    |
| ------------------- | ------------------------- |
| Ctrl+Enter          | Run                       |
| Ctrl+S              | Save                      |
| Ctrl+F              | Find                      |
| Ctrl+H              | Find and replace          |
| Enter / Shift+Enter | Next / previous match     |
| Esc                 | Close the search box      |
| Tab                 | Insert a two-space indent |

> Switching to another ability and back preserves the page state (script, parameter values,
> console); this ability is a keepAlive page.

## Next

- [Back to Workflow Scripting](../main.md)
- [Built-in templates and script API](TemplatesAndScripts.md): the five presets and the `cockpit.*`
  API.
