import type { ReactNode } from "react";

interface OverviewPageProps {
  children: ReactNode;
}

export function OverviewPage({ children }: OverviewPageProps) {
  return <>{children}</>;
}
