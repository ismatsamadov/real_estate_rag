# LLM-as-judge — using a model to score model outputs

**TL;DR.** Use a strong language model (we use Claude Sonnet) as an
automated grader for another model's outputs. Pass it the question, the
sources, and the answer, and ask it to score faithfulness, relevance,
and language match on a 0–5 scale. Much better than keyword matching
for evaluating RAG quality.

## What it is

Evaluating a RAG system has three failure modes:

1. **Wrong retrieval** — the right chunks weren't found
2. **Hallucination** — the answer makes claims the cited sources don't
   support
3. **Bad response shape** — the answer doesn't address the question,
   uses the wrong language, or refuses incorrectly

Mode 1 has a clean deterministic check (did the must-match keyword
appear in any retrieved chunk?). Modes 2 and 3 are subjective. You can't
write a regex for "did the model hallucinate?" — you need something that
can read both the sources and the answer and judge whether claims trace
back.

The pattern: **use the model itself (or a peer model) as the grader.**
Give it the same context, ask it to output strict JSON, and aggregate
the scores. Originally popularized by RAGAS (Es et al. 2023) and
mainstream after MT-Bench (Zheng et al. 2023).

## How we use it

For each question in [`eval/eval-set.jsonl`](../eval/eval-set.jsonl):

1. **Run** the question through the pipeline → answer + sources +
   metadata
2. **Deterministic checks**:
   - `retrieval_recall` — must-match keyword in any retrieved chunk?
   - `citation_validity` — every `[Sn]` maps to a real source?
   - `refusal_heuristic` — for "no_match_expected" questions, did the
     answer contain a refusal phrase?
3. **Call Claude as judge** with a strict JSON schema:

```json
{
  "faithfulness":          0-5,  // every claim must trace back to a cited source
  "faithfulness_reason":   "...", // 1-2 sentences citing specific drift
  "relevance":             0-5,  // did the answer address the question
  "relevance_reason":      "...",
  "language_match":        bool, // did the answer language match the question
  "language_match_reason": "...",
  "refusal_correct":       bool | null  // for trick questions, did it decline
}
```

4. **Aggregate** into a markdown report that names every failure with
   the judge's verbatim reason. No averaging away — *"21/25 faithful,
   here are the 4 that drifted"* beats a soothing *"84% faithful."*

## Why this beats pure keyword matching

Keyword recall is **necessary but not sufficient**. A system that
retrieves the right chunks can still:

- Add a fact from training data ("Marriott Bonvoy Platinum status" when
  no source mentions Marriott)
- Refuse on a question it should answer
- Answer in the wrong language
- Cite a `[S4]` that doesn't exist in the retrieved set

The LLM judge catches all four. The four failures in our latest eval
run were *all* of the "added a brand fact from training data" variety —
the judge surfaced them by name with the specific drift.

## How to keep the judge honest

The judge can be biased toward verbose or confident answers (the
"length bias" finding from MT-Bench). Mitigations:

- **Strict JSON schema** — the judge can't ramble; it has to commit to
  a number
- **`temperature = 0`** — deterministic outputs
- **A different model family for judge vs author** — open question
  whether using the same family (Sonnet judges Sonnet) inflates scores.
  Our latest data suggests judges are still willing to fail same-family
  answers (faithfulness 3 on multiple cases), so the bias is bounded.

For higher rigor: run two judges (Sonnet + GPT-4 + Gemini) and majority-
vote. Not done here; would be a future improvement.

## Where in this codebase

- Judge prompt: [`scripts/eval.js`](../scripts/eval.js), the
  `JUDGE_SYSTEM` constant
- Per-question scoring: same file, the `judge` function
- Failure aggregation: same file, `renderMarkdown`

## Read more

- [Es et al. 2023 — *RAGAS: Automated Evaluation of Retrieval Augmented Generation*](https://arxiv.org/abs/2309.15217)
- [Zheng et al. 2023 — *Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena*](https://arxiv.org/abs/2306.05685)
- [Anthropic — Evaluating Claude responses](https://docs.anthropic.com/claude/docs/empirical-prompt-engineering)
