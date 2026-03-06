import OpenAI from "openai";

// Simple OpenAI client - use OpenAI's built-in timeout
export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: Number(process.env.OPENAI_TIMEOUT_MS || 30000), // 30 seconds default
});
