// Shared by the server actions and the client form wrapper. `saved` bumps on
// every successful save so the form remounts empty.
export type BdFormState = { error?: string; saved?: number };
