import StaffForgotPassword from "./StaffForgotPassword";
import StaffResetPassword from "./StaffResetPassword";

// Lightweight dispatcher for the two public, unauthenticated staff
// password-reset pages. Mounted by main.tsx before the full <App/> so we
// never spin up the heavy staff shell / auth fetch for these pages.
//   /forgot-password            → request a reset link
//   /reset-password/<token>     → choose a new password
export default function StaffResetApp() {
  const path = window.location.pathname;
  const resetMatch = path.match(/\/reset-password\/([^/?#]+)/);
  if (resetMatch) {
    return <StaffResetPassword token={decodeURIComponent(resetMatch[1])} />;
  }
  return <StaffForgotPassword />;
}
