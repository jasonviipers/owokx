import { SwarmDashboard } from "../components/SwarmDashboard";
import type { SwarmStatus } from "../types";

interface SwarmPageProps {
  swarm?: SwarmStatus;
}

export function SwarmPage({ swarm }: SwarmPageProps) {
  return (
    <div className="col-span-4 md:col-span-8 lg:col-span-12">
      <SwarmDashboard swarm={swarm} />
    </div>
  );
}
