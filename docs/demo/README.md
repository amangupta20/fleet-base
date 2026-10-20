# Demo GIFs

Terminal recordings of the API in this repo. No browser UI is involved.

| File | What it shows | Size, duration |
|---|---|---|
| `fresh-boot.gif` | `celld dev` boot from a clean `.celld/dev`, then `curl /health` returns `ok` | 65 KB, 12 s |
| `kill-9-resume.gif` | prompt in flight, `kill -9` the celld process, restart, `curl /messages` shows the prior user/system entries, then the same `requestId` re-POST returns `status: done` under the same `operationId` | 149 KB, 29 s |
| `second-terminal.gif` | a second local terminal sends the same prompt with `curl`; no laptop UI | 29 KB, 9 s |

The kill -9 clip's `jq` summary adds `chars: 820`, computed from `.text | length`.
The Worker response has `text`, `submissionId`, `operationId`, `status`, and
`reason`; `chars` is not an API field.

The `/messages` preview for `pi.user` and `pi.system` is `(no text content)`
because the endpoint returns `{id, kind, preview}` and those entries have no text
preview. The two rows are the prior state; the same-ID re-POST is the resume
proof.

The third clip is a second local terminal, not a phone or Termux recording. No
phone was available. The HTTP call is the one a phone would make.

These were recorded from a real pty with `pyte`, then rendered to PNG frames and
encoded with ffmpeg. The shell commands and output are real. The first attempt
used a compositor screen capture, but the floating terminal window was
transparent and the kill test wrote its output inside the watched project tree,
which made `celld dev` rebuild mid-run. The terminal-buffer recording avoids
both.
