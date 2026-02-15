import { Component, type ReactNode } from "react";
import { Panel } from "./Panel";

interface ErrorBoundaryProps {
  children: ReactNode;
  title?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    // Keep the app responsive while surfacing the failing panel.
    console.error("Dashboard panel render failed", error);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <Panel title={this.props.title ?? "PANEL ERROR"} className="h-full">
          <div className="text-sm text-hud-error">
            This panel failed to render. Reload the page if the issue persists.
          </div>
        </Panel>
      );
    }

    return this.props.children;
  }
}
