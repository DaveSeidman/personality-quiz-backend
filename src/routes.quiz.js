import { Router } from "express";
import { deterministicPick } from "./analyze.js";
import { openai } from "./openaiClient.js";
import { validateQuizPayload } from "./validate.js";

export const quizRouter = Router();

quizRouter.post("/analyze", async (req, res) => {
  const v = validateQuizPayload(req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });

  const payload = req.body;
  const baseline = deterministicPick(payload);

  const USE_OPENAI = process.env.USE_OPENAI === "true";
  if (!USE_OPENAI) {
    return res.json({
      ok: true,
      mode: "deterministic",
      personalityId: baseline.personalityId,
      signals: baseline.signals,
      callouts: buildCalloutsFromSignals(baseline.signals),
    });
  }

  // Check for API key
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY not set, falling back to deterministic");
    return res.json({
      ok: true,
      mode: "deterministic",
      personalityId: baseline.personalityId,
      signals: baseline.signals,
      callouts: buildCalloutsFromSignals(baseline.signals),
    });
  }

  try {
    // Get allowed personality IDs from payload or use defaults
    const allowedIds = Array.isArray(payload.personalities)
      ? payload.personalities.map((p) => p.id).filter(Boolean)
      : Object.keys(baseline.score).length > 0 
        ? Object.keys(baseline.score)
        : ["A", "B", "C", "D"];

    // Build personality descriptions for the AI
    const personalityDescriptions = payload.personalities
      ? payload.personalities.map(p => `${p.id}: ${p.name}`).join(", ")
      : allowedIds.join(", ");

    const input = {
      quizId: payload.quizId || "generic-quiz",
      baseline,
      allowedIds,
      personalityDescriptions,
      questions: payload.questions.map((q) => ({
        id: q.id,
        type: q.type,
        selectedId: q.selectedId ?? null,
        order: q.order ?? null,
        value: q.value ?? null,
        text: q.text ?? null,
        delayMs: q.delayMs ?? null,
        hoverMsByOption: q.hoverMsByOption ?? null,
        hoverMsByCell: q.hoverMsByCell ?? null,
        durationMs: q.durationMs ?? null,
        swaps: q.swaps ?? null,
        reversals: q.reversals ?? null,
        changedMind: q.changedMind ?? false,
      })),
    };

    console.log("Calling OpenAI with model:", process.env.OPENAI_MODEL || "gpt-4o-mini");
    
    // Use correct OpenAI Chat Completions API
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: buildInstructions(payload) },
        { role: "user", content: JSON.stringify(input) }
      ],
      max_tokens: 300,
      temperature: 0.7,
    });

    console.log("OpenAI response received");
    
    const text = (completion.choices[0]?.message?.content || "").trim();
    console.log("OpenAI raw response:", text);
    
    const parsedJson = safeJsonParse(text);

    if (!parsedJson || !allowedIds.includes(parsedJson.personalityId)) {
      console.error("Invalid JSON or personality:", { parsedJson, allowedIds });
      throw new Error("AI JSON invalid or personality not in allowed list");
    }

    return res.json({
      ok: true,
      mode: "ai",
      personalityId: parsedJson.personalityId,
      narrative: parsedJson.narrative,
      callouts: parsedJson.callouts ?? [],
      signals: baseline.signals,
      baseline: { personalityId: baseline.personalityId },
    });
  } catch (err) {
    console.error("AI analysis failed:", err.message);
    console.error("Full error:", err);
    // Timeout/abort/parse errors → deterministic fallback
    return res.json({
      ok: true,
      mode: "fallback",
      personalityId: baseline.personalityId,
      signals: baseline.signals,
      callouts: buildCalloutsFromSignals(baseline.signals),
    });
  }
});

// Health check endpoint for the quiz service
quizRouter.get("/health", (req, res) => {
  res.json({ ok: true, service: "quiz-analyzer" });
});

function buildInstructions(payload) {
  const baseInstructions = [
    "You are a personality quiz analyst.",
    "Analyze the user's quiz responses and behavioral signals.",
    "Pick EXACTLY ONE personality id from the allowedIds list.",
    "Output STRICT JSON only (no markdown, no code blocks).",
    "JSON format: { \"personalityId\": \"X\", \"narrative\": \"...\", \"callouts\": [\"...\", \"...\"] }",
    "The narrative should be 1-2 sentences explaining the match.",
    "Callouts should be 2-4 short observations about their behavior (timing, hesitations, etc).",
  ];

  // Add quiz-specific instructions if available
  if (payload.quizId === "ai-personality-quiz") {
    baseInstructions.push(
      "This is a playful quiz for a kiosk experience.",
      "Make observations feel uncanny but not creepy.",
      "Phrase behavioral observations as 'attention', 'focus', 'deliberation' not 'tracking' or 'monitoring'."
    );
  }

  return baseInstructions.join("\n");
}

function safeJsonParse(s) {
  try {
    // Try to extract JSON if wrapped in markdown code blocks
    const jsonMatch = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]);
    }
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function buildCalloutsFromSignals(signals) {
  const out = [];

  if (signals.avgDelayMs) {
    if (signals.avgDelayMs < 1500) {
      out.push(`Quick decision-maker: ${signals.avgDelayMs}ms average response time`);
    } else if (signals.avgDelayMs > 4000) {
      out.push(`Thoughtful deliberator: ${(signals.avgDelayMs / 1000).toFixed(1)}s average response time`);
    }
  }
  
  if (signals.fastPicks > 1) {
    out.push(`${signals.fastPicks} rapid-fire decisions detected`);
  }
  
  if (signals.changesMind > 0) {
    out.push(`Changed mind ${signals.changesMind} time${signals.changesMind > 1 ? 's' : ''} — thorough evaluator`);
  }

  if (signals.hesitations?.length) {
    const h = signals.hesitations[0];
    if (h.hoveredOptionId !== h.chosenId) {
      out.push(`Considered "${h.hoveredOptionId}" before choosing "${h.chosenId}"`);
    }
  }

  if (signals.gazeHovers?.length) {
    const g = signals.gazeHovers[0];
    out.push(`Attention focused on ${g.hottestCellId} (${(g.hottestCellMs / 1000).toFixed(1)}s)`);
  }
  
  if (signals.orderingSwaps > 3) {
    out.push(`Carefully reordered priorities ${signals.orderingSwaps} times`);
  }
  
  if (signals.sliderReversals > 2) {
    out.push(`Fine-tuned slider responses ${signals.sliderReversals} times`);
  }

  return out.slice(0, 4);
}
