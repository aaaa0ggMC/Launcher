---
id: radio_flow
title: Continue the radio
when: ONLY autonomous refills where nobody asked for anything — keep the flow going from the recent sequence. Never for a direct user request.
phases: autonomous
---

1. Read the recent sequence (it is in the batch instruction; session_memory for more).
2. tag_cloud, then filter_library: drop tags that would break the current arc; keep the pool varied.
3. Pick an anchor: one recent track whose mood should carry on. dream_from_seeds with it (and optionally a second, contrasting recent track) and a direction for the next chapter — evolve the mood, do not repeat it.
4. If the arc wants a turn (same mood for too long), say so in the direction or use ask_library_agent with a brief for the new colour. A random_pick or two from the pool adds welcome surprise.
5. queue_tracks until the candidate target is reached.
6. Finish with the handoff note: where the arc is and where this batch takes it.
