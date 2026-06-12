import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Free-form label so the error message can identify which chart blew up. */
  label?: string;
}

interface State {
  hasError: boolean;
  message: string;
}

/**
 * Catches render-time errors below the boundary so a chart crash doesn't
 * blank the whole page. Shows a brief diagnostic and a retry hint instead.
 */
export class ChartErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(err: unknown): State {
    return {
      hasError: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  componentDidCatch(err: unknown, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[ChartErrorBoundary${this.props.label ? `: ${this.props.label}` : ""}]`, err, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="dash-card"
          style={{ borderColor: "rgba(180,40,40,0.25)", background: "rgba(180,40,40,0.04)" }}
        >
          <div className="group-label" style={{ color: "#b42828" }}>
            Chart render error{this.props.label ? `: ${this.props.label}` : ""}
          </div>
          <div className="form-helper">
            {this.state.message}
          </div>
          <div className="form-helper" style={{ marginTop: 4 }}>
            Try changing a control (tenor, parameter) to retry the render. Open the browser dev console
            (F12) for the full stack trace.
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
