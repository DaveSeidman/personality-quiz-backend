export function extractSignals(payload) {
  const signals = {
    totalQuestions: payload.questions.length,
    avgDelayMs: 0,
    hesitations: [],
    fastPicks: 0,
    changesMind: 0,
    sliderReversals: 0,
    orderingSwaps: 0,
    gazeHovers: [],
    textResponses: [],
  };

  const delays = [];

  for (const q of payload.questions) {
    // Handle multiple choice types
    if (q.type === "multiple_choice" || q.type === "slide_to_select") {
      if (typeof q.delayMs === "number") delays.push(q.delayMs);
      if (q.changedMind) signals.changesMind += 1;

      const hovers = q.hoverMsByOption || {};
      const top = Object.entries(hovers).sort((a, b) => b[1] - a[1])[0];

      // A "hesitation" is defined here as: spent a decent time hovering one option
      if (top && top[1] > 800) {
        signals.hesitations.push({
          questionId: q.id,
          hoveredOptionId: top[0],
          hoveredMs: top[1],
          chosenId: q.selectedId,
        });
      }

      // "Fast pick" = answered in under 600ms
      if ((q.delayMs ?? 999999) < 600) signals.fastPicks += 1;
    }

    // Handle slider/range types
    if (q.type === "slider" || q.type === "range") {
      signals.sliderReversals += q.reversals ?? 0;
      if (typeof q.durationMs === "number") delays.push(q.durationMs);
    }

    // Handle ordering type
    if (q.type === "ordering") {
      signals.orderingSwaps += q.swaps ?? 0;
      if (typeof q.durationMs === "number") delays.push(q.durationMs);
    }

    // Handle image grid
    if (q.type === "image_grid") {
      if (typeof q.delayMs === "number") delays.push(q.delayMs);
      
      const hovers = q.hoverMsByCell || {};
      const top = Object.entries(hovers).sort((a, b) => b[1] - a[1])[0];

      if (top) {
        signals.gazeHovers.push({
          questionId: q.id,
          hottestCellId: top[0],
          hottestCellMs: top[1],
        });
      }
    }
    
    // Handle text responses
    if (q.type === "text" && q.text) {
      signals.textResponses.push({
        questionId: q.id,
        length: q.text.length,
        wordCount: q.text.split(/\s+/).filter(w => w.length > 0).length,
      });
    }
  }

  signals.avgDelayMs = delays.length
    ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length)
    : 0;

  return signals;
}

// Deterministic baseline pick:
// - multiple_choice + image_grid + slide_to_select: selectedId corresponds to a personality id
// - ordering: first item in order is treated as strongest preference
// - slider/range: can map value ranges to personality ids
export function deterministicPick(payload) {
  const score = new Map(); // personalityId -> number

  for (const q of payload.questions) {
    let pId = null;

    if (q.type === "multiple_choice" || q.type === "image_grid" || q.type === "slide_to_select") {
      pId = q.selectedId;
    } else if (q.type === "ordering") {
      pId = q.order?.[0] ?? null;
    } else if (q.type === "slider" || q.type === "range") {
      // Map slider value to a personality id based on ranges
      // This is configurable - can be overridden by quiz-specific logic
      if (typeof q.value === "number") {
        // Default 4-way split
        if (q.value < 0.25) pId = "A";
        else if (q.value < 0.5) pId = "B";
        else if (q.value < 0.75) pId = "C";
        else pId = "D";
      }
    }
    // text type doesn't directly contribute to scoring

    if (pId) score.set(pId, (score.get(pId) ?? 0) + 1);
  }

  const signals = extractSignals(payload);

  // Optional "party trick" behavioral bias:
  // If user second-guessed often, bump the "verifier" personality
  const VERIFIER = process.env.PERSONALITY_VERIFIER_ID;
  if (VERIFIER && signals.changesMind >= 2) {
    score.set(VERIFIER, (score.get(VERIFIER) ?? 0) + 1);
  }

  // Pick max score
  let best = null;
  for (const [id, s] of score.entries()) {
    if (!best || s > best.score) best = { id, score: s };
  }

  // Use client-provided fallback or default to first personality
  const fallbackId = payload.clientFallback?.personalityId 
    || payload.personalities?.[0]?.id 
    || "A";

  return {
    personalityId: best?.id ?? fallbackId,
    score: Object.fromEntries(score),
    signals,
  };
}
