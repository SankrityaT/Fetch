# Agent marks

Drop the official SVG for each client here, named by its id in `ui/agent-connect.js`:

    claude.svg  codex.svg  cursor.svg  windsurf.svg  zed.svg

They are rendered at 18x18 inside a 30px tile on the onboarding Connect screen, so a
monochrome or single-colour mark reads best. Nothing else needs to change: the slot
picks the file up by name, and falls back to a letter monogram while it is absent.

Use each vendor's own artwork under their brand guidelines. Do not redraw or
approximate them.
