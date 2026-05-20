// Shared between client form and server action. Lives in its own file because
// "use server" modules may only export async functions - non-function exports
// from an actions file silently resolve to undefined on the client.
export const PROJECT_STATUS_OPTIONS = [
  "Planning",
  "Permitting",
  "Construction",
  "Commissioning",
  "Operational",
  "On Hold",
  "Cancelled",
] as const;

export type ProjectStatus = (typeof PROJECT_STATUS_OPTIONS)[number];
