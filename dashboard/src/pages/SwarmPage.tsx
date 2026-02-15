import { SwarmDashboard } from "../components/SwarmDashboard";
import type { SwarmMetricsData } from "../lib/api";
import type { SwarmStatus } from "../types";

interface SwarmPageProps {
  swarm?: SwarmStatus;
  metrics?: SwarmMetricsData | null;
}

export function SwarmPage({ swarm, metrics }: SwarmPageProps) {
  return (
    <div className="col-span-4 md:col-span-8 lg:col-span-12">
      <SwarmDashboard swarm={swarm} metrics={metrics} />
    </div>
  );
}
