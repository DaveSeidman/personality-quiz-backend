import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import os from 'os'
import process from 'process'
import OpenAI from 'openai'

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json({ limit: '5mb' }))

const serverStartedAt = Date.now()
let totalSessionsSinceBoot = 0
let totalSessionsSinceLastReset = 0
let lastResetAt = serverStartedAt

function logInfo(message, meta = {}) {
  console.log(`[quiz-backend] ${message}`, Object.keys(meta).length ? meta : '')
}

function logError(message, error, meta = {}) {
  console.error(`[quiz-backend] ${message}`, {
    ...(Object.keys(meta).length ? meta : {}),
    error: error?.message || String(error),
  })
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: Number(process.env.OPENAI_TIMEOUT_MS || 30000),
})

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value))

function normalizeQuestionType(type = '') {
  if (type === 'multiple-choice-text' || type === 'multiple-choice-image') return 'multiple_choice'
  if (type === 'slide-select' || type === 'SlideSelect') return 'slide_to_select'
  if (type === 'ranked-choice') return 'ordering'
  if (type === 'range-sliders') return 'range'
  return type
}

function isObj(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getOptionById(question, optionId) {
  return (question?.answers ?? []).find(option => option.id === optionId)
}

function addScore(bucket, personalityId, rawPoints, confidenceWeight, source) {
  if (!personalityId || !bucket[personalityId]) return

  const weightedPoints = rawPoints * confidenceWeight
  bucket[personalityId].raw += rawPoints
  bucket[personalityId].weighted += weightedPoints
  bucket[personalityId].contributions.push({ ...source, rawPoints, weightedPoints, confidenceWeight })
}

function summarizeEvents(events = []) {
  const counts = {}
  for (const event of events) {
    counts[event.type] = (counts[event.type] || 0) + 1
  }

  return {
    total: events.length,
    byType: counts,
  }
}

function validatePayload(payload) {
  if (!isObj(payload)) return 'Payload must be an object'
  if (!Array.isArray(payload.questions) || payload.questions.length === 0) return 'questions[] required'
  if (!isObj(payload.answers)) return 'answers object required'
  if (!isObj(payload.analytics)) return 'analytics object required'
  if (!Array.isArray(payload.personalities) || payload.personalities.length < 2) return 'personalities[] required'
  return null
}

function computeScores(payload) {
  const personalities = payload.personalities
  const personalityMap = Object.fromEntries(
    personalities.map((personality) => [personality.id, {
      id: personality.id,
      name: personality.name,
      raw: 0,
      weighted: 0,
      contributions: [],
    }])
  )

  const perQuestion = []

  for (const question of payload.questions) {
    const questionId = String(question.id)
    const normalizedType = normalizeQuestionType(question.type)
    const answer = payload.answers[questionId]
    const analyticsEntry = payload.analytics[questionId] ?? { confidence: 0.5, data: { events: [] } }
    const confidenceWeight = clamp(typeof analyticsEntry.confidence === 'number' ? analyticsEntry.confidence : 0.5)

    const questionSummary = {
      questionId,
      type: normalizedType,
      confidence: confidenceWeight,
      eventSummary: summarizeEvents(analyticsEntry?.data?.events ?? []),
    }

    if (normalizedType === 'multiple_choice' || normalizedType === 'slide_to_select') {
      const selectedIds = Array.isArray(answer) ? answer : (answer ? [answer] : [])
      const perSelection = selectedIds.length > 0 ? 1 / selectedIds.length : 0

      selectedIds.forEach((optionId) => {
        const option = getOptionById(question, optionId)
        addScore(
          personalityMap,
          option?.personalityId,
          perSelection,
          confidenceWeight,
          { questionId, type: normalizedType, optionId }
        )
      })

      questionSummary.selectedIds = selectedIds
    }

    if (normalizedType === 'ordering' && Array.isArray(answer) && answer.length > 0) {
      answer.forEach((optionId, index) => {
        const option = getOptionById(question, optionId)
        const rankWeight = (answer.length - index) / answer.length

        addScore(
          personalityMap,
          option?.personalityId,
          rankWeight,
          confidenceWeight,
          { questionId, type: normalizedType, optionId, rank: index + 1 }
        )
      })

      questionSummary.order = answer
    }

    if (normalizedType === 'range' && isObj(answer)) {
      Object.entries(answer).forEach(([optionId, value]) => {
        const option = getOptionById(question, optionId)
        const normalizedValue = clamp((Number(value) + 1) / 2)

        addScore(
          personalityMap,
          option?.personalityId,
          normalizedValue,
          confidenceWeight,
          { questionId, type: normalizedType, optionId, value: Number(value) }
        )
      })

      questionSummary.values = answer
    }

    perQuestion.push(questionSummary)
  }

  const scores = Object.values(personalityMap)
  const totalWeighted = scores.reduce((sum, score) => sum + score.weighted, 0)

  const normalized = scores
    .map((score) => ({
      ...score,
      normalized: totalWeighted > 0 ? score.weighted / totalWeighted : 0,
    }))
    .sort((a, b) => b.weighted - a.weighted)

  const top = normalized[0]
  const second = normalized[1]
  const margin = top && second ? top.normalized - second.normalized : 0
  const aggregateConfidence = clamp(0.45 + margin * 1.2)

  return {
    perQuestion,
    scores: normalized,
    winner: top,
    confidence: aggregateConfidence,
  }
}

function safeJsonParse(text) {
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    return JSON.parse(fenced ? fenced[1] : text)
  } catch {
    return null
  }
}

