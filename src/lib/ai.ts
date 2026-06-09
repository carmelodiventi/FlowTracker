/**
 * AI provider factory for FlowTracker.
 * Supports OpenAI, Mistral, Google Gemini, Ollama, and LM Studio (local).
 */

import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createMistral } from "@ai-sdk/mistral";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { getSetting } from "../api";
import { error } from "@tauri-apps/plugin-log";

export type AIProvider =
  | "openai"
  | "mistral"
  | "google"
  | "ollama"
  | "lmstudio"
  | "none";

export interface AIConfig {
  provider: AIProvider;
  apiKey: string;
  ollamaModel: string;
  ollamaBaseUrl: string;
  lmstudioModel: string;
  lmstudioBaseUrl: string;
}

export async function loadAIConfig(): Promise<AIConfig> {
  const [
    provider,
    apiKey,
    ollamaModel,
    ollamaBaseUrl,
    lmstudioModel,
    lmstudioBaseUrl,
  ] = await Promise.all([
    getSetting("ai_provider").catch(() => "none"),
    getSetting("ai_api_key").catch(() => ""),
    getSetting("ai_ollama_model").catch(() => "llama3.2"),
    getSetting("ai_ollama_base_url").catch(() => "http://127.0.0.1:11434"),
    getSetting("ai_lmstudio_model").catch(() => "google/gemma-4-e4b"),
    getSetting("ai_lmstudio_base_url").catch(() => "http://127.0.0.1:1234"),
  ]);
  const config = {
    provider: (provider as AIProvider) || "none",
    apiKey: apiKey || "",
    ollamaModel: ollamaModel || "llama3.2",
    ollamaBaseUrl: ollamaBaseUrl || "http://127.0.0.1:11434",
    lmstudioModel: lmstudioModel || "google/gemma-4-e4b",
    lmstudioBaseUrl: lmstudioBaseUrl || "http://127.0.0.1:1234",
  };
  console.log("[AI] config loaded:", {
    provider: config.provider,
    hasKey: !!config.apiKey,
    ollamaModel: config.ollamaModel,
    ollamaBaseUrl: config.ollamaBaseUrl,
    lmstudioModel: config.lmstudioModel,
    lmstudioBaseUrl: config.lmstudioBaseUrl,
  });
  return config;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

/** Returns true if a local LLM server is reachable. */
export async function isLocalLLMAvailable(
  provider: "ollama" | "lmstudio",
  baseUrl: string,
): Promise<boolean> {
  const root =
    normalizeBaseUrl(baseUrl) ||
    (provider === "ollama"
      ? "http://127.0.0.1:11434"
      : "http://127.0.0.1:1234");
  const paths = provider === "ollama" ? ["/api/tags"] : ["/v1/models"];

  for (const path of paths) {
    try {
      const res = await fetch(new URL(path, root).toString(), {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });
      if (res.status === 200) return true;
    } catch (e) {
      error((e as unknown as Error).message);
    }
  }

  return false;
}

/** Fetch available models from a local LLM server (Ollama or LM Studio). */
export async function listLocalModels(
  provider: "ollama" | "lmstudio",
  baseUrl: string,
): Promise<string[]> {
  const root =
    normalizeBaseUrl(baseUrl) ||
    (provider === "ollama"
      ? "http://127.0.0.1:11434"
      : "http://127.0.0.1:1234");

  if (provider === "ollama") {
    try {
      const res = await fetch(new URL("/api/tags", root).toString(), {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.models ?? []).map((m: { name: string }) => m.name);
    } catch {
      return [];
    }
  }

  // LM Studio: try /api/v1/models first, fall back to /v1/models (OpenAI-compat)
  for (const path of ["/api/v1/models", "/v1/models"]) {
    try {
      const res = await fetch(new URL(path, root).toString(), {
        signal: AbortSignal.timeout(3000),
      });

      if (!res.ok) continue;
      const data = await res.json();
      const items: string[] = (data.data ?? data.models ?? [])
        .map((m: { id?: string; name?: string }) => m.name ?? m.id ?? "")
        .filter(Boolean);
      if (items.length > 0) return items;
    } catch (e) {
      error((e as unknown as Error).message);
    }
  }
  return [];
}

/**
 * Call local LLM server (Ollama or LM Studio) through one shared code path.
 */
async function callLocalLLM(
  provider: "ollama" | "lmstudio",
  baseUrl: string,
  model: string,
  prompt: string,
): Promise<string> {
  const root =
    normalizeBaseUrl(baseUrl) ||
    (provider === "ollama"
      ? "http://127.0.0.1:11434"
      : "http://127.0.0.1:1234");
  if (provider === "ollama") {
    const endpoint = new URL("/api/generate", root).toString();
    const res = await fetch(endpoint, {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify({ model, prompt, think: false, stream: false }),
    });
    if (!res.ok)
      throw new Error(`Local LLM HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    console.log("[AI] Local LLM response:", { provider, endpoint, data });
    return String(data.response ?? "").trim();
  }

  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    stream: false,
  };

  for (const path of ["/v1/chat/completions", "/api/v1/chat/completions"]) {
    const endpoint = new URL(path, root).toString();
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      });
      if (!res.ok) continue;
      const data = await res.json();
      console.log("[AI] Local LLM response:", { provider, endpoint, data });
      const response =
        data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? "";
      if (String(response).trim()) return String(response).trim();
    } catch (e) {
      error((e as unknown as Error).message);
    }
  }

  throw new Error("LM Studio did not return a valid chat completion response");
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

  const appList = appUsages
    .sort((a, b) => b.duration_secs - a.duration_secs)
    .slice(0, 5)
    .map(
      ({ app, duration_secs }) =>
        `${app} (${Math.round(duration_secs / 60)} min)`,
    )
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
    if (config.provider === "openai") {
      const openai = createOpenAI({ apiKey: config.apiKey });
      ({ text } = await generateText({
        model: openai("gpt-4o-mini"),
        prompt,
        maxOutputTokens: 60,
      }));
    } else if (config.provider === "mistral") {
      const mistral = createMistral({ apiKey: config.apiKey });
      ({ text } = await generateText({
        model: mistral("mistral-small-latest"),
        prompt,
        maxOutputTokens: 60,
      }));
    } else if (config.provider === "google") {
      const google = createGoogleGenerativeAI({ apiKey: config.apiKey });
      ({ text } = await generateText({
        model: google("gemini-1.5-flash"),
        prompt,
        maxOutputTokens: 60,
      }));
    } else if (config.provider === "ollama") {
      text = await callLocalLLM(
        "ollama",
        config.ollamaBaseUrl,
        config.ollamaModel,
        prompt,
      );
    } else if (config.provider === "lmstudio") {
      text = await callLocalLLM(
        "lmstudio",
        config.lmstudioBaseUrl,
        config.lmstudioModel,
        prompt,
      );
    } else {
      return null;
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
    if (config.provider === "openai") {
      const openai = createOpenAI({ apiKey: config.apiKey });
      ({ text } = await generateText({
        model: openai("gpt-4o-mini"),
        prompt,
        maxOutputTokens: 60,
      }));
    } else if (config.provider === "mistral") {
      const mistral = createMistral({ apiKey: config.apiKey });
      ({ text } = await generateText({
        model: mistral("mistral-small-latest"),
        prompt,
        maxOutputTokens: 60,
      }));
    } else if (config.provider === "google") {
      const google = createGoogleGenerativeAI({ apiKey: config.apiKey });
      ({ text } = await generateText({
        model: google("gemini-1.5-flash"),
        prompt,
        maxOutputTokens: 60,
      }));
    } else if (config.provider === "ollama") {
      text = await callLocalLLM(
        "ollama",
        config.ollamaBaseUrl,
        config.ollamaModel,
        prompt,
      );
    } else if (config.provider === "lmstudio") {
      text = await callLocalLLM(
        "lmstudio",
        config.lmstudioBaseUrl,
        config.lmstudioModel,
        prompt,
      );
    } else {
      return null;
    }
    const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    return clean.replace(/^["']|["']$/g, "") || null;
  } catch (err) {
    console.error("[AI] generateSessionDescription failed:", err);
    return null;
  }
}
