import React from "react";
import TwoFactorSettings from "./TwoFactorSettings";
import { isMfaEnrollmentBlocked } from "../lib/authToken";

// App-wide error boundary. Its primary job is the MFA enrollment case: a
// required-but-unenrolled user's data loads all 403, and if a view crashes
// rendering an error body before the enrollment wall takes over, React would
// otherwise tear the whole tree down to a white screen. When that happens
// while the sticky "blocked" flag is set, we render the forced enrollment
// screen so the user can still set up two-factor (then reload into the app).
//
// It also serves as a general safety net: any other render crash shows a
// recoverable "reload" message instead of a blank page (the app previously had
// no error boundary at all).

type Props = { children: React.ReactNode };
type State = { crashed: boolean };

const centered: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  color: "#334155",
  fontFamily: "system-ui, sans-serif",
  padding: 24,
  textAlign: "center",
};

export default class MfaEnrollmentBoundary extends React.Component<Props, State> {
  state: State = { crashed: false };

  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  componentDidCatch(error: unknown): void {
    // Keep the detail in the console for debugging; the UI stays clean.
    console.error("App render error caught by boundary:", error);
  }

  render(): React.ReactNode {
    if (!this.state.crashed) return this.props.children;

    if (isMfaEnrollmentBlocked()) {
      return (
        <TwoFactorSettings forced onClose={() => window.location.reload()} />
      );
    }

    return (
      <div style={centered}>
        <p style={{ margin: 0, fontSize: 15 }}>Something went wrong.</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            border: "none",
            background: "#2563eb",
            color: "#fff",
            borderRadius: 6,
            padding: "8px 16px",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