function buildLocalStatement(personality, confidence) {
  if (!personality) return 'You showed a mixed style; a balanced sparkling water feels like the safest fit.'

  const pct = Math.round((confidence || 0) * 100)
  const drink = personality.drinkRecommendation || 'sparkling water with citrus'
  return `You read as a ${personality.name} (${pct}% confidence): steady patterns suggest this is how you naturally self-regulate, so your drink match is ${drink}.`
}

function buildSystemPrompt(personalities) {
  const personalitiesText = personalities
    .map((personality) => `- ${personality.id}: ${personality.name} (${personality.description || 'no description'}), drink: ${personality.drinkRecommendation || 'none provided'}`)
    .join('\n')

  return `You are a personality analysis specialist for a behavioral quiz.

You are given a JSON payload containing:
- quiz metadata
- question definitions (including answer->personality mapping)
- final user answers
- per-question analytics with confidence and event timelines
- local confidence-weight settings

Your tasks:
1) Determine the best-fit personalityId from the available set.
2) Infer a couple of plausible personal tendencies from behavior and choices (without overclaiming).
3) Recommend a drink that matches the selected personality profile.
4) Return ONE concise, personal statement that includes both the personality insight and the drink recommendation.
5) Stay grounded in the provided payload only. Do not invent missing facts.

Available personality types:
${personalitiesText}

Return STRICT JSON only with this shape:
{
  "personalityId": "<one valid id>",
  "confidence": 0.0,
  "statement": "One concise sentence personalized to this user, including a drink recommendation."
}`
}

async function analyzeWithOpenAI(payload, localResult) {
  if (!process.env.OPENAI_API_KEY) return null

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'

  const promptPayload = {
    quizId: payload.quizId,
    personalities: payload.personalities,
    questions: payload.questions,
    answers: payload.answers,
    analytics: payload.analytics,
    confidenceWeights: payload.confidenceWeights,
    localScoring: {
      winner: localResult.winner,
      confidence: localResult.confidence,
      ranking: localResult.scores.map((score) => ({
        id: score.id,
        name: score.name,
        normalized: score.normalized,
        weighted: score.weighted,
      })),
      perQuestion: localResult.perQuestion,
    },
  }

  const completion = await openai.chat.completions.create({
    model,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt(payload.personalities),
      },
      {
        role: 'user',
        content: JSON.stringify(promptPayload),
      },
    ],
  })

  const text = completion.choices?.[0]?.message?.content || '{}'
  logInfo('OpenAI raw response snippet', { snippet: text.slice(0, 240) })

  const parsed = safeJsonParse(text)
  if (!parsed) {
    logInfo('OpenAI JSON parse failed')
    return null
  }

  const validIds = new Set(payload.personalities.map((p) => p.id))
  if (!validIds.has(parsed.personalityId)) return null

  const selectedPersonality = payload.personalities.find((p) => p.id === parsed.personalityId)
  const statement = typeof parsed.statement === 'string' && parsed.statement.trim().length > 0
    ? parsed.statement.trim()
    : buildLocalStatement(selectedPersonality, clamp(Number(parsed.confidence) || localResult.confidence))

  logInfo('OpenAI parsed payload', {
    personalityId: parsed.personalityId,
    hasStatement: Boolean(statement),
  })

  return {
    personalityId: parsed.personalityId,
    confidence: clamp(Number(parsed.confidence) || localResult.confidence),
    statement,
    model,
  }
}

