/**
 * AI provider factory for FlowTracker.
 * Supports OpenAI, Mistral, Google Gemini, and Ollama (local).
 */

import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createMistral } from "@ai-sdk/mistral";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { getSetting } from "../api";

export type AIProvider = "openai" | "mistral" | "google" | "ollama" | "none";

export interface AIConfig {
  provider: AIProvider;
  apiKey: string;
  ollamaModel: string;
}

export async function loadAIConfig(): Promise<AIConfig> {
  const [provider, apiKey, ollamaModel] = await Promise.all([
    getSetting("ai_provider").catch(() => "none"),
    getSetting("ai_api_key").catch(() => ""),
    getSetting("ai_ollama_model").catch(() => "llama3.2"),
  ]);
  const config = {
    provider: (provider as AIProvider) || "none",
    apiKey: apiKey || "",
    ollamaModel: ollamaModel || "llama3.2",
  };
  console.log("[AI] config loaded:", { provider: config.provider, hasKey: !!config.apiKey, ollamaModel: config.ollamaModel });
  return config;
}

/** Returns true if Ollama is running locally. */
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Fetch available Ollama models from local server. */
export async function listOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models ?? []).map((m: { name: string }) => m.name);
  } catch {
    return [];
  }
}

/**
 * Call Ollama's native /api/generate endpoint with think:false.
 * This properly disables Qwen3's reasoning/thinking mode.
 */
async function callOllamaNative(model: string, prompt: string): Promise<string> {
  const res = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, think: false, stream: false }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  console.log("[AI] Ollama native response:", data);
  return (data.response ?? "").trim();
}

function getModel(config: AIConfig) {
  switch (config.provider) {
    case "openai": {
      const openai = createOpenAI({ apiKey: config.apiKey });
      return openai("gpt-4o-mini");
    }
    case "mistral": {
      const mistral = createMistral({ apiKey: config.apiKey });
      return mistral("mistral-small-latest");
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey: config.apiKey });
      return google("gemini-1.5-flash");
    }
    case "ollama":
      // Handled separately via callOllamaNative — not via AI SDK
      return "ollama" as const;
    default:
      return null;
  }
}

/**
 * Generates or rewrites a short task (work session) title.
 * When `draft` is supplied it is used as a hint — the AI improves/rewrites it.
 * Without a draft it infers a name from the app usages.
 * Returns null if AI is not configured or fails.
 */
export async function generateTaskName(
  appUsages: { app: string; duration_secs: number }[],
  draft?: string,
): Promise<string | null> {
  const config = await loadAIConfig();
  const model = getModel(config);
  if (!model) return null;

  const appList = appUsages
    .sort((a, b) => b.duration_secs - a.duration_secs)
    .slice(0, 5)
    .map(({ app, duration_secs }) => `${app} (${Math.round(duration_secs / 60)} min)`)
    .join(", ");

  const context = draft?.trim()
    ? `Apps used: ${appList}. User hint: "${draft.trim()}"`
    : `Apps used: ${appList}`;

  const instruction = draft?.trim()
    ? "Rewrite and improve the user's hint into a concise task title (3-6 words, no quotes, no punctuation at end)."
    : "Suggest a single short task title (3-6 words, no quotes, no punctuation at end) describing what the user was working on.";

  const prompt = `${instruction} /no_think
${context}
Reply with only the task title, nothing else.`;

  try {
    let text: string;
    if (model === "ollama") {
      text = await callOllamaNative(config.ollamaModel, prompt);
    } else {
      ({ text } = await generateText({ model, prompt, maxOutputTokens: 60 }));
    }
    const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    return clean.replace(/^["']|["']$/g, "") || null;
  } catch (err) {
    console.error("[AI] generateTaskName failed:", err);
    return null;
  }
}

/**
 * Generates or rewrites a short session description.
 * When `draft` is supplied (e.g. selected text) it is used as a hint/context
 * and the AI rewrites / improves it.  Without a draft it infers from the app
 * name and duration.
 * Returns null if AI is not configured or fails.
 */
export async function generateSessionDescription(
  appName: string,
  durationSecs: number,
  draft?: string,
): Promise<string | null> {
  const config = await loadAIConfig();
  const model = getModel(config);
  if (!model) return null;

  const durationMin = Math.round(durationSecs / 60);
  const context = draft?.trim()
    ? `App: ${appName} (${durationMin} min). User hint: "${draft.trim()}"`
    : `App: ${appName} (${durationMin} min)`;

  const instruction = draft?.trim()
    ? "Rewrite and improve the user's hint into a concise, professional task description (max 8 words, no quotes, no punctuation at end)."
    : "Suggest a concise, professional task description (max 8 words, no quotes, no punctuation at end) for this session.";

  const prompt = `${instruction} /no_think
${context}
Reply with only the description, nothing else.`;

  try {
    let text: string;
    if (model === "ollama") {
      text = await callOllamaNative(config.ollamaModel, prompt);
    } else {
      ({ text } = await generateText({ model, prompt, maxOutputTokens: 60 }));
    }
    const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    return clean.replace(/^["']|["']$/g, "") || null;
  } catch (err) {
    console.error("[AI] generateSessionDescription failed:", err);
    return null;
  }
}
