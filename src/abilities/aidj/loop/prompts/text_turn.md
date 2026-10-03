User Request: "{request}"

Constraints:
1. Language: The 'User Request' block above is a system instruction, NOT the user's own words — do not match its language. Write the [Intro] in the language the user actually writes in (their original request and earlier chat messages in this session).
2. No repeats: Do NOT reuse any song from the forbidden list: [{forbidden}].
3. Matching: Look up songs in the Music Library from the first System message. If at least one matches, output Intro + {separator} + SongKeys. If none match, output ONLY the Intro.
