---
id: seed_start
title: Start from a song / lyric / phrase
when: the user names a song, quotes or describes lyrics, or says "start from X" (从……开始). They want X first, then more in its spirit — not just one song.
---

1. The user wants a whole batch that OPENS with X, not a single song.
2. search_titles with X (and its key words). If there is no hit, search_lyrics with short phrases from X (e.g. "辽阔的森林" → ["辽阔的森林"], then ["森林","辽阔"] with require="all").
3. get_songs on the hits with include_lyrics=true to understand each one.
4. Choose the seed: if several hits have compatible emotion tags you may keep up to 2; if their moods clash, pick the single best one (best lyric match, then best mood fit).
5. queue_tracks the seed with pin_first=true.
6. tag_cloud, then filter_library: drop tags that clearly clash with the seed's emotion / energy / language (follow the configured filter strength).
7. dream_from_seeds with the seed id(s) and a direction describing the world the seed opens (imagery, feeling, texture).
8. queue_tracks the good results until the candidate target is reached; if short, dream again with a different direction or use similar_to on the seed.
9. Finish with the handoff note: the seed, why it was chosen, the mood arc to build from it.
