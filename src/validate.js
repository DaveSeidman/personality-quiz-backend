const QUESTION_TYPES = new Set([
  "multiple_choice",
  "slider",
  "ordering",
  "image_grid",
  "text",           // Free text response
  "range",          // Range/scale questions
  "slide_to_select", // Swipe-style selection
]);

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonNegInt(n) {
  return Number.isInteger(n) && n >= 0;
}

export function validateQuizPayload(body) {
  if (!isObj(body)) return { ok: false, error: "Body must be an object" };

  if (!Array.isArray(body.questions))
    return { ok: false, error: "questions must be an array" };

  if (body.questions.length === 0)
    return { ok: false, error: "questions cannot be empty" };

  if (body.questions.length > 50)
    return { ok: false, error: "too many questions" };

  for (const q of body.questions) {
    if (!isObj(q)) return { ok: false, error: "each question must be an object" };

    if (typeof q.id !== "string" || !q.id)
      return { ok: false, error: "question.id required" };

    if (typeof q.type !== "string" || !QUESTION_TYPES.has(q.type))
      return { ok: false, error: `invalid question.type "${q.type}" for ${q.id}` };

    // Optional timing fields
    if (q.startedAtMs != null && !isNonNegInt(q.startedAtMs))
      return { ok: false, error: `startedAtMs invalid for ${q.id}` };

    if (q.answeredAtMs != null && !isNonNegInt(q.answeredAtMs))
      return { ok: false, error: `answeredAtMs invalid for ${q.id}` };

    // Type-specific validation (relaxed)
    if (q.type === "multiple_choice" || q.type === "slide_to_select") {
      if (q.selectedId != null && typeof q.selectedId !== "string")
        return { ok: false, error: `selectedId must be string for ${q.id}` };

      if (q.delayMs != null && !isNonNegInt(q.delayMs))
        return { ok: false, error: `delayMs invalid for ${q.id}` };

      if (q.hoverMsByOption != null && !isObj(q.hoverMsByOption))
        return { ok: false, error: `hoverMsByOption invalid for ${q.id}` };
    }

    if (q.type === "slider" || q.type === "range") {
      if (q.value != null && (typeof q.value !== "number" || q.value < 0 || q.value > 1))
        return { ok: false, error: `value (0..1) invalid for ${q.id}` };

      if (q.durationMs != null && !isNonNegInt(q.durationMs))
        return { ok: false, error: `durationMs invalid for ${q.id}` };
    }

    if (q.type === "ordering") {
      if (q.order != null && (!Array.isArray(q.order) || q.order.length < 2))
        return { ok: false, error: `order[] must have 2+ items for ${q.id}` };

      if (q.order && !q.order.every((x) => typeof x === "string" && x))
        return { ok: false, error: `order[] entries invalid for ${q.id}` };

      if (q.durationMs != null && !isNonNegInt(q.durationMs))
        return { ok: false, error: `durationMs invalid for ${q.id}` };
    }

    if (q.type === "image_grid") {
      if (q.selectedId != null && typeof q.selectedId !== "string")
        return { ok: false, error: `selectedId must be string for ${q.id}` };

      if (q.hoverMsByCell != null && !isObj(q.hoverMsByCell))
        return { ok: false, error: `hoverMsByCell invalid for ${q.id}` };
    }
    
    if (q.type === "text") {
      // Text responses are optional, just validate if present
      if (q.text != null && typeof q.text !== "string")
        return { ok: false, error: `text must be string for ${q.id}` };
    }
  }

  // Optional personalities array
  if (body.personalities != null) {
    if (!Array.isArray(body.personalities))
      return { ok: false, error: "personalities must be an array" };
  }

  // Optional fallback
  if (body.clientFallback != null) {
    if (!isObj(body.clientFallback) || typeof body.clientFallback.personalityId !== "string") {
      return { ok: false, error: "clientFallback.personalityId invalid" };
    }
  }
  
  // Optional quiz metadata
  if (body.quizId != null && typeof body.quizId !== "string") {
    return { ok: false, error: "quizId must be a string" };
  }

  return { ok: true };
}
