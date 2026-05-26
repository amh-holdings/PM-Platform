// MCP tools the Claude Agent SDK can call.
// All tools query Supabase directly using the service-role key so they bypass
// RLS - the relay is trusted because access is gated by RELAY_SHARED_SECRET on
// the way in. Tools always scope queries by project_id passed in args.

import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";

const TOOL_MAX_CHARS = 180000; // hard cap on text returned per read_document call

function textResult(text) {
  return {
    content: [{ type: "text", text }],
  };
}

export function buildTools(supabase) {
  return [
    tool(
      "list_documents",
      "List all documents available for a project. Returns id, file_name, category, pages_count, and size_bytes for each. Does NOT return the document text. Call read_document to get content.",
      {
        project_id: z.string().describe("UUID of the project to list documents for"),
        category: z
          .enum([
            "prime_contract",
            "amendment",
            "exhibit",
            "subcontract",
            "drawing",
            "spec",
            "submittal",
            "rfi",
            "daily_log",
            "email",
            "other",
          ])
          .optional()
          .describe("Optional: filter to a single category"),
      },
      async ({ project_id, category }) => {
        let q = supabase
          .from("project_documents")
          .select("id, file_name, category, pages_count, size_bytes, text_status")
          .eq("project_id", project_id)
          .order("category")
          .order("file_name");
        if (category) q = q.eq("category", category);
        const { data, error } = await q;
        if (error) return textResult(`Error: ${error.message}`);
        if (!data || data.length === 0) return textResult("No documents found.");
        const lines = [`Found ${data.length} document(s):`];
        for (const d of data) {
          const sizeKB = d.size_bytes ? Math.round(d.size_bytes / 1024) : "?";
          lines.push(
            `- id=${d.id}  category=${d.category}  pages=${d.pages_count ?? "?"}  size=${sizeKB}KB  text=${d.text_status}  name="${d.file_name}"`,
          );
        }
        return textResult(lines.join("\n"));
      },
    ),

    tool(
      "read_document",
      "Read the full extracted text of a single document by its UUID. Returns the text content the document parser/OCR extracted. May be truncated to 180000 characters for very large documents - if so, use search_documents with specific keywords for the missing parts.",
      {
        document_id: z.string().describe("UUID of the document"),
      },
      async ({ document_id }) => {
        const { data, error } = await supabase
          .from("project_documents")
          .select("file_name, category, pages_count, extracted_text, text_status, text_error")
          .eq("id", document_id)
          .maybeSingle();
        if (error) return textResult(`Error: ${error.message}`);
        if (!data) return textResult(`Document ${document_id} not found.`);
        if (data.text_status !== "ready") {
          return textResult(
            `Document "${data.file_name}" has text_status=${data.text_status}` +
              (data.text_error ? ` (${data.text_error})` : "") +
              `. No text available.`,
          );
        }
        const text = data.extracted_text || "";
        const header = `=== Document: ${data.file_name} (category: ${data.category}, pages: ${data.pages_count ?? "?"}) ===\n\n`;
        if (text.length > TOOL_MAX_CHARS) {
          return textResult(
            header +
              text.slice(0, TOOL_MAX_CHARS) +
              `\n\n[... truncated. Original length: ${text.length} chars. Use search_documents for specific content beyond this point.]`,
          );
        }
        return textResult(header + text);
      },
    ),

    tool(
      "search_documents",
      "Case-insensitive substring search across all extracted document text in a project. Returns matching documents with up to 5 context snippets per document showing where the query matched. Use this for keyword lookups across many documents at once.",
      {
        project_id: z.string().describe("UUID of the project"),
        query: z
          .string()
          .min(2)
          .describe("Search string (case-insensitive). Use a distinctive keyword or phrase."),
      },
      async ({ project_id, query }) => {
        const { data, error } = await supabase
          .from("project_documents")
          .select("id, file_name, category, extracted_text")
          .eq("project_id", project_id)
          .eq("text_status", "ready")
          .ilike("extracted_text", `%${query}%`);
        if (error) return textResult(`Error: ${error.message}`);
        if (!data || data.length === 0) {
          return textResult(`No matches found for "${query}".`);
        }
        const lines = [`Found ${data.length} document(s) matching "${query}":`];
        for (const doc of data) {
          const text = doc.extracted_text || "";
          const lower = text.toLowerCase();
          const needle = query.toLowerCase();
          const snippets = [];
          let pos = 0;
          while (snippets.length < 5) {
            const idx = lower.indexOf(needle, pos);
            if (idx === -1) break;
            const start = Math.max(0, idx - 150);
            const end = Math.min(text.length, idx + needle.length + 200);
            const snip = text
              .slice(start, end)
              .replace(/\s+/g, " ")
              .trim();
            snippets.push(snip);
            pos = idx + needle.length;
          }
          lines.push(`\n--- ${doc.file_name} (id=${doc.id}, category=${doc.category}) ---`);
          for (const s of snippets) lines.push(`  ... ${s} ...`);
        }
        return textResult(lines.join("\n"));
      },
    ),
  ];
}
