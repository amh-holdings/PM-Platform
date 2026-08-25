"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { PoOption } from "../billing-po-link-form";

export type TaskOption = {
  wbsCode: string;
  taskName: string;
  status: string | null;
  pctComplete: number | null;
  isSummary: boolean;
};

type Catalog = {
  tasks: TaskOption[];
  pos: PoOption[];
};

const LinkCatalogContext = createContext<Catalog>({ tasks: [], pos: [] });

// The schedule can run to several hundred tasks and the billing SOV to several
// dozen lines. Passing the task list as a prop to every row would serialize it
// once per row; a context provider sends it down the wire exactly once.
export function LinkCatalogProvider({
  tasks,
  pos,
  children,
}: Catalog & { children: ReactNode }) {
  return (
    <LinkCatalogContext.Provider value={{ tasks, pos }}>
      {children}
    </LinkCatalogContext.Provider>
  );
}

export function useLinkCatalog(): Catalog {
  return useContext(LinkCatalogContext);
}
