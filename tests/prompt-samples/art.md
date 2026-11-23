# Art: the specifics inside the board-piece style

Prompt: `STYLE` in `src/lib/art.js`. Another change is rewriting it per kind; this is the inventory of the concrete cases it carries as of
`ce1d8b7`, for whoever does that, so each one gets a general rule or moves here for good. The cases themselves came from the round-13
piece review (commit `99ecb15`); this file does not summarise that review.

| specific in the prompt | the general rule it should become |
|---|---|
| "No pink anywhere: inner ears, noses and tongues use the cream or a deeper tone of the fur" | Faces and skin use the primary color's tones; no color outside the palette. |
| "a hat, a scarf, a satchel or a walking stick" | At most one small human touch, kept modest. |
| "beards, metal", "accessories and glasses frames" | Neutral greys and white are the only colors beyond the two. |
| "about 40 pixels tall" | Bold enough to read at board size. |
| "round 13" (in the comment above `STYLE`, not sent to the model) | n/a: a comment, not prompt text. |
