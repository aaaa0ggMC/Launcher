---
id: artist_pick
title: Songs by an artist
when: the user asks for an artist / band / composer (来点周杰伦的歌, play some C418).
---

1. search_titles with the artist name (limit high enough to see their catalogue; simplified/traditional both match).
2. If there are many hits, ask_library_agent with scope {"ids": [...the hit ids...]} and a brief describing the current mood and any wish in the request, to choose the best ones for right now.
3. queue_tracks the picks (the per-artist cap does not apply when the user asked for the artist).
4. If the artist has too few tracks to reach the candidate target, add a few close relatives: similar_to on their best-fitting track (include_same_artist=false), and say so in the handoff note.
5. Finish with the handoff note: who was asked for, which side of their catalogue fits now, how to sequence it.
