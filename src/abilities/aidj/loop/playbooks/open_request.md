---
id: open_request
title: An open request with no anchor
when: the user wants music but names no song, artist, lyric or mood to start from — "随便来点", "你来选", "随机", "surprise me", "anything". They are asking YOU to choose; there is no recent sequence to continue.
phases: initial, directed
---

1. There is nothing to anchor on and nothing to continue — do NOT use the radio continuation steps. The user asked you to choose.
2. tag_cloud to see what the library is made of. Do not narrow hard: an open request deserves variety, not one tag.
3. filter_library only to drop the obviously unwanted (e.g. tags the user rejected earlier in this conversation); keep the pool broad.
4. Pick a varied set: ask_library_agent with a brief built from the user's own words (even a vague one) and the mood you want to open with; add a few random_pick from the pool for surprise.
5. queue_tracks until the candidate target is reached; open with the track that best fits the moment.
6. Finish with a short intro that says what kind of mix you made — the user said nothing specific, so tell them what you chose and offer to steer.
