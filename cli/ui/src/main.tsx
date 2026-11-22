import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { SessionEnded, startSession } from "./lib/rpc.ts";

const client = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (failures, error) => !(error instanceof SessionEnded) && failures < 2,
    },
  },
});

async function boot(): Promise<void> {
  try {
    await startSession();
  } catch {
    // A failed exchange shows as the session gate on the first call.
  }
  const root = document.getElementById("root");
  if (root === null) return;
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <TooltipProvider delayDuration={400}>
          <App />
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void boot();
