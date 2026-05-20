// Placeholder Database type — will be regenerated from the live Supabase schema
// via `npx supabase gen types typescript --project-id sksfyygufnnbzrmneccx --schema public`.
// This empty shape lets imports resolve so the build doesn't fail on Day 1.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
