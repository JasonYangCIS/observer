---
name: score-reason
description: >-
  How to judge an item's relevance and write the "why this score" explanation
  that Observer shows next to every score. Use before calling score-item.
scope: runtime
metadata:
  internal: true
---

# Scoring and the "why"

Every score in Observer comes with a plain-language reason. Never save a bare
number. Two numbers are stored, and you only produce one of them.

- **Relevance (0-100): yours.** How well the item fits *this user's* interests.
- **Importance (0-100): the server's.** General buzz, computed from the real
  engagement numbers the source reported (for Hacker News, points and comments).
  Plain feeds report none and get a low baseline. You can't set it; don't try to
  fold buzz into relevance. A very popular item the user doesn't care about has
  high importance and low relevance, and the feed uses that gap to keep the user
  out of a bubble.

## Workflow

1. `get-score-input` with no `itemId` lists summarized items with no score.
2. `get-score-input` with an `itemId` returns the item, source, summary, the
   importance it will get, and the user's interest profile.
3. Judge relevance from the **interest profile and the summary**, then call
   `score-item`. Items need a summary first; if one is missing, summarize it.

## Judging relevance

Compare the item with what the user wrote in their profile, in their words.

- **80-100:** squarely about something the profile names.
- **50-79:** clearly related to a named interest, but not the main point.
- **20-49:** adjacent; a stretch to connect to any named interest.
- **0-19:** unrelated, or about something the profile says they don't want.

The profile is the only source of the user's taste. Don't infer interests it
doesn't state, and don't use the source or the popularity as a reason. If the
profile says the user is *less* interested in a topic, score down.

If the summary says the article couldn't be read, you have only a title; keep
relevance modest and say in the reason that it is based on the title.

## `matchedInterests`

Quote the phrases from the profile that the item matches, exactly as written
(for example `"web development"`). The server rejects any phrase that isn't in
the profile, and rejects relevance of 50 or more with no matched phrase, so a
high score can't float free of what the user actually said. Leave it empty only
when relevance is under 50.

## Writing the reason (20-300 characters)

One or two sentences, plain language, specific to this item.

- Say *what in the item* connects to *what the user wants*, or why it doesn't.
- Don't repeat the number, don't flatter, don't hedge ("seems", "might").
- Don't mention buzz or popularity: the server appends `Matched: ...` and
  `Buzz: ...` itself, so the user sees interests and engagement automatically.

Good: "Benchmarks a new edge runtime against Node for cold starts, which is the
performance work the user follows." (relevance 88, matched `edge rendering`)

Good (low): "A celebrity interview with no technology angle, and the profile says
to skip celebrity news." (relevance 4, no matches)

Bad: "Highly relevant article!" (empty, flattering, no connection stated.)
