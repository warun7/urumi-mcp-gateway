import { z } from 'zod';

const Env = z.object({
  PORT: z.coerce.number().int().default(8080),
  GATEWAY_MCP_URL: z.string().url().default('http://gateway:8080/mcp'),
  /** "openai" = any OpenAI-compatible Chat Completions API (OpenAI, Gemini, Groq, OpenRouter, Ollama, ...). */
  LLM_PROVIDER: z.enum(['openai', 'scripted']).default('scripted'),
  LLM_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  LLM_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default('gpt-4.1-mini'),
  LLM_TIMEOUT_MS: z.coerce.number().int().default(60_000),
  MAX_STEPS: z.coerce.number().int().min(1).max(20).default(8),
  /** Max characters of one tool result sent back to the model. */
  MAX_TOOL_RESULT_CHARS: z.coerce.number().int().default(8_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});
export type Config = z.infer<typeof Env>;
export const loadConfig = (): Config => Env.parse(process.env);
