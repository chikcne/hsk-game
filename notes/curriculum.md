 ▐▛███▛█   Claude Code v2.1.261
▝▜██████▀  Haiku 4.5 · Claude Team
  ▝▝ ▝▝    ~/hsk-game


❯ /model                                                                        
  ⎿  Set model to Haiku 4.5 and saved as your default for new sessions

❯ How are the orders of words for Learn Mode determined? Point to me in the     
  codebase                                                                      

● Explore(Find Learn Mode word ordering logic)
  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)

● I'm searching the codebase for Learn Mode word ordering logic. The agent is
  working in the background and will report its findings shortly.

✻ Churned for 5s · done 3:43 PM

● Agent "Find Learn Mode word ordering logic" finished · 44s

● Learn Mode word order is determined by a pre-generated curriculum that's
  committed to cards/curriculum.json. Here are the key files:

  Primary Entry Points

  Learn Session Creation —
  /home/justin/hsk-game/src/domain/learn/session.ts:24-45
  - selectLearnCandidates() flattens the curriculum lessons to establish the
    baseline order
  - Line 30: const order = deck.curriculum.lessons.flatMap((lesson) => 
    lesson.wordIds);

  Word Selection During a Session —
  /home/justin/hsk-game/src/domain/learn/session.ts:154-163
  - nextLearnCardIdUnchecked() picks words in order, prioritizing earliest-due
    cards
  - Ties are broken by stable word ID for determinism

  Curriculum Generation

  The order is generated once by
  /home/justin/hsk-game/tools/sort-curriculum/generator.ts using a three-stage
  algorithm:

  1. Base Order (lines 184-228): Highest-frequency cards first, with
     grammar/topics interleaved
  2. Prerequisite Resolution (lines 116-178): Ensures component characters
     appear before compound words
  3. Fixed Lesson Scheduler (lines 230-261): Packages words into 20-card
     HSK-grade lessons

  The generated curriculum is then committed in
  /home/justin/hsk-game/cards/curriculum.json and never shuffled at runtime.

  For the sorting rules and documentation, see
  /home/justin/hsk-game/designs/resorting/sorting_rules.md.

✻ Churned for 52s · done 3:44 PM

※ recap: You asked how Learn Mode word order is determined. Found that it uses a pre-generated curriculum from `cards/curriculum.json`, created by `tools/sort-curriculum/generator.ts` with three-stage ordering logic (base frequency, prerequisites, lesson packaging). (disable recaps in /config)