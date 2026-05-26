"use client";

import { useCallback, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { askQuestion, type ChatToolCall, type ChatTurn } from "./chat-actions";

type Message = {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  toolCalls?: ChatToolCall[];
  elapsedMs?: number;
};

type Props = {
  projectId: string;
};

const SUGGESTED_PROMPTS = [
  "What are the liquidated damages?",
  "What is the retainage?",
  "What's the substantial completion milestone date?",
  "Summarize Exhibit B (Contractor Scope of Work).",
];

export function ProjectChat({ projectId }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pending, startTransition] = useTransition();
  const scrollRef = useRef<HTMLDivElement>(null);

  const submit = useCallback(
    (question: string) => {
      const trimmed = question.trim();
      if (!trimmed) return;
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: trimmed,
      };
      setMessages((prev) => [...prev, userMsg]);
      setInput("");

      // Build history excluding errors and the message we're about to send.
      const history: ChatTurn[] = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      startTransition(async () => {
        const result = await askQuestion(projectId, trimmed, history);
        if (!result.ok) {
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "error", content: result.error },
          ]);
          return;
        }
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: result.answer,
            toolCalls: result.tool_calls,
            elapsedMs: result.elapsed_ms,
          },
        ]);
        // Scroll to bottom on next paint.
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
        });
      });
    },
    [messages, projectId],
  );

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Ask the documents</h2>
        <p className="text-xs text-muted-foreground">
          AI answers questions from this project&apos;s uploaded documents.
          Routed through the Mac Mini relay.
        </p>
      </div>

      <div
        ref={scrollRef}
        className="max-h-[500px] min-h-[120px] overflow-y-auto rounded-lg border bg-card p-4 shadow-sm"
      >
        {messages.length === 0 ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Try one of these or type your own question.
            </p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTED_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => submit(p)}
                  disabled={pending}
                  className="rounded-full border bg-background px-3 py-1 text-xs hover:bg-accent disabled:opacity-50"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ul className="space-y-4">
            {messages.map((m) => (
              <li key={m.id}>
                <ChatBubble message={m} />
              </li>
            ))}
            {pending && (
              <li>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                  Thinking...
                </div>
              </li>
            )}
          </ul>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
        className="flex gap-2"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about this project's documents..."
          disabled={pending}
          className={cn(
            "flex h-10 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm",
            "ring-offset-background placeholder:text-muted-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
        <Button type="submit" disabled={pending || !input.trim()}>
          {pending ? "Sending..." : "Send"}
        </Button>
      </form>
    </section>
  );
}

function ChatBubble({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">
          {message.content}
        </div>
      </div>
    );
  }
  if (message.role === "error") {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        {message.content}
      </div>
    );
  }
  // assistant
  return (
    <div className="space-y-2">
      <div className="rounded-lg bg-muted px-4 py-3 text-sm">
        <AssistantText text={message.content} />
      </div>
      {message.toolCalls && message.toolCalls.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">
            {message.toolCalls.length} tool call{message.toolCalls.length === 1 ? "" : "s"}
            {typeof message.elapsedMs === "number" && ` - ${(message.elapsedMs / 1000).toFixed(1)}s`}
          </summary>
          <ul className="mt-1 space-y-1 pl-4">
            {message.toolCalls.map((tc, i) => (
              <li key={i} className="font-mono">
                {tc.name.replace(/^mcp__docs__/, "")}(
                {tc.input ? JSON.stringify(tc.input).slice(0, 120) : ""}
                {tc.input && JSON.stringify(tc.input).length > 120 ? "..." : ""})
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function AssistantText({ text }: { text: string }) {
  // Minimal rendering. We're not pulling in a markdown lib yet; the LLM is
  // told to use plain prose + simple tables, so we preserve whitespace and
  // let the user read what's there. Upgrade to react-markdown later if needed.
  return <div className="whitespace-pre-wrap">{text}</div>;
}
