# Agent marks

Official artwork for the clients the Connect screen can wire up. Files are named by
the client id in `ui/agent-connect.js`, so the slot picks them up by name.

| file | source |
|---|---|
| `claude.svg` | `claude.ai/favicon.svg` |
| `codex.svg` | `developers.openai.com/favicon.svg` |
| `cursor.svg` | `cursor.com/marketing-static/favicon.svg` |
| `windsurf.svg` | `windsurf.com/favicon.svg` |
| `zed.svg` | `zed.dev` (`logo_blue_no_gradient_padded`) |

Each is the vendor's own mark, taken unmodified from the vendor's own site, and used
only to identify their product in a list of things Fetch can connect to. Do not
recolour, redraw or approximate them. If a mark needs replacing, take the new one
from the vendor rather than editing the file here.

`chrome` in the `AGENTS` list says whether a mark is a bare glyph that needs Fetch's
tile behind it (Claude, Zed) or already carries its own background (Codex, Cursor,
Windsurf). Set it by looking at the artwork.

A two-letter monogram stands in if a file is ever missing, so the row degrades to a
letter rather than a broken-image glyph.