app.post('/api/analyze', async (req, res) => {
  const startedAt = Date.now()
  logInfo('Analyze request received', {
    quizId: req.body?.quizId,
    questions: Array.isArray(req.body?.questions) ? req.body.questions.length : 0,
    personalities: Array.isArray(req.body?.personalities) ? req.body.personalities.length : 0,
  })

  const error = validatePayload(req.body)
  if (error) {
    logInfo('Analyze request rejected by validation', { error })
    return res.status(400).json({ ok: false, error })
  }

  totalSessionsSinceBoot += 1
  totalSessionsSinceLastReset += 1

  const localResult = computeScores(req.body)
  logInfo('Local scoring complete', {
    winner: localResult.winner?.id,
    confidence: localResult.confidence,
  })

  let aiResult = null
  let mode = 'local'

  try {
    aiResult = await analyzeWithOpenAI(req.body, localResult)
    if (aiResult) {
      mode = 'openai'
      logInfo('OpenAI analysis complete', {
        model: aiResult.model,
        personalityId: aiResult.personalityId,
        confidence: aiResult.confidence,
      })
    } else {
      logInfo('OpenAI unavailable or invalid response, using local mode')
    }
  } catch (openaiError) {
    logError('OpenAI analysis failed, falling back to local', openaiError)
  }

  const selectedPersonalityId = aiResult?.personalityId || localResult.winner?.id
  const selectedPersonality = req.body.personalities.find((p) => p.id === selectedPersonalityId)

  const responseBody = {
    ok: true,
    mode,
    quizId: req.body.quizId,
    result: {
      personalityId: selectedPersonalityId,
      personalityName: selectedPersonality?.name || localResult.winner?.name,
      confidence: aiResult?.confidence ?? localResult.confidence,
      statement: aiResult?.statement || buildLocalStatement(selectedPersonality, aiResult?.confidence ?? localResult.confidence),
      drinkRecommendation: selectedPersonality?.drinkRecommendation || null,
      ranking: localResult.scores.map((score) => ({
        id: score.id,
        name: score.name,
        normalized: score.normalized,
        weighted: score.weighted,
      })),
      model: aiResult?.model || null,
    },
    analysis: {
      perQuestion: localResult.perQuestion,
      scoringWeights: req.body.confidenceWeights || null,
      submittedAt: req.body.submittedAt || Date.now(),
    },
  }

  logInfo('Analyze request complete', {
    mode,
    personalityId: responseBody.result.personalityId,
    durationMs: Date.now() - startedAt,
  })

  return res.json(responseBody)
})

app.get('/', (_req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - serverStartedAt) / 1000)
  res.json({
    ok: true,
    service: 'personality-quiz-backend',
    environment: process.env.NODE_ENV || 'development',
    uptimeSeconds,
    uptimeHuman: `${Math.floor(uptimeSeconds / 60)}m ${uptimeSeconds % 60}s`,
    totalSessionsSinceBoot,
    totalSessionsSinceLastReset,
    lastResetAt: new Date(lastResetAt).toISOString(),
    hostname: os.hostname(),
    timestamp: new Date().toISOString(),
  })
})

const PORT = Number(process.env.PORT || 3001)
app.listen(PORT, () => {
  logInfo(`Server listening on http://localhost:${PORT}`, {
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  })
})
