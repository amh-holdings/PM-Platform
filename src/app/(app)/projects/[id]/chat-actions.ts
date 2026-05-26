"use server";

import { createClient } from "@/lib/supabase/server";

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

export type ChatToolCall = {
  name: string;
  input: unknown;
};

export type AskQuestionResult =
  | {
      ok: true;
      answer: string;
      tool_calls: ChatToolCall[];
      elapsed_ms: number;
    }
  | { ok: false; error: string };

export async function askQuestion(
  projectId: string,
  question: string,
  history: ChatTurn[],
): Promise<AskQuestionResult> {
  if (!question.trim()) {
    return { ok: false, error: "Question is empty" };
  }

  // Confirm the caller is authenticated AHC-team before forwarding to the
  // relay. The relay itself trusts the shared secret, so the access check
  // belongs here on the Vercel side.
  const supabase = createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return { ok: false, error: "Not signed in" };
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError || !profile) {
    return { ok: false, error: "Could not read your profile" };
  }
  if (!["phil", "zarina", "ahc_super"].includes(profile.role)) {
    return { ok: false, error: "Chat is restricted to AHC team members" };
  }

  // Get the project name for the system prompt context.
  const { data: project } = await supabase
    .from("projects")
    .select("name")
    .eq("id", projectId)
    .maybeSingle();

  const relayUrl = process.env.RELAY_URL;
  const relaySecret = process.env.RELAY_SHARED_SECRET;
  if (!relayUrl || !relaySecret) {
    return {
      ok: false,
      error:
        "Chat is not configured. RELAY_URL and RELAY_SHARED_SECRET must be set in Vercel env vars.",
    };
  }

  let response: Response;
  try {
    response = await fetch(`${relayUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${relaySecret}`,
      },
      body: JSON.stringify({
        project_id: projectId,
        project_name: project?.name ?? null,
        question: question.trim(),
        history,
      }),
      // Allow long agent loops to complete. Vercel function timeouts will
      // ultimately cap this; configure those separately if needed.
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    return { ok: false, error: `Could not reach the relay: ${msg}` };
  }

  if (!response.ok) {
    let errText = `Relay returned ${response.status}`;
    try {
      const data = await response.json();
      if (data?.error) errText = data.error;
    } catch {
      // ignore
    }
    return { ok: false, error: errText };
  }

  type RelayResponse = {
    answer: string;
    tool_calls: ChatToolCall[];
    elapsed_ms: number;
  };
  const data = (await response.json()) as RelayResponse;
  return {
    ok: true,
    answer: data.answer,
    tool_calls: data.tool_calls ?? [],
    elapsed_ms: data.elapsed_ms ?? 0,
  };
}
